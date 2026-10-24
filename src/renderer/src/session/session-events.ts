import type { SessionEventEntry } from "../../../shared/session-ipc";
import { parseReviewDecision, type ReviewDecision } from "../../../shared/web-tabs";

/**
 * The transcript reducer (plan step 5).
 *
 * Pure, DOM-free and replay-safe: it turns the ordered host event batches from
 * the session service into the items a transcript renders. Two rules make it
 * trustworthy:
 *
 *  - **Order is the only structure.** Events arrive already ordered (a per-tab
 *    `seq`), so the reducer never re-sorts and never merges batches.
 *  - **`message_end` wins.** Streaming deltas build a provisional message; the
 *    authoritative `message_end` replaces its content, so a dropped or
 *    duplicated delta can never corrupt what the user sees.
 *
 * Everything here mirrors the event shapes Pi's own RPC mode documents
 * (`message_update.assistantMessageEvent`, `tool_execution_*`, `queue_update`).
 */

export interface TranscriptTextBlock {
  kind: "text";
  text: string;
}

export interface TranscriptThinkingBlock {
  kind: "thinking";
  text: string;
}

export interface TranscriptToolCallBlock {
  kind: "toolCall";
  id: string;
  name: string;
  /** Raw JSON argument text (streamed until `complete`). */
  arguments: string;
  complete: boolean;
}

export interface TranscriptImageBlock {
  kind: "image";
  mimeType: string;
  data: string;
}

export type TranscriptBlock =
  TranscriptTextBlock | TranscriptThinkingBlock | TranscriptToolCallBlock | TranscriptImageBlock;

export type TranscriptMessageRole =
  "user" | "assistant" | "custom" | "bashExecution" | "compaction" | "branchSummary";

export interface TranscriptMessage {
  id: string;
  role: TranscriptMessageRole;
  blocks: TranscriptBlock[];
  timestamp?: number;
  /** True while deltas are still being appended. */
  streaming: boolean;
  /** Custom entry/message type, so the extension renderer can be looked up. */
  customType?: string;
  /**
   * Which Pi entry kind a custom item came from (plan step 18): a
   * `custom_message` goes through `getMessageRenderer`, a `custom` entry through
   * `getEntryRenderer`.
   */
  customKind?: "message" | "entry";
  /** The raw custom message/entry, forwarded verbatim to its renderer. */
  customPayload?: unknown;
  model?: string;
  stopReason?: string;
}

export interface TranscriptToolRun {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  /** Accumulated streaming output (replaced by the final result). */
  partial?: string;
  /** Raw streaming result payload, for a tool's own `renderResult`. */
  partialResult?: unknown;
  resultText?: string;
  /** Raw final result payload (`{content, details}`), for a tool's renderer. */
  result?: unknown;
  isError: boolean;
  done: boolean;
  /** Bumped on every update, so a render request is keyed on the content. */
  version: number;
}

export interface TranscriptNotice {
  id: string;
  severity: "info" | "warning" | "error";
  event: string;
  text: string;
  detail?: string;
}

export type TranscriptItem =
  | { kind: "message"; id: string; message: TranscriptMessage }
  | { kind: "tool"; id: string; tool: TranscriptToolRun }
  | { kind: "notice"; id: string; notice: TranscriptNotice };

export interface TranscriptQueue {
  steering: string[];
  followUp: string[];
}

export interface TranscriptState {
  items: TranscriptItem[];
  /** Item index by message id, for O(1) `message_end` replacement. */
  messageIndex: Record<string, number>;
  toolIndex: Record<string, number>;
  /**
   * The message `message_start` opened. Pi streams user *and* assistant messages
   * without ids, so `message_end` needs this to replace the right item instead of
   * appending a duplicate.
   */
  openMessageId: string | null;
  queue: TranscriptQueue;
  /** Latest provider usage reported by `message_update`. */
  usage: unknown;
  lastSeq: number;
  /** True once history has been loaded from `messages.get`. */
  hydrated: boolean;
}

