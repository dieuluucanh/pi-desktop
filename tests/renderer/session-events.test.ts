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
    // The raw result and a content version survive, so a tool renderer sees the
    // exact `{content, details}` payload and a card can re-render on change.
    expect(item.tool.result).toEqual({ content: [{ type: "text", text: "done" }] });
    expect(item.tool.partialResult).toEqual({ content: [{ type: "text", text: "half" }] });
    expect(item.tool.version).toBe(3);
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

  it("surfaces a Plannotator review decision as a notice (plan step 21)", () => {
    const state = reduceSessionEvents(createTranscriptState(), [
      { event: "tool_execution_start", payload: { toolCallId: "t1", toolName: "bash" } },
      {
        event: "tool_execution_end",
        payload: {
          toolCallId: "t1",
          result: {
            content: [{ type: "text", text: '{"decision":"annotated","feedback":"fix"}' }],
          },
        },
      },
    ]);

    const notice = items(state).find((item) => item.kind === "notice");
    if (notice?.kind !== "notice") throw new Error("expected a review notice");
    expect(notice.notice).toMatchObject({
      event: "review_decision",
      severity: "warning",
      text: "Plan review feedback sent",
    });
  });

  it("does not add a notice for an ordinary tool result", () => {
    const state = reduceSessionEvents(createTranscriptState(), [
      {
        event: "tool_execution_end",
        payload: {
          toolCallId: "t1",
          result: { content: [{ type: "text", text: "ok" }] },
        },
      },
    ]);
    expect(items(state).every((item) => item.kind !== "notice")).toBe(true);
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
      {
        event: "entry_appended",
        payload: {
          entry: { type: "custom", id: "e1", customType: "note", data: { body: "hi" } },
        },
      },
    ]);
    const message = firstMessage(state);
    expect(message.role).toBe("custom");
    expect(message.customType).toBe("todo");
    expect(message.customKind).toBe("message");
    expect(message.customPayload).toMatchObject({ type: "custom_message", id: "c1" });
    expect(message.blocks).toEqual([{ kind: "text", text: "3 items" }]);

    const entry = items(state)[1];
    if (entry?.kind !== "message") throw new Error("expected a custom entry message");
    expect(entry.message.customKind).toBe("entry");
    expect(entry.message.customPayload).toMatchObject({ type: "custom", data: { body: "hi" } });
  });

  it("drops a `display: false` custom_message from entry_appended", () => {
    // The workflow extension injects its Plan-Mode context with `display: false`
    // (`index.ts:7019–7022`); Pi never shows it, so the app must not either.
    const state = reduceSessionEvents(createTranscriptState(), [
      {
        event: "entry_appended",
        payload: {
          entry: {
            type: "custom_message",
            id: "c1",
            customType: "workflow-plan-context",
            content: "[PLAN MODE ACTIVE]",
            display: false,
          },
        },
      },
    ]);
    expect(items(state)).toEqual([]);
  });

  it("drops a live `display: false` custom message from message_start/end", () => {
    // The live pair is emitted by `_appendCustomMessage` with `role: "custom"`,
    // so without this rule the hidden context renders as an assistant bubble.
    const hidden = {
      role: "custom",
      customType: "workflow-plan-context",
      content: "[PLAN MODE ACTIVE]",
      display: false,
    };
    let state = reduceSessionEvents(createTranscriptState(), [
      { event: "message_start", payload: { message: hidden } },
      { event: "message_end", payload: { message: hidden } },
    ]);
    expect(items(state)).toEqual([]);
    expect(state.openMessageId).toBeNull();

    // …and the end must not disturb a real message that is still streaming.
    state = reduceSessionEvents(state, [
      { event: "message_start", payload: { message: { role: "assistant" } } },
      { event: "message_end", payload: { message: hidden } },
    ]);
    const streaming = items(state)[0];
    if (streaming?.kind !== "message") throw new Error("expected the assistant message");
    expect(streaming.message.role).toBe("assistant");
  });

  it("keeps a `display: true` custom message", () => {
    const state = reduceSessionEvents(createTranscriptState(), [
      {
        event: "message_start",
        payload: {
          message: {
            role: "custom",
            customType: "workflow-btw",
            content: "[BTW] note",
            display: true,
          },
        },
      },
    ]);
    const message = firstMessage(state);
    expect(message.role).toBe("custom");
    expect(message.blocks).toEqual([{ kind: "text", text: "[BTW] note" }]);
  });

  it("renders a bare `workflow` entry as a custom entry with no text", () => {
    // The Tab-cycle noise: `persistState()` appends a bare `custom` entry with
    // data and no content. The reducer forwards it (the renderer decides); it
    // must never carry text that would show as chat.
    const state = reduceSessionEvents(createTranscriptState(), [
      {
        event: "entry_appended",
        payload: {
          entry: { type: "custom", id: "w1", customType: "workflow", data: { mode: "plan" } },
        },
      },
    ]);
    const message = firstMessage(state);
    expect(message.role).toBe("custom");
    expect(message.customKind).toBe("entry");
    expect(message.customType).toBe("workflow");
    expect(message.blocks).toEqual([]);
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

  it("drops hidden custom context on reload, exactly as the live stream did", () => {
    // Regression: a reload used to replay the workflow extension's hidden
    // Plan-Mode context as an assistant bubble.
    const state = hydrateMessages(createTranscriptState(), [
      { id: "h1", role: "user", content: "hi" },
      {
        id: "h2",
        role: "custom_message",
        customType: "workflow-plan-context",
        content: "[PLAN MODE ACTIVE]",
        display: false,
      },
      { id: "h3", role: "assistant", content: "ok" },
    ]);
    expect(items(state)).toHaveLength(2);
    expect(items(state).map((item) => (item.kind === "message" ? item.message.role : ""))).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("keeps a visible custom message on reload", () => {
    const state = hydrateMessages(createTranscriptState(), [
      {
        id: "h1",
        role: "custom_message",
        customType: "workflow-btw",
        content: "[BTW] note",
        display: true,
      },
    ]);
    expect(firstMessage(state).role).toBe("custom");
    expect(firstMessage(state).customType).toBe("workflow-btw");
  });
});

/**
 * The boundary of the Pi-parity rule (2026-10-19 UI rework).
 *
 * The transcript hides exactly two things: a `custom_message` Pi marked
 * `display: false`, and (in the renderer) a bare `custom` entry with no
 * registered renderer. It must **not** hide by customType, and it must not hide
 * a custom *message* — those are the tempting shortcuts that would break the
 * next extension whose entries are worth showing.
 */
describe("hidden-item boundary", () => {
  it("does not key the rule on the workflow customType", () => {
    // A bare `custom` entry is forwarded whatever its type; the renderer decides
    // by asking the host whether a renderer exists. If the reducer dropped
    // `workflow` by name, the review bands (which share the prefix) would vanish.
    for (const customType of ["workflow", "workflow-review-mode", "note", "todo"]) {
      const state = reduceSessionEvents(createTranscriptState(), [
        { event: "entry_appended", payload: { entry: { type: "custom", id: "e", customType } } },
      ]);
      const message = firstMessage(state);
      expect(message.customType, customType).toBe(customType);
      expect(message.customKind, customType).toBe("entry");
    }
  });

  it("hides only `display: false`, not a missing display flag", () => {
    // Pi treats an absent `display` as displayable for a custom entry; only an
    // explicit `false` hides. `display: 0`/`null` are not the flag either.
    for (const display of [undefined, true, null, 0, "false"]) {
      const state = reduceSessionEvents(createTranscriptState(), [
        {
          event: "entry_appended",
          payload: {
            entry: { type: "custom_message", id: "c", customType: "t", content: "x", display },
          },
        },
      ]);
      expect(items(state), JSON.stringify(display)).toHaveLength(1);
    }
  });

  it("never hides a user or assistant message", () => {
    const state = reduceSessionEvents(createTranscriptState(), [
      { event: "message_start", payload: { message: { role: "user", content: "ask" } } },
      { event: "message_end", payload: { message: { role: "user", content: "ask" } } },
      { event: "message_start", payload: { message: { role: "assistant" } } },
      { event: "message_end", payload: { message: { role: "assistant", content: "answer" } } },
    ]);
    expect(items(state)).toHaveLength(2);
    expect(items(state).map((item) => (item.kind === "message" ? item.message.role : ""))).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("does not hide a custom message that merely has no text", () => {
    // An image-only custom message has empty blocks but is still displayable; the
    // rule keys on `display`, never on emptiness.
    const state = reduceSessionEvents(createTranscriptState(), [
      {
        event: "entry_appended",
        payload: {
          entry: {
            type: "custom_message",
            id: "c",
            customType: "screenshot",
            content: [{ type: "image", mimeType: "image/png", data: "AAA" }],
            display: true,
          },
        },
      },
    ]);
    expect(items(state)).toHaveLength(1);
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

  it("maps the SDK's `custom` role to the app's custom kind, never assistant", () => {
    // Regression: `role: "custom"` used to fall through to `assistant`, so a
    // workflow context message rendered as an assistant bubble.
    const message = messageFromSdk({
      role: "custom",
      customType: "workflow-plan-context",
      content: "[PLAN MODE ACTIVE]",
      display: false,
    });
    expect(message.role).toBe("custom");
    expect(message.role).not.toBe("assistant");
    expect(message.customType).toBe("workflow-plan-context");
    expect(message.customKind).toBe("message");
  });

  it("still maps a custom_message to a custom message", () => {
    const message = messageFromSdk({
      role: "custom_message",
      customType: "todo",
      content: "3 items",
    });
    expect(message.role).toBe("custom");
    expect(message.customKind).toBe("message");
  });

  it("reads tool result text", () => {
    expect(textOfPartial({ content: [{ type: "text", text: "a" }, { type: "image" }] })).toBe("a");
    expect(textOfPartial("raw")).toBe("raw");
    expect(textOfPartial(null)).toBe("");
  });
});
