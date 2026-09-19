/**
 * Office run tracking: consuming the office session's streamed text and stopping
 * the run through the session that owns it.
 *
 * The harness is a fake event feed plus a spy abort — no host process, no
 * WebSocket — so the pane/stream behaviour is exercised deterministically.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createOfficeRunTracker,
  type OfficeRunEvent,
  type OfficeRunTracker,
} from "../../src/main/office/office-run";

interface Harness {
  tracker: OfficeRunTracker;
  emit: (event: OfficeRunEvent) => void;
  abort: ReturnType<typeof vi.fn>;
  unsubscribed: () => boolean;
}

function makeHarness(options: { abort?: () => Promise<void> } = {}): Harness {
  let listener: ((event: OfficeRunEvent) => void) | null = null;
  let unsubscribed = false;
  const abort = vi.fn(options.abort ?? (async () => undefined));
  const tracker = createOfficeRunTracker({
    subscribe: (next) => {
      listener = next;
      return () => {
        unsubscribed = true;
        listener = null;
      };
    },
    abort: () => abort(),
    now: () => 1_000,
  });
  return {
    tracker,
    emit: (event) => listener?.(event),
    abort,
    unsubscribed: () => unsubscribed,
  };
}

const userMessage = (text: string): OfficeRunEvent => ({
  event: "message_start",
  payload: { message: { role: "user", content: [{ type: "text", text }] } },
});

const delta = (text: string): OfficeRunEvent => ({
  event: "message_update",
  payload: { assistantMessageEvent: { type: "text_delta", delta: text } },
});

const assistantFinal = (text: string): OfficeRunEvent => ({
  event: "message_end",
  payload: { message: { role: "assistant", content: [{ type: "text", text }] } },
});

describe("createOfficeRunTracker", () => {
  it("streams deltas and replaces them with the final reply", () => {
    const { tracker, emit } = makeHarness();
    expect(tracker.view().active).toBe(false);

    emit(userMessage("summarize Sheet1"));
    expect(tracker.view()).toMatchObject({ active: true, streaming: true, startedAt: 1_000 });

    emit(delta("Sheet1 "));
    emit(delta("has 3 rows."));
    expect(tracker.view()).toMatchObject({
      text: "Sheet1 has 3 rows.",
      chunks: 2,
      streaming: true,
    });

    emit(assistantFinal("Sheet1 has 3 rows and one header."));
    const settled = tracker.view();
    expect(settled.text).toBe("Sheet1 has 3 rows and one header.");
    expect(settled.streaming).toBe(false);
    // The run stays active until the agent settles: tool calls may still follow
    // this assistant message.
    expect(settled.active).toBe(true);

    emit({ event: "agent_settled", payload: {} });
    expect(tracker.view()).toMatchObject({ active: false, streaming: false, endedAt: 1_000 });
  });

  it("renders a finals-only bridge (protocol v2) without deltas", () => {
    const { tracker, emit } = makeHarness();
    emit(userMessage("hello"));
    // A 0.4.x bridge sends no deltas at all.
    emit(assistantFinal("Hi from an older bridge."));
    expect(tracker.view()).toMatchObject({
      text: "Hi from an older bridge.",
      chunks: 0,
      streaming: false,
    });
    emit({ event: "agent_settled", payload: {} });
    expect(tracker.view().active).toBe(false);
  });

  it("recognises a pane-initiated run and its document", () => {
    const { tracker, emit } = makeHarness();
    emit(userMessage('[office:excel "Book1.xlsx" id=url_sha256:abc]\nadd a total row'));
    expect(tracker.view()).toMatchObject({
      paneInitiated: true,
      document: { host: "excel", documentName: "Book1.xlsx", documentId: "url_sha256:abc" },
    });
  });

  it("treats an untagged prompt as app-initiated", () => {
    const { tracker, emit } = makeHarness();
    emit(userMessage("add a total row"));
    expect(tracker.view()).toMatchObject({ paneInitiated: false, document: null });
  });

  it("starts a clean buffer for each run", () => {
    const { tracker, emit } = makeHarness();
    emit(userMessage("first"));
    emit(delta("one"));
    emit(assistantFinal("one"));
    emit(userMessage("second"));
    expect(tracker.view()).toMatchObject({ text: "", chunks: 0, streaming: true });
  });

  it("ignores tool-only and unknown frames", () => {
    const { tracker, emit } = makeHarness();
    emit(userMessage("hello"));
    emit({ event: "tool_execution_start", payload: { toolName: "excel.read_range" } });
    emit({ event: "agent_start", payload: {} });
    emit(assistantFinal("still here"));
    expect(tracker.view().text).toBe("still here");
  });

  it("ignores a message_end that is not the assistant's", () => {
    const { tracker, emit } = makeHarness();
    emit(userMessage("hello"));
    emit({ event: "message_end", payload: { message: { role: "user", content: "hello" } } });
    expect(tracker.view().text).toBe("");
  });

  it("stops an active run through the session", async () => {
    const { tracker, emit, abort } = makeHarness();
    emit(userMessage("long question"));
    emit(delta("partial"));

    const result = await tracker.stop();
    expect(result).toEqual({ ok: true });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(tracker.view()).toMatchObject({ active: false, streaming: false });
    // The partial text stays visible until the next run replaces it.
    expect(tracker.view().text).toBe("partial");
  });

  it("reports an idle stop instead of aborting the wrong thing", async () => {
    const { tracker, abort } = makeHarness();
    expect(await tracker.stop()).toEqual({ ok: false, reason: "idle" });
    expect(abort).not.toHaveBeenCalled();
  });

  it("surfaces an abort failure without losing the run", async () => {
    const { tracker, emit } = makeHarness({
      abort: async () => {
        throw new Error("host is not responding");
      },
    });
    emit(userMessage("hello"));
    expect(await tracker.stop()).toEqual({
      ok: false,
      reason: "failed",
      error: "host is not responding",
    });
    expect(tracker.view().active).toBe(true);
  });

  it("settles once the agent finishes, so a late Stop is a no-op", async () => {
    const { tracker, emit, abort } = makeHarness();
    emit(userMessage("hello"));
    emit(assistantFinal("done"));
    emit({ event: "agent_settled", payload: {} });
    expect(await tracker.stop()).toEqual({ ok: false, reason: "idle" });
    expect(abort).not.toHaveBeenCalled();
  });

  it("unsubscribes on dispose", () => {
    const harness = makeHarness();
    harness.tracker.dispose();
    expect(harness.unsubscribed()).toBe(true);
  });
});
