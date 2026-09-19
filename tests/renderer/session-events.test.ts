import { describe, expect, it } from "vitest";
import type { SessionEventEntry } from "../../src/shared/session-ipc";
import {
  blocksFromContent,
  createTranscriptState,
  hydrateMessages,
  messageFromSdk,
  reduceSessionEvents,
  textOfPartial,
  type TranscriptItem,
} from "../../src/renderer/src/session/session-events";

/**
 * The transcript reducer (plan step 5). Pure and replay-safe: these tests pin the
 * two rules the UI depends on — deltas assemble in order by `contentIndex`, and
 * the authoritative `message_end` always wins.
 */

const update = (event: Record<string, unknown>): SessionEventEntry => ({
  event: "message_update",
  payload: { assistantMessageEvent: event },
});

function items(state: { items: TranscriptItem[] }): TranscriptItem[] {
  return state.items;
}

function firstMessage(state: { items: TranscriptItem[] }) {
  const item = state.items[0];
  if (item?.kind !== "message") throw new Error("expected a message item");
  return item.message;
}

describe("streaming assembly", () => {
  it("assembles text deltas into one block and replaces it at message_end", () => {
    let state = createTranscriptState();
    state = reduceSessionEvents(state, [
      { event: "message_start", payload: { message: { role: "assistant" } } },
      update({ type: "text_start", contentIndex: 0 }),
      update({ type: "text_delta", contentIndex: 0, delta: "Hel" }),
      update({ type: "text_delta", contentIndex: 0, delta: "lo" }),
    ]);

    expect(firstMessage(state).blocks).toEqual([{ kind: "text", text: "Hello" }]);
    expect(firstMessage(state).streaming).toBe(true);

    state = reduceSessionEvents(state, [
      {
        event: "message_end",
        payload: {
          message: { role: "assistant", content: [{ type: "text", text: "Hello there" }] },
        },
      },
    ]);
    expect(firstMessage(state).blocks).toEqual([{ kind: "text", text: "Hello there" }]);
    expect(firstMessage(state).streaming).toBe(false);
  });

  it("keeps thinking and text in contentIndex order", () => {
    let state = createTranscriptState();
    state = reduceSessionEvents(state, [
      { event: "message_start", payload: { message: { role: "assistant" } } },
      update({ type: "thinking_start", contentIndex: 0 }),
      update({ type: "thinking_delta", contentIndex: 0, delta: "why " }),
      update({ type: "thinking_delta", contentIndex: 0, delta: "not" }),
      update({ type: "thinking_end", contentIndex: 0, content: "why not" }),
      update({ type: "text_start", contentIndex: 1 }),
      update({ type: "text_delta", contentIndex: 1, delta: "because" }),
    ]);

    expect(firstMessage(state).blocks).toEqual([
      { kind: "thinking", text: "why not" },
      { kind: "text", text: "because" },
    ]);
  });

  it("streams a tool call and completes it with parsed arguments", () => {
    let state = createTranscriptState();
    state = reduceSessionEvents(state, [
      { event: "message_start", payload: { message: { role: "assistant" } } },
      update({ type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "read" }),
      update({ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"a' }),
      update({ type: "toolcall_delta", contentIndex: 0, delta: '.ts"}' }),
      update({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { id: "call-1", name: "read", arguments: { path: "a.ts" } },
      }),
    ]);

    expect(firstMessage(state).blocks).toEqual([
      {
        kind: "toolCall",
        id: "call-1",
        name: "read",
        arguments: '{"path":"a.ts"}',
        complete: true,
      },
    ]);
  });

  it("ignores a delta that arrives with no streaming message", () => {
    const state = createTranscriptState();
    const next = reduceSessionEvents(state, [update({ type: "text_delta", delta: "orphan" })]);
    expect(items(next)).toEqual([]);
  });

  it("records provider usage without disturbing the items", () => {
    let state = createTranscriptState();
    state = reduceSessionEvents(state, [
      { event: "message_start", payload: { message: { role: "assistant" } } },
      {
        event: "message_update",
        payload: { assistantMessageEvent: { type: "text_delta", delta: "x" }, usage: { input: 3 } },
      },
    ]);
    expect(state.usage).toEqual({ input: 3 });
    expect(firstMessage(state).blocks).toEqual([{ kind: "text", text: "x" }]);
  });

  it("records the batch sequence", () => {
    const state = reduceSessionEvents(createTranscriptState(), [], 12);
    expect(state.lastSeq).toBe(12);
  });
});

describe("tool execution items", () => {
  it("upserts one item per toolCallId with partial then final output", () => {
    let state = createTranscriptState();
    state = reduceSessionEvents(state, [
      {
        event: "tool_execution_start",
        payload: { toolCallId: "t1", toolName: "bash", args: { command: "ls" } },
      },
      {
        event: "tool_execution_update",
        payload: { toolCallId: "t1", partialResult: { content: [{ type: "text", text: "half" }] } },
      },
      {
        event: "tool_execution_end",
        payload: {
          toolCallId: "t1",
          result: { content: [{ type: "text", text: "done" }] },
          isError: false,
        },
      },
    ]);

    expect(items(state)).toHaveLength(1);
    const item = items(state)[0];
    expect(item?.kind).toBe("tool");
    if (item?.kind !== "tool") throw new Error("expected a tool item");
    expect(item.tool).toMatchObject({
      toolName: "bash",
      done: true,
      isError: false,
      resultText: "done",
    });
    expect(item.tool.args).toEqual({ command: "ls" });
  });

  it("marks a failing tool", () => {
    const state = reduceSessionEvents(createTranscriptState(), [
      { event: "tool_execution_start", payload: { toolCallId: "t9", toolName: "edit" } },
      {
        event: "tool_execution_end",
        payload: {
          toolCallId: "t9",
          isError: true,
          result: { content: [{ type: "text", text: "boom" }] },
        },
      },
    ]);
    const item = items(state)[0];
    if (item?.kind !== "tool") throw new Error("expected a tool item");
    expect(item.tool.isError).toBe(true);
  });
});

describe("queue and notices", () => {
  it("tracks the steering and follow-up queue", () => {
    const state = reduceSessionEvents(createTranscriptState(), [
      { event: "queue_update", payload: { steering: ["a"], followUp: ["b", 7] } },
    ]);
    expect(state.queue).toEqual({ steering: ["a"], followUp: ["b"] });
  });

  it("turns lifecycle events into notices, including a crash and an extension error", () => {
    const state = reduceSessionEvents(createTranscriptState(), [
      { event: "session_started", payload: {} },
      { event: "session.crashed", payload: { code: 1 } },
      { event: "extension_error", payload: { error: "kaboom" } },
    ]);

    const notices = items(state).map((item) => (item.kind === "notice" ? item.notice : null));
    expect(notices[0]).toMatchObject({ severity: "info", event: "session_started" });
    expect(notices[1]).toMatchObject({ severity: "warning", event: "session.crashed" });
    expect(notices[2]).toMatchObject({ severity: "error", detail: "kaboom" });
  });

  it("renders compaction as a card, a cancellation, and a failure", () => {
    const summary = reduceSessionEvents(createTranscriptState(), [
      { event: "compaction_end", payload: { result: { summary: "condensed" } } },
    ]);
    expect(firstMessage(summary).role).toBe("compaction");
    expect(firstMessage(summary).blocks).toEqual([{ kind: "text", text: "condensed" }]);

    const aborted = reduceSessionEvents(createTranscriptState(), [
      { event: "compaction_end", payload: { aborted: true } },
    ]);
    const abortedItem = items(aborted)[0];
    expect(abortedItem?.kind === "notice" && abortedItem.notice.severity).toBe("warning");

    const failed = reduceSessionEvents(createTranscriptState(), [
      { event: "compaction_end", payload: { errorMessage: "quota" } },
    ]);
    const failedItem = items(failed)[0];
    expect(failedItem?.kind === "notice" && failedItem.notice.detail).toBe("quota");
  });

  it("keeps custom entries for the extension renderer (step 18)", () => {
    const state = reduceSessionEvents(createTranscriptState(), [
      {
        event: "entry_appended",
        payload: {
          entry: { type: "custom_message", id: "c1", customType: "todo", content: "3 items" },
        },
      },
    ]);
    expect(firstMessage(state).role).toBe("custom");
    expect(firstMessage(state).customType).toBe("todo");
    expect(firstMessage(state).blocks).toEqual([{ kind: "text", text: "3 items" }]);
  });

  it("ignores events that carry no transcript meaning", () => {
    const state = reduceSessionEvents(createTranscriptState(), [
      { event: "turn_start", payload: {} },
      { event: "turn_end", payload: {} },
      { event: "tool_execution_unknown", payload: {} },
    ]);
    expect(items(state)).toEqual([]);
  });
});

describe("history hydration", () => {
  it("seeds history, marks the state hydrated, and still resolves message_end by id", () => {
    let state = hydrateMessages(createTranscriptState(), [
      { id: "h1", role: "user", content: "hi" },
      { id: "h2", role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]);
    expect(state.hydrated).toBe(true);
    expect(items(state)).toHaveLength(2);

    state = reduceSessionEvents(state, [
      {
        event: "message_end",
        payload: { message: { id: "h2", role: "assistant", content: "replaced" } },
      },
    ]);
    const replaced = items(state)[1];
    if (replaced?.kind !== "message") throw new Error("expected a message item");
    expect(replaced.message.blocks).toEqual([{ kind: "text", text: "replaced" }]);
    expect(items(state)).toHaveLength(2);
  });
});

describe("content conversion", () => {
  it("reads every block type the SDK sends", () => {
    expect(blocksFromContent("plain")).toEqual([{ kind: "text", text: "plain" }]);
    expect(
      blocksFromContent([
        { type: "text", text: "t" },
        { type: "thinking", thinking: "th" },
        { type: "toolCall", id: "c", name: "read", arguments: { path: "p" } },
        { type: "image", mimeType: "image/png", data: "AAA" },
        { type: "unknown" },
      ]),
    ).toEqual([
      { kind: "text", text: "t" },
      { kind: "thinking", text: "th" },
      { kind: "toolCall", id: "c", name: "read", arguments: '{"path":"p"}', complete: true },
      { kind: "image", mimeType: "image/png", data: "AAA" },
    ]);
  });

  it("maps a bash execution message's output", () => {
    const message = messageFromSdk({ role: "bashExecution", output: "total 0" });
    expect(message.role).toBe("bashExecution");
    expect(message.blocks).toEqual([{ kind: "text", text: "total 0" }]);
  });

  it("reads tool result text", () => {
    expect(textOfPartial({ content: [{ type: "text", text: "a" }, { type: "image" }] })).toBe("a");
    expect(textOfPartial("raw")).toBe("raw");
    expect(textOfPartial(null)).toBe("");
  });
});
