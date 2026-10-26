import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import {
  createTranscriptState,
  reduceSessionEvents,
} from "../../src/renderer/src/session/session-events";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import { fixtures } from "./fixtures/session-events";
import { installBridge } from "./fixtures";

/**
 * Extension-driven session replacement (2026-10-26 session-parity plan step 13).
 *
 * `ctx.newSession()` / `ctx.switchSession()` rebind the host to a different
 * conversation and emit `session_replaced`. The old transcript used to stay on
 * screen with a "Session replaced" notice; now a changed id resets and hydrates,
 * while a same-id rebind keeps its rows.
 */

const TAB = "tab-1";

function tab(): TabRecord {
  return {
    id: TAB,
    kind: "session",
    cwd: "/work/app",
    title: "app",
    sessionFile: "/profile/s1.jsonl",
    status: "running",
    createdAt: 0,
    lastActiveAt: 0,
    model: "test-model",
  };
}

function stubRequest(impl: (input: { method: string; params?: unknown }) => Promise<unknown>) {
  const request = vi.fn(async (input: { method: string; params?: unknown }) => impl(input));
  (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
  return request;
}

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    tabs: [tab()],
    activeTabId: TAB,
    transcripts: {
      [TAB]: reduceSessionEvents(
        createTranscriptState(),
        fixtures.text("assistant-1", "old answer"),
      ),
    },
    sessionStates: { [TAB]: { sessionId: "s1" } as never },
    completionCommands: {},
  });
});

describe("session replacement", () => {
  it("resets and hydrates when the session id changed", async () => {
    const request = stubRequest(async (input) => {
      if (input.method === "messages.get") {
        return {
          messages: [{ role: "assistant", content: [{ type: "text", text: "new answer" }] }],
        };
      }
      return {};
    });

    useAppStore.getState().applySessionEvents({
      tabId: TAB,
      seq: 4,
      events: [
        {
          event: "session_replaced",
          payload: { sessionId: "s2", sessionFile: "/profile/s2.jsonl" },
        },
      ],
    });

    // The old conversation is gone before hydration lands.
    expect(
      useAppStore
        .getState()
        .transcripts[TAB]?.items.some(
          (item) =>
            item.kind === "message" &&
            item.message.blocks.some(
              (block) => block.kind === "text" && block.text === "old answer",
            ),
        ),
    ).toBe(false);
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith({ tabId: TAB, method: "messages.get" });
    });
    await vi.waitFor(() => {
      const items = useAppStore.getState().transcripts[TAB]?.items ?? [];
      expect(
        items.some(
          (item) =>
            item.kind === "message" &&
            item.message.blocks.some(
              (block) => block.kind === "text" && block.text === "new answer",
            ),
        ),
      ).toBe(true);
    });
    // No "Session replaced" notice over the fresh transcript.
    const notices = (useAppStore.getState().transcripts[TAB]?.items ?? []).filter(
      (item) => item.kind === "notice",
    );
    expect(notices).toHaveLength(0);
  });

  it("keeps the transcript and the notice when the id is unchanged", () => {
    const request = stubRequest(async () => ({}));
    const before = useAppStore.getState().transcripts[TAB]?.items.length ?? 0;

    useAppStore.getState().applySessionEvents({
      tabId: TAB,
      seq: 5,
      events: [{ event: "session_replaced", payload: { sessionId: "s1" } }],
    });

    const items = useAppStore.getState().transcripts[TAB]?.items ?? [];
    expect(items.length).toBe(before + 1);
    expect(items.at(-1)).toMatchObject({ kind: "notice", notice: { text: "Session replaced" } });
    expect(request).not.toHaveBeenCalledWith({ tabId: TAB, method: "messages.get" });
  });

  it("does not reset when the payload carries no session id", () => {
    stubRequest(async () => ({}));
    const before = useAppStore.getState().transcripts[TAB]?.items.length ?? 0;
    useAppStore.getState().applySessionEvents({
      tabId: TAB,
      seq: 6,
      events: [{ event: "session_replaced", payload: {} }],
    });
    expect(useAppStore.getState().transcripts[TAB]?.items.length).toBe(before + 1);
  });
});
