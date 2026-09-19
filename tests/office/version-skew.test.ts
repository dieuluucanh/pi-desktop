/**
 * Version-skew matrix for the Office bridge.
 *
 * The bridge ships independently of this app, so two generations must render
 * from the same code: bridge 0.4.x (protocol v2 — the handshake it already
 * speaks, finals only) and bridge 0.5.0 (protocol v3 — streamed deltas and a
 * pane-side Stop). Pi Desktop must never assume either.
 *
 * The fake pane below emits exactly the frames a bridge of a given generation
 * sends, so the app-side behaviour is pinned without a bridge process. (The
 * pi-for-office side of the same matrix — a v2 add-in still connecting to a v3
 * bridge, and a v1 handshake being rejected — is covered by that repo's
 * `bridge-extension/tests/multi-document.test.mjs` and `smoke.mjs` suites.)
 */

import { describe, expect, it, vi } from "vitest";
import {
  bridgeReplyLabel,
  bridgeStopLabel,
  projectBridgeCompatibility,
} from "../../src/shared/office-bridge";
import {
  createOfficeRunTracker,
  type OfficeRunEvent,
  type OfficeRunTracker,
} from "../../src/main/office/office-run";

/** The `/health` payloads each published bridge generation reports. */
const HEALTH = {
  v2: {
    protocolVersion: 2,
    capabilities: null,
    serverVersion: "0.4.1",
    catalogVersion: 3,
  },
  v3: {
    protocolVersion: 3,
    capabilities: ["http-health", "agent-deltas", "client-abort"],
    serverVersion: "0.5.0",
    catalogVersion: 3,
  },
} as const;

const userMessage = (text: string): OfficeRunEvent => ({
  event: "message_start",
  payload: { message: { role: "user", content: [{ type: "text", text }] } },
});

const finalMessage = (text: string): OfficeRunEvent => ({
  event: "message_end",
  payload: { message: { role: "assistant", content: [{ type: "text", text }] } },
});

interface FakePane {
  tracker: OfficeRunTracker;
  abort: ReturnType<typeof vi.fn>;
  ask(text: string): void;
  /** A delta, if this generation sends them at all. */
  stream(chunk: string): void;
  finish(text: string): void;
}

/**
 * A fake task pane speaking one bridge generation. A v2 pane types a prompt and
 * receives only the final reply; a v3 pane receives deltas as well.
 */
function createFakePane(generation: 2 | 3): FakePane {
  let listener: ((event: OfficeRunEvent) => void) | null = null;
  const abort = vi.fn(async () => undefined);
  const tracker = createOfficeRunTracker({
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
    abort: () => abort(),
    now: () => 1_000,
  });
  const emit = (event: OfficeRunEvent): void => listener?.(event);

  return {
    tracker,
    abort,
    ask: (text) => emit(userMessage(text)),
    stream: (chunk) => {
      // The v2 protocol has the delta message type but this bridge never sends
      // one, so neither should the fake: the app must cope with its absence.
      if (generation < 3) return;
      emit({
        event: "message_update",
        payload: { assistantMessageEvent: { type: "text_delta", delta: chunk } },
      });
    },
    finish: (text) => {
      emit(finalMessage(text));
      emit({ event: "agent_settled", payload: {} });
    },
  };
}

describe("bridge version-skew matrix", () => {
  it("reads each published generation from its /health payload", () => {
    const older = projectBridgeCompatibility(HEALTH.v2);
    expect(older).toMatchObject({
      shape: "older",
      supportsDeltas: false,
      supportsAbort: false,
      serverVersion: "0.4.1",
    });
    expect(bridgeReplyLabel(older)).toBe("final message only");
    expect(bridgeStopLabel(older)).toBe("app only");

    const current = projectBridgeCompatibility(HEALTH.v3);
    expect(current).toMatchObject({
      shape: "current",
      supportsDeltas: true,
      supportsAbort: true,
      serverVersion: "0.5.0",
    });
    expect(bridgeReplyLabel(current)).toBe("streamed (protocol v3)");
    expect(bridgeStopLabel(current)).toBe("app and task pane");
  });

  it("claims nothing for a v1 bridge, an unreachable bridge, or no probe yet", () => {
    const unsupported = projectBridgeCompatibility({ protocolVersion: 1, capabilities: null });
    expect(unsupported.shape).toBe("unsupported");
    expect(bridgeReplyLabel(unsupported)).toBe("—");
    expect(bridgeStopLabel(unsupported)).toBe("—");

    const unreachable = projectBridgeCompatibility({ protocolVersion: null, capabilities: null });
    expect(unreachable.shape).toBe("unknown");
    expect(bridgeReplyLabel(unreachable)).toBe("—");

    expect(bridgeReplyLabel(null)).toBe("—");
    expect(bridgeStopLabel(null)).toBe("—");
  });

  it("keeps v3 affordances for a bridge newer than this app", () => {
    const newer = projectBridgeCompatibility({
      protocolVersion: 4,
      capabilities: ["http-health", "agent-deltas", "client-abort", "a-future-capability"],
    });
    expect(newer.shape).toBe("newer");
    expect(bridgeReplyLabel(newer)).toBe("streamed (protocol v3)");
  });

  it("renders a 0.4.x pane run: finals only, no crash", () => {
    const pane = createFakePane(2);
    pane.ask('[office:excel "Book1.xlsx" id=url_sha256:abc]\nhow many rows?');
    // The bridge sends nothing while the agent works.
    pane.stream("3 rows");
    pane.stream(" in Sheet1");
    expect(pane.tracker.view()).toMatchObject({ text: "", chunks: 0, streaming: true });

    pane.finish("Sheet1 has 3 rows.");
    expect(pane.tracker.view()).toMatchObject({
      text: "Sheet1 has 3 rows.",
      chunks: 0,
      streaming: false,
      active: false,
      paneInitiated: true,
      document: { host: "excel", documentName: "Book1.xlsx" },
    });
  });

  it("renders a 0.5.0 pane run: streamed text, then the authoritative final", () => {
    const pane = createFakePane(3);
    pane.ask('[office:excel "Book1.xlsx" id=url_sha256:abc]\nhow many rows?');
    pane.stream("Sheet1 has ");
    expect(pane.tracker.view()).toMatchObject({ text: "Sheet1 has ", chunks: 1, streaming: true });

    pane.stream("3 rows.");
    pane.finish("Sheet1 has 3 rows.");
    expect(pane.tracker.view()).toMatchObject({
      text: "Sheet1 has 3 rows.",
      chunks: 2,
      active: false,
    });
  });

  it("stops a pane's run from the app on both generations", async () => {
    for (const generation of [2, 3] as const) {
      const pane = createFakePane(generation);
      pane.ask("long question");
      pane.stream("partial");

      expect(await pane.tracker.stop()).toEqual({ ok: true });
      expect(pane.abort).toHaveBeenCalledTimes(1);
      expect(pane.tracker.view()).toMatchObject({ active: false, streaming: false });
      // A v3 pane also has its own Stop, which the bridge honours; the app never
      // depends on it, so the outcome here is identical for a v2 pane.
      expect(pane.tracker.view().text).toBe(generation === 3 ? "partial" : "");
    }
  });
});