export function createTranscriptState(): TranscriptState {
  return {
    items: [],
    messageIndex: {},
    toolIndex: {},
    openMessageId: null,
    queue: { steering: [], followUp: [] },
    usage: null,
    lastSeq: 0,
    hydrated: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

let fallbackCounter = 0;

/** Stable id for items the SDK does not identify (user/notice/tool runs). */
function nextId(prefix: string): string {
  fallbackCounter += 1;
  return `${prefix}-${fallbackCounter}`;
}

export function blocksFromContent(content: unknown): TranscriptBlock[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ kind: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: TranscriptBlock[] = [];
  for (const raw of content) {
    const block = asRecord(raw);
    switch (block.type) {
      case "text":
        blocks.push({ kind: "text", text: asString(block.text) });
        break;
      case "thinking":
        blocks.push({ kind: "thinking", text: asString(block.thinking) });
        break;
      case "image": {
        const source = asRecord(block.source);
        blocks.push({
          kind: "image",
          mimeType: asString(block.mimeType ?? source.mediaType ?? "image/png"),
          data: asString(block.data ?? source.data),
        });
        break;
      }
      case "toolCall":
        blocks.push({
          kind: "toolCall",
          id: asString(block.id),
          name: asString(block.name),
          arguments: JSON.stringify(block.arguments ?? {}),
          complete: true,
        });
        break;
      default:
        break;
    }
  }
  return blocks;
}

/**
 * True when Pi would hide this message entirely.
 *
 * A `custom_message` with `display: false` participates in LLM context but is
 * never shown (`agent-session.js:1101–1145` emits it as a live
 * `message_start`/`message_end` pair with `role: "custom"`; Pi's interactive
 * mode gates rendering on `message.display`). The app must drop it in the
 * reducer, because its `role` is not one of the renderable ones.
 */
export function isHiddenCustomMessage(message: unknown): boolean {
  const record = asRecord(message);
  const role = asString(record.role);
  if (role !== "custom" && role !== "custom_message") return false;
  return record.display === false;
}

/** Converts one SDK message into a transcript message. */
export function messageFromSdk(message: unknown, id: string = nextId("msg")): TranscriptMessage {
  const record = asRecord(message);
  const role = asString(record.role);
  // `custom` is the SDK's own role for `CustomMessage` (`agent-session.js:1100`);
  // it must never fall through to `assistant`, or a hidden workflow context
  // message would render as an assistant bubble.
  const mappedRole: TranscriptMessageRole =
    role === "user" || role === "assistant"
      ? role
      : role === "custom" || role === "custom_message"
        ? "custom"
        : role === "bashExecution"
          ? "bashExecution"
          : "assistant";
  const isCustom = mappedRole === "custom";
  const text = role === "bashExecution" ? asString(record.output) : record.content;
  return {
    id,
    role: mappedRole,
    blocks: blocksFromContent(text),
    ...(typeof record.timestamp === "number" ? { timestamp: record.timestamp } : {}),
    streaming: false,
    ...(typeof record.customType === "string" ? { customType: record.customType } : {}),
    // Both custom shapes render through a message renderer; keep the raw payload
    // so the renderer receives exactly what Pi's `MessageRenderer` expects.
    ...(isCustom ? { customKind: "message" as const, customPayload: message } : {}),
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    ...(typeof record.stopReason === "string" ? { stopReason: record.stopReason } : {}),
  };
}

function withItems(state: TranscriptState, items: TranscriptItem[]): TranscriptState {
  return { ...state, items };
}

function appendItem(state: TranscriptState, item: TranscriptItem): TranscriptState {
  const items = [...state.items, item];
  if (item.kind === "message") {
    return {
      ...state,
      items,
      messageIndex: { ...state.messageIndex, [item.id]: items.length - 1 },
    };
  }
  if (item.kind === "tool") {
    return {
      ...state,
      items,
      toolIndex: { ...state.toolIndex, [item.tool.toolCallId]: items.length - 1 },
    };
  }
  return { ...state, items };
}

/** Only forwards tool arguments when the frame actually carries them. */
function argsPatch(payload: Record<string, unknown>): { args?: unknown } {
  return payload.args === undefined ? {} : { args: payload.args };
}

/** Only forwards a tool name when the frame actually carries one. */
function toolNamePatch(payload: Record<string, unknown>): { toolName?: string } {
  const name = asString(payload.toolName);
  return name.length > 0 ? { toolName: name } : {};
}

/** Replaces (or appends) a tool run, keeping its position in the transcript. */
function upsertTool(
  state: TranscriptState,
  toolCallId: string,
  patch: Partial<TranscriptToolRun> & { toolName?: string },
): TranscriptState {
  const index = state.toolIndex[toolCallId];
  if (index === undefined || !state.items[index]) {
    const tool: TranscriptToolRun = {
      toolCallId,
      toolName: patch.toolName ?? "tool",
      isError: patch.isError ?? false,
      done: patch.done ?? false,
      ...patch,
      version: 1,
    };
    const item: TranscriptItem = { kind: "tool", id: toolCallId, tool };
    const items = [...state.items, item];
    return {
      ...state,
      items,
      toolIndex: { ...state.toolIndex, [toolCallId]: items.length - 1 },
    };
  }
  const current = state.items[index] as Extract<TranscriptItem, { kind: "tool" }>;
  const items = [...state.items];
  items[index] = {
    kind: "tool",
    id: toolCallId,
    tool: { ...current.tool, ...patch, version: current.tool.version + 1 },
  };
  return withItems(state, items);
}

/** The assistant message currently being streamed, if any. */
function lastStreamingMessageIndex(state: TranscriptState): number {
  for (let index = state.items.length - 1; index >= 0; index -= 1) {
    const item = state.items[index];
    if (item?.kind === "message" && item.message.role === "assistant" && item.message.streaming) {
      return index;
    }
  }
  return -1;
}

/** Applies a `message_update` delta by `contentIndex`, like Pi's own clients do. */
function applyDelta(
  state: TranscriptState,
  event: Record<string, unknown>,
  usage: unknown,
): TranscriptState {
  const index = lastStreamingMessageIndex(state);
  if (index === -1) return usage === undefined ? state : { ...state, usage };
  const item = state.items[index];
  if (item?.kind !== "message") return state;

  const type = asString(event.type);
  const contentIndex =
    typeof event.contentIndex === "number" && event.contentIndex >= 0 ? event.contentIndex : 0;
  const blocks = [...item.message.blocks];
  const target = blocks[contentIndex];

  const ensureText = (): TranscriptTextBlock => {
    if (target?.kind === "text") return target;
    const block: TranscriptTextBlock = { kind: "text", text: "" };
    blocks[contentIndex] = block;
    return block;
  };
  const ensureThinking = (): TranscriptThinkingBlock => {
    if (target?.kind === "thinking") return target;
    const block: TranscriptThinkingBlock = { kind: "thinking", text: "" };
    blocks[contentIndex] = block;
    return block;
  };
  const ensureToolCall = (): TranscriptToolCallBlock => {
    if (target?.kind === "toolCall") return target;
    const block: TranscriptToolCallBlock = {
      kind: "toolCall",
      id: asString(event.id),
      name: asString(event.toolName),
      arguments: "",
      complete: false,
    };
    blocks[contentIndex] = block;
    return block;
  };

  switch (type) {
    case "text_start":
      ensureText();
      break;
    case "text_delta":
      ensureText().text += asString(event.delta);
      break;
    case "text_end":
      ensureText().text = asString(event.content);
      break;
    case "thinking_start":
      ensureThinking();
      break;
    case "thinking_delta":
      ensureThinking().text += asString(event.delta);
      break;
    case "thinking_end":
      ensureThinking().text = asString(event.content);
      break;
    case "toolcall_start":
      ensureToolCall();
      break;
    case "toolcall_delta":
      ensureToolCall().arguments += asString(event.delta);
      break;
    case "toolcall_end": {
      const call = asRecord(event.toolCall);
      const block = ensureToolCall();
      block.id = asString(call.id) || block.id;
      block.name = asString(call.name) || block.name;
      block.arguments = JSON.stringify(call.arguments ?? block.arguments);
      block.complete = true;
      break;
    }
    default:
      return state;
  }

  const items = [...state.items];
  items[index] = {
    kind: "message",
    id: item.id,
    message: { ...item.message, blocks, streaming: true },
  };
  return { ...state, items, ...(usage === undefined ? {} : { usage }) };
}

/** Replaces a message's content with the authoritative `message_end` payload. */
function finishMessage(state: TranscriptState, message: unknown): TranscriptState {
  // Hidden context never entered the transcript, so its end must not close (or
  // append) anything: `message_start` was skipped, leaving `openMessageId` for
  // whatever real message is still streaming. Falling through here would apply
  // this payload to that unrelated message.
  if (isHiddenCustomMessage(message)) return state;
  const record = asRecord(message);
  const id = asString(record.id);
  // Resolution order matters: an explicit id wins, then the message that
  // `message_start` opened (Pi streams user messages without ids too), then
  // whatever assistant message is still streaming.
  const byId = id.length > 0 ? state.messageIndex[id] : undefined;
  const byOpen = state.openMessageId ? state.messageIndex[state.openMessageId] : undefined;
  const streamingIndex = lastStreamingMessageIndex(state);
  const resolvedIndex = byId ?? byOpen ?? (streamingIndex === -1 ? undefined : streamingIndex);

  if (resolvedIndex === undefined) {
    return appendItem(state, {
      kind: "message",
      id: id || nextId("msg"),
      message: messageFromSdk(message, id || undefined),
    });
  }
  const item = state.items[resolvedIndex];
  if (item?.kind !== "message") return { ...state, openMessageId: null };
  const authoritative = messageFromSdk(message, item.id);
  const items = [...state.items];
  items[resolvedIndex] = {
    kind: "message",
    id: item.id,
    message: { ...item.message, ...authoritative, streaming: false },
  };
  return { ...state, items, openMessageId: null };
}

function appendNotice(
  state: TranscriptState,
  event: string,
  severity: TranscriptNotice["severity"],
  text: string,
  detail?: string,
): TranscriptState {
  return appendItem(state, {
    kind: "notice",
    id: nextId("notice"),
    notice: { id: nextId("n"), severity, event, text, ...(detail ? { detail } : {}) },
  });
}

const NOTICE_SEVERITY: Record<string, TranscriptNotice["severity"]> = {
  session_started: "info",
  session_replaced: "info",
  session_recovered: "info",
  session_info_changed: "info",
  agent_start: "info",
  agent_end: "info",
  agent_settled: "info",
  compaction_start: "info",
  "session.crashed": "warning",
  "session.timeout": "warning",
  extension_error: "error",
};

/** One `ctx.ui.notify` payload as a transcript notice, or null when malformed. */
function notificationNotice(
  payload: unknown,
): { text: string; severity: TranscriptNotice["severity"] } | null {
  const record = asRecord(payload);
  const text = asString(record.message);
  if (!text) return null;
  const type = record.type ?? record.notifyType;
  return {
    text,
    severity: type === "warning" || type === "error" ? type : "info",
  };
}

const NOTICE_TEXT: Record<string, string> = {
  session_started: "Session started",
  session_replaced: "Session replaced",
  session_recovered: "Session recovered after a crash",
  compaction_start: "Compacting the conversation…",
  "session.crashed": "The host process crashed",
  "session.timeout": "The session host stopped responding",
  extension_error: "An extension raised an error",
};

/**
 * The review outcome a Plannotator tool result reports (plan step 21). Surfacing
 * it as a notice means the decision is readable next to the tool card instead of
 * only inside the raw JSON.
 */
const REVIEW_NOTICE_TEXT: Record<ReviewDecision, string> = {
  approved: "Plan review approved",
  annotated: "Plan review feedback sent",
  dismissed: "Plan review dismissed",
};

/** Folds one ordered batch of host events into the transcript. */
export function reduceSessionEvents(
  state: TranscriptState,
  events: readonly SessionEventEntry[],
  seq = state.lastSeq,
): TranscriptState {
  let next = state;
  for (const entry of events) {
    const payload = asRecord(entry.payload);
    switch (entry.event) {
      case "message_start": {
        // A `display: false` custom message is context, not transcript content.
        if (isHiddenCustomMessage(payload.message)) break;
        const raw = asRecord(payload.message);
        const id = asString(raw.id) || nextId("msg");
        next = appendItem(next, {
          kind: "message",
          id,
          message: {
            ...messageFromSdk(payload.message, id),
            streaming: raw.role === "assistant",
          },
        });
        next = { ...next, openMessageId: id };
        break;
      }

      case "message_update":
        next = applyDelta(
          next,
          asRecord(payload.assistantMessageEvent),
          payload.usage === undefined ? undefined : payload.usage,
        );
        break;

      case "message_end":
        next = finishMessage(next, payload.message);
        break;

      case "tool_execution_start":
        next = upsertTool(next, asString(payload.toolCallId), {
          ...toolNamePatch(payload),
          ...argsPatch(payload),
          done: false,
        });
        break;

      case "tool_execution_update":
        next = upsertTool(next, asString(payload.toolCallId), {
          ...toolNamePatch(payload),
          ...argsPatch(payload),
          partial: textOfPartial(payload.partialResult),
          ...(payload.partialResult === undefined ? {} : { partialResult: payload.partialResult }),
        });
        break;

      case "tool_execution_end": {
        const resultText = textOfPartial(payload.result);
        next = upsertTool(next, asString(payload.toolCallId), {
          ...toolNamePatch(payload),
          ...argsPatch(payload),
          resultText,
          ...(payload.result === undefined ? {} : { result: payload.result }),
          isError: payload.isError === true,
          done: true,
        });
        // A Plannotator review reports its decision on stdout (`--json` or the
        // plaintext approval); a notice keeps that outcome visible (step 21).
        const decision = parseReviewDecision(resultText);
        if (decision) {
          next = appendNotice(
            next,
            "review_decision",
            decision === "approved" ? "info" : "warning",
            REVIEW_NOTICE_TEXT[decision],
          );
        }
        break;
      }

      case "queue_update":
        next = {
          ...next,
          queue: {
            steering: asStringArray(payload.steering),
            followUp: asStringArray(payload.followUp),
          },
        };
        break;

      case "compaction_end": {
        const result = asRecord(payload.result);
        if (payload.aborted === true) {
          next = appendNotice(next, "compaction_end", "warning", "Compaction was cancelled");
        } else if (payload.errorMessage) {
          next = appendNotice(
            next,
            "compaction_end",
            "error",
            "Compaction failed",
            asString(payload.errorMessage),
          );
        } else {
          next = appendItem(next, {
            kind: "message",
            id: nextId("compaction"),
            message: {
              id: nextId("c"),
              role: "compaction",
              blocks: asString(result.summary)
                ? [{ kind: "text", text: asString(result.summary) }]
                : [],
              streaming: false,
            },
          });
        }
        break;
      }

      case "entry_appended": {
        const entry = asRecord(payload.entry);
        // A hidden `custom_message` is context-only, exactly as in the live
        // `message_start` path above.
        if (entry.type === "custom_message" && entry.display === false) break;
        if (entry.type === "custom_message" || entry.type === "custom") {
          const entryId = asString(entry.id) || nextId("custom");
          next = appendItem(next, {
            kind: "message",
            id: entryId,
            message: {
              id: entryId,
              role: "custom",
              blocks: asString(entry.content)
                ? [{ kind: "text", text: asString(entry.content) }]
                : [],
              streaming: false,
              ...(typeof entry.customType === "string" ? { customType: entry.customType } : {}),
              // `custom_message` participates in LLM context and renders through
              // the message renderer; a bare `custom` entry through the entry one.
              customKind: entry.type === "custom" ? "entry" : "message",
              customPayload: payload.entry,
            },
          });
        }
        break;
      }

      case "oi.notify": {
        // Extension command output is chat content in terminal Pi. Keep the
        // full multi-line message; the notification archive/toast path is
        // handled separately by the store.
        const notice = notificationNotice(payload);
        if (notice) next = appendNotice(next, "oi.notify", notice.severity, notice.text);
        break;
      }

      default: {
        const severity = NOTICE_SEVERITY[entry.event];
        if (severity) {
          next = appendNotice(
            next,
            entry.event,
            severity,
            NOTICE_TEXT[entry.event] ?? entry.event,
            entry.event === "extension_error" ? asString(payload.error) : undefined,
          );
        }
        break;
      }
    }
  }
  return { ...next, lastSeq: seq };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** Text of a tool result/partial payload (`{content:[{type:"text",text}]}`). */
export function textOfPartial(result: unknown): string {
  // A tool result is usually `{content:[…]}`, but a plain string is valid too
  // (Pi allows tools to return text directly).
  if (typeof result === "string") return result;
  const content = asRecord(result).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const record = asRecord(block);
      return record.type === "text" ? asString(record.text) : "";
    })
    .join("");
}

/**
 * Seeds the transcript from `messages.get` (resume/open). History is appended
 * before any live events, and `messageIndex` is rebuilt so `message_end` still
 * finds its message.
 */
export function hydrateMessages(
  state: TranscriptState,
  messages: readonly unknown[],
): TranscriptState {
  let next: TranscriptState = { ...state, hydrated: true };
  for (const message of messages) {
    // Reload must hide the same items the live stream hid; otherwise the
    // workflow extension's context-only messages reappear as bubbles.
    if (isHiddenCustomMessage(message)) continue;
    const record = asRecord(message);
    const id = asString(record.id) || nextId("history");
    next = appendItem(next, { kind: "message", id, message: messageFromSdk(message, id) });
  }
  return next;
}
