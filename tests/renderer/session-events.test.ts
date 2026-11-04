import { describe, expect, it, vi } from "vitest";
import type { SessionEventEntry } from "../../src/shared/session-ipc";
import { hashPromptText } from "../../src/shared/prompt-origin";
import { event, fixtures, fullTurn } from "./fixtures/session-events";
import {
  applyPromptOrigins,
  blocksFromContent,
  createTranscriptState,
  hydrateMessages,
  messageFromSdk,
  reduceSessionEvents,
  stopReasonNote,
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

  it("turns oi.notify into a transcript notice with the full message and severity", () => {
    const state = reduceSessionEvents(createTranscriptState(), [
      { event: "oi.notify", payload: { message: "line one\nline two", type: "warning" } },
      { event: "oi.notify", payload: { message: "plain info", type: "info" } },
      { event: "oi.notify", payload: { message: "failed", type: "error" } },
      { event: "oi.notify", payload: {} },
    ]);

    const notices = items(state).map((item) => (item.kind === "notice" ? item.notice : null));
    expect(notices).toHaveLength(3);
    expect(notices[0]).toMatchObject({
      event: "oi.notify",
      severity: "warning",
      text: "line one\nline two",
    });
    expect(notices[1]).toMatchObject({ severity: "info", text: "plain info" });
    expect(notices[2]).toMatchObject({ severity: "error", text: "failed" });
  });

  it("keeps only one transcript row for an identical repeated oi.notify", () => {
    const state = reduceSessionEvents(createTranscriptState(), [
      { event: "oi.notify", payload: { message: "same warning", type: "warning" } },
      { event: "oi.notify", payload: { message: "same warning", type: "warning" } },
      { event: "oi.notify", payload: { message: "same warning", type: "info" } },
      { event: "oi.notify", payload: { message: "different", type: "warning" } },
    ]);
    const notices = items(state).filter((item) => item.kind === "notice");
    expect(notices).toHaveLength(3);
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
          entryRenderable: true,
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

  it("drops the renderer-less `workflow` mode entry", () => {
    // The Tab-cycle noise: `persistState()` appends a bare `custom` entry with
    // data and no content, and no entry renderer. Pi shows nothing for it; the
    // host annotates the event and the reducer drops it, so a mode switch never
    // adds a blank row or scroll movement.
    const state = reduceSessionEvents(createTranscriptState(), [
      {
        event: "entry_appended",
        payload: {
          entry: { type: "custom", id: "w1", customType: "workflow", data: { mode: "plan" } },
          entryRenderable: false,
        },
      },
    ]);
    expect(items(state)).toEqual([]);
  });

  it("keeps a bare custom entry when the host found an entry renderer", () => {
    const state = reduceSessionEvents(createTranscriptState(), [
      {
        event: "entry_appended",
        payload: {
          entry: {
            type: "custom",
            id: "b1",
            customType: "workflow-review-mode",
            data: { band: "review" },
          },
          entryRenderable: true,
        },
      },
    ]);
    const message = firstMessage(state);
    expect(message.role).toBe("custom");
    expect(message.customKind).toBe("entry");
    expect(message.customType).toBe("workflow-review-mode");
    expect(message.blocks).toEqual([]);
  });

  it("hides a bare custom entry when the annotation is absent (legacy host)", () => {
    const state = reduceSessionEvents(createTranscriptState(), [
      { event: "entry_appended", payload: { entry: { type: "custom", id: "e" } } },
    ]);
    expect(items(state)).toEqual([]);
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
    // The rule is the host's renderer annotation, not a name match. A workflow
    // entry with a renderer must survive; a review-band entry without one must
    // not. If the reducer keyed on the `workflow` prefix, this would fail.
    for (const customType of ["workflow", "workflow-review-mode", "note", "todo"]) {
      const hidden = reduceSessionEvents(createTranscriptState(), [
        {
          event: "entry_appended",
          payload: {
            entry: { type: "custom", id: "e", customType },
            entryRenderable: false,
          },
        },
      ]);
      expect(items(hidden), customType).toEqual([]);

      const visible = reduceSessionEvents(createTranscriptState(), [
        {
          event: "entry_appended",
          payload: {
            entry: { type: "custom", id: "e", customType },
            entryRenderable: true,
          },
        },
      ]);
      const message = firstMessage(visible);
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

describe("turn plumbing and stop reasons", () => {
  it("does not append rows for agent, turn or session-info events", () => {
    const silent = ["agent_start", "agent_end", "agent_settled", "session_info_changed"];
    const state = reduceSessionEvents(
      createTranscriptState(),
      silent.map((name) => event(name)),
    );
    expect(state.items).toHaveLength(0);
  });

  it("renders a complete turn without synthetic notices", () => {
    const state = reduceSessionEvents(createTranscriptState(), fullTurn());
    expect(state.items.filter((item) => item.kind === "notice")).toHaveLength(0);
  });

  it("describes aborted, error and length stops once", () => {
    expect(stopReasonNote({ role: "assistant", stopReason: "aborted" })).toEqual({
      text: "Operation aborted",
      severity: "error",
    });
    expect(
      stopReasonNote({ role: "assistant", stopReason: "aborted", errorMessage: "stopped by user" }),
    ).toEqual({ text: "stopped by user", severity: "error" });
    expect(
      stopReasonNote({ role: "assistant", stopReason: "error", errorMessage: "boom" }),
    ).toEqual({ text: "Error: boom", severity: "error" });
    expect(stopReasonNote({ role: "assistant", stopReason: "length" })).toEqual({
      text: "Response was truncated before completion.",
      severity: "warning",
    });
    expect(stopReasonNote({ role: "assistant", stopReason: "end" })).toBeNull();
    expect(stopReasonNote({ role: "user", stopReason: "aborted" })).toBeNull();
  });

  it("keeps the SDK error text for hydration", () => {
    const message = messageFromSdk({
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
      stopReason: "error",
      errorMessage: "provider failed",
    });
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe("provider failed");
    expect(stopReasonNote(message)).toEqual({ text: "Error: provider failed", severity: "error" });
  });
});

describe("tool-result messages", () => {
  it("never renders a live toolResult as an assistant bubble or closes the open message", () => {
    let state = reduceSessionEvents(createTranscriptState(), [
      fixtures.messageStart({ role: "assistant" }, "assistant-1"),
      fixtures.messageUpdate({ type: "text_start", contentIndex: 0 }),
      fixtures.messageUpdate({ type: "text_delta", contentIndex: 0, delta: "Reading" }),
      fixtures.toolStart("call-1", "read", { path: "note.txt" }),
      fixtures.toolEnd("call-1", "read", { content: [{ type: "text", text: "GIZMO" }] }),
      ...fixtures.toolResult("call-1", "read", [{ type: "text", text: "GIZMO" }]),
    ]);

    const messages = state.items.filter((item) => item.kind === "message");
    expect(messages).toHaveLength(1);
    expect(state.openMessageId).toBe("assistant-1");
    const tools = state.items.filter((item) => item.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]?.kind === "tool" ? tools[0].tool.resultText : null).toBe("GIZMO");
    expect(
      messages.some(
        (item) =>
          item.kind === "message" &&
          item.message.blocks.some((block) => block.kind === "text" && block.text === "GIZMO"),
      ),
    ).toBe(false);

    // The authoritative assistant end still closes it.
    state = reduceSessionEvents(state, [
      fixtures.messageEnd(
        { role: "assistant", content: [{ type: "text", text: "Reading" }], stopReason: "end" },
        "assistant-1",
      ),
    ]);
    expect(state.openMessageId).toBeNull();
  });

  it("pairs assistant tool calls with results during hydration", () => {
    const state = hydrateMessages(createTranscriptState(), [
      { role: "user", content: [{ type: "text", text: "Read note.txt" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Reading" },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "note.txt" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "GIZMO\n" }],
        isError: false,
      },
      { role: "compactionSummary", summary: "Earlier context" },
      { role: "branchSummary", summary: "Abandoned branch" },
      { role: "bashExecution", output: "total 0" },
      { role: "system", content: "hidden" },
    ]);

    const messages = state.items.filter((item) => item.kind === "message");
    const tools = state.items.filter((item) => item.kind === "tool");
    expect(tools).toHaveLength(1);
    const tool = tools[0]?.kind === "tool" ? tools[0].tool : null;
    expect(tool).toMatchObject({
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "note.txt" },
      resultText: "GIZMO\n",
      done: true,
    });
    expect(messages.map((item) => (item.kind === "message" ? item.message.role : null))).toEqual([
      "user",
      "assistant",
      "compaction",
      "branchSummary",
      "bashExecution",
    ]);
    expect(
      messages.some(
        (item) =>
          item.kind === "message" &&
          item.message.role === "assistant" &&
          item.message.blocks.some((block) => block.kind === "text" && block.text === "GIZMO\n"),
      ),
    ).toBe(false);
  });
});

describe("aborted tool runs", () => {
  it("marks a running tool cancelled when the agent settles", () => {
    let state = reduceSessionEvents(createTranscriptState(), [
      fixtures.toolStart("call-1", "read", { path: "note.txt" }),
      fixtures.toolUpdate("call-1", { content: [{ type: "text", text: "half" }] }),
      fixtures.agentEnd(),
    ]);
    const tool = state.items.find((item) => item.kind === "tool");
    expect(tool?.kind === "tool" ? tool.tool : null).toMatchObject({
      done: true,
      cancelled: true,
    });

    state = reduceSessionEvents(state, [fixtures.agentEnd()]);
    expect(state.items.filter((item) => item.kind === "tool")).toHaveLength(1);
  });
});

describe("run status (plan step 8)", () => {
  it("tracks compaction, retry and summarization deadlines", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let state = reduceSessionEvents(createTranscriptState(), [fixtures.compactionStart()]);
    expect(state.runStatus).toEqual({ kind: "compacting" });
    state = reduceSessionEvents(state, [fixtures.retryStart(2, 5, 3_000)]);
    expect(state.runStatus).toMatchObject({
      kind: "retrying",
      attempt: 2,
      maxAttempts: 5,
      until: Date.now() + 3_000,
    });
    state = reduceSessionEvents(state, [fixtures.retryEnd()]);
    expect(state.runStatus).toBeNull();
    state = reduceSessionEvents(state, [fixtures.summarizationRetry(1, 2, 1_500)]);
    expect(state.runStatus).toMatchObject({ kind: "summarizing", attempt: 1, maxAttempts: 2 });
    state = reduceSessionEvents(state, [fixtures.compactionEnd()]);
    expect(state.runStatus).toBeNull();
    vi.useRealTimers();
  });

  it("records when the turn started so the working row can show elapsed time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let state = reduceSessionEvents(createTranscriptState(), [fixtures.agentStart()]);
    expect(state.runStartedAt).toBe(Date.now());
    state = reduceSessionEvents(state, [fixtures.agentEnd()]);
    expect(state.runStartedAt).toBeNull();
    state = reduceSessionEvents(state, [fixtures.agentStart()]);
    state = reduceSessionEvents(state, [fixtures.agentSettled()]);
    expect(state.runStartedAt).toBeNull();
    vi.useRealTimers();
  });
});

describe("bash execution", () => {
  it("streams output into one bashExecution row and finalizes it", () => {
    const id = "bash-1";
    let state = reduceSessionEvents(createTranscriptState(), [
      fixtures.messageStart(
        {
          role: "bashExecution",
          command: "pwd",
          output: "",
          cancelled: false,
          truncated: false,
          timestamp: 1,
        },
        id,
      ),
      fixtures.bashUpdate(id, "/work"),
      fixtures.bashUpdate(id, "\n"),
    ]);
    const item = state.items[0];
    expect(item?.kind === "message" ? item.message.role : null).toBe("bashExecution");
    expect(item?.kind === "message" ? item.message.blocks : []).toEqual([
      { kind: "text", text: "/work\n" },
    ]);
    state = reduceSessionEvents(state, [
      fixtures.messageEnd(
        {
          role: "bashExecution",
          command: "pwd",
          output: "/work\n",
          exitCode: 0,
          cancelled: false,
          truncated: false,
          timestamp: 1,
        },
        id,
      ),
    ]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.kind === "message" ? state.items[0].message.blocks : []).toEqual([
      { kind: "text", text: "/work\n" },
    ]);
  });

  it("does not steal the open assistant message when a `!` command starts", () => {
    let state = reduceSessionEvents(createTranscriptState(), [
      fixtures.messageStart({ role: "assistant" }, "assistant-1"),
      fixtures.messageUpdate({ type: "text_start", contentIndex: 0 }),
      fixtures.messageUpdate({ type: "text_delta", contentIndex: 0, delta: "Working" }),
      fixtures.messageStart(
        {
          role: "bashExecution",
          command: "pwd",
          output: "",
          cancelled: false,
          truncated: false,
          timestamp: 1,
        },
        "bash-1",
      ),
    ]);
    expect(state.openMessageId).toBe("assistant-1");
    state = reduceSessionEvents(state, [
      fixtures.bashUpdate("bash-1", "/work"),
      fixtures.messageEnd(
        {
          role: "bashExecution",
          command: "pwd",
          output: "/work",
          exitCode: 0,
          cancelled: false,
          truncated: false,
          timestamp: 1,
        },
        "bash-1",
      ),
    ]);
    // The bash end must not clear the assistant's open id either: the next
    // delta/end still belongs to the assistant message.
    expect(state.openMessageId).toBe("assistant-1");
    state = reduceSessionEvents(state, [
      fixtures.messageUpdate({ type: "text_delta", contentIndex: 0, delta: " still" }),
      fixtures.messageEnd(
        {
          role: "assistant",
          content: [{ type: "text", text: "Working still" }],
          stopReason: "end",
        },
        "assistant-1",
      ),
    ]);
    const assistant = state.items.find(
      (item) => item.kind === "message" && item.message.role === "assistant",
    );
    const bash = state.items.find(
      (item) => item.kind === "message" && item.message.role === "bashExecution",
    );
    expect(assistant?.kind === "message" ? assistant.message.blocks : []).toEqual([
      { kind: "text", text: "Working still" },
    ]);
    expect(bash?.kind === "message" ? bash.message.blocks : []).toEqual([
      { kind: "text", text: "/work" },
    ]);
    expect(state.openMessageId).toBeNull();
  });
});

describe("command prompt origins (2026-10-26 composer plan)", () => {
  it("carries the host promptOrigin onto the user message", () => {
    const state = reduceSessionEvents(createTranscriptState(), [
      {
        event: "message_start",
        payload: {
          message: { role: "user", content: [{ type: "text", text: "expanded body" }] },
          promptOrigin: "/commit -a",
        },
      },
    ]);
    const item = items(state)[0];
    if (item?.kind !== "message") throw new Error("expected a message item");
    expect(item.message.promptOrigin).toBe("/commit -a");
    expect(item.message.blocks).toEqual([{ kind: "text", text: "expanded body" }]);
  });

  it("keeps the origin through message_end", () => {
    let state = reduceSessionEvents(createTranscriptState(), [
      {
        event: "message_start",
        payload: {
          message: { role: "user", content: [{ type: "text", text: "body" }] },
          promptOrigin: "/commit",
        },
      },
    ]);
    state = reduceSessionEvents(state, [
      { event: "message_end", payload: { message: { role: "user", content: "body" } } },
    ]);
    const item = items(state)[0];
    if (item?.kind !== "message") throw new Error("expected a message item");
    expect(item.message.promptOrigin).toBe("/commit");
  });

  it("applies persisted origins when hydrating", () => {
    const body = "expanded body text";
    const state = hydrateMessages(
      createTranscriptState(),
      [{ id: "h1", role: "user", content: [{ type: "text", text: body }] }],
      { [hashPromptText(body)]: "/commit" },
    );
    const item = items(state)[0];
    if (item?.kind !== "message") throw new Error("expected a message item");
    expect(item.message.promptOrigin).toBe("/commit");
  });

  it("annotates a transcript hydrated before the origins arrived, idempotently", () => {
    const body = "expanded body text";
    const state = hydrateMessages(createTranscriptState(), [
      { id: "h1", role: "user", content: body },
    ]);
    const origins = { [hashPromptText(body)]: "/review x" };
    const annotated = applyPromptOrigins(state, origins);
    const item = items(annotated)[0];
    if (item?.kind !== "message") throw new Error("expected a message item");
    expect(item.message.promptOrigin).toBe("/review x");
    expect(applyPromptOrigins(annotated, origins)).toBe(annotated);
  });

  it("does not tag non-user messages or a different text", () => {
    const state = hydrateMessages(
      createTranscriptState(),
      [
        { id: "h1", role: "assistant", content: "hello" },
        { id: "h2", role: "user", content: "plain" },
      ],
      { [hashPromptText("hello")]: "/assistant-command", [hashPromptText("other")]: "/x" },
    );
    for (const item of items(state)) {
      if (item.kind !== "message") throw new Error("expected a message item");
      expect(item.message.promptOrigin).toBeUndefined();
    }
  });

  it("renders a session_error event as an error notice", () => {
    const state = reduceSessionEvents(createTranscriptState(), [
      { event: "session_error", payload: { message: "provider vanished" } },
    ]);
    const item = items(state)[0];
    if (item?.kind !== "notice") throw new Error("expected a notice item");
    expect(item.notice).toMatchObject({ severity: "error", text: "provider vanished" });
  });
});
