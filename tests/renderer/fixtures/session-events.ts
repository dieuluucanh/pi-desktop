/**
 * Deterministic session-event fixtures (2026-10-26 session-parity plan step 2).
 *
 * Every later reducer/transcript test should build its input from these helpers
 * instead of hand-writing loose payloads. The shapes mirror the SDK's
 * `AgentSessionEvent` stream one-to-one (`message_update.assistantMessageEvent`,
 * `tool_execution_*`, `queue_update`, retry/compaction/bash events, `oi.notify`),
 * so a fixture that renders correctly also describes what the host forwards.
 */

import type { SessionEventEntry } from "../../../src/shared/session-ipc";

export function event(name: string, payload: unknown = {}): SessionEventEntry {
  return { event: name, payload };
}

export const fixtures = {
  agentStart: (): SessionEventEntry => event("agent_start"),
  agentEnd: (extra: Record<string, unknown> = {}): SessionEventEntry => event("agent_end", extra),
  agentSettled: (): SessionEventEntry => event("agent_settled"),
  turnStart: (): SessionEventEntry => event("turn_start"),
  turnEnd: (): SessionEventEntry => event("turn_end", { toolResults: [] }),

  messageStart: (message: Record<string, unknown>, id = "message-1"): SessionEventEntry =>
    event("message_start", { message: { id, ...message } }),
  messageEnd: (message: Record<string, unknown>, id = "message-1"): SessionEventEntry =>
    event("message_end", { message: { id, ...message } }),
  messageUpdate: (assistantMessageEvent: Record<string, unknown>): SessionEventEntry =>
    event("message_update", { assistantMessageEvent }),

  text: (id = "message-1", text = "Hello"): SessionEventEntry[] => [
    fixtures.messageStart({ role: "assistant" }, id),
    fixtures.messageUpdate({ type: "text_start", contentIndex: 0 }),
    fixtures.messageUpdate({ type: "text_delta", contentIndex: 0, delta: text }),
    fixtures.messageUpdate({ type: "text_end", contentIndex: 0, content: text }),
    fixtures.messageEnd(
      { role: "assistant", content: [{ type: "text", text }], stopReason: "end" },
      id,
    ),
  ],

  toolStart: (
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown> = {},
  ): SessionEventEntry => event("tool_execution_start", { toolCallId, toolName, args }),
  toolUpdate: (
    toolCallId: string,
    result: unknown,
    extra: Record<string, unknown> = {},
  ): SessionEventEntry =>
    event("tool_execution_update", {
      toolCallId,
      partialResult: result,
      ...extra,
    }),
  toolEnd: (
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError = false,
  ): SessionEventEntry => event("tool_execution_end", { toolCallId, toolName, result, isError }),

  toolResult: (
    toolCallId: string,
    toolName: string,
    content: Array<Record<string, unknown>>,
    isError = false,
    id = "tool-result-1",
  ): SessionEventEntry[] => [
    fixtures.messageStart({ role: "toolResult", toolCallId, toolName, content, isError }, id),
    fixtures.messageEnd({ role: "toolResult", toolCallId, toolName, content, isError }, id),
  ],

  queue: (steering: string[] = [], followUp: string[] = []): SessionEventEntry =>
    event("queue_update", { steering, followUp }),
  compactionStart: (): SessionEventEntry => event("compaction_start", { reason: "manual" }),
  compactionEnd: (
    summary = "Compacted summary",
    extra: Record<string, unknown> = {},
  ): SessionEventEntry =>
    event("compaction_end", {
      reason: "manual",
      result: { summary },
      aborted: false,
      willRetry: false,
      ...extra,
    }),
  retryStart: (
    attempt = 1,
    maxAttempts = 3,
    delayMs = 2_000,
    errorMessage = "rate limited",
  ): SessionEventEntry =>
    event("auto_retry_start", { attempt, maxAttempts, delayMs, errorMessage }),
  retryEnd: (success = true, attempt = 1, finalError?: string): SessionEventEntry =>
    event("auto_retry_end", { success, attempt, ...(finalError ? { finalError } : {}) }),
  summarizationRetry: (attempt = 1, maxAttempts = 3, delayMs = 1_000): SessionEventEntry =>
    event("summarization_retry_scheduled", {
      attempt,
      maxAttempts,
      delayMs,
      errorMessage: "summarizer failed",
    }),
  bashUpdate: (id: string, delta: string): SessionEventEntry =>
    event("bash_execution_update", { id, delta }),
  notify: (message: string, type: "info" | "warning" | "error" = "info"): SessionEventEntry =>
    event("oi.notify", { message, type }),
  entryAppended: (entry: Record<string, unknown>): SessionEventEntry =>
    event("entry_appended", { entry }),
};

/**
 * One complete turn:
 *
 * user → agent start → assistant thinking/text/tool call → tool run →
 * tool result message → final assistant text → agent end/settled.
 *
 * The fixture deliberately includes the `toolResult` message pair: Pi emits it
 * after `tool_execution_end`, and the reducer must not render it as a second
 * assistant bubble.
 */
export function fullTurn(): SessionEventEntry[] {
  const toolCall = {
    type: "toolCall",
    id: "call-1",
    name: "read",
    arguments: { path: "note.txt" },
  };
  return [
    fixtures.messageStart(
      { role: "user", content: [{ type: "text", text: "Read note.txt" }] },
      "user-1",
    ),
    fixtures.messageEnd(
      { role: "user", content: [{ type: "text", text: "Read note.txt" }] },
      "user-1",
    ),
    fixtures.agentStart(),
    fixtures.turnStart(),
    fixtures.messageStart({ role: "assistant" }, "assistant-1"),
    fixtures.messageUpdate({ type: "thinking_start", contentIndex: 0 }),
    fixtures.messageUpdate({ type: "thinking_delta", contentIndex: 0, delta: "Need the file" }),
    fixtures.messageUpdate({ type: "thinking_end", contentIndex: 0, content: "Need the file" }),
    fixtures.messageUpdate({ type: "text_start", contentIndex: 1 }),
    fixtures.messageUpdate({ type: "text_delta", contentIndex: 1, delta: "Reading…" }),
    fixtures.messageUpdate({ type: "text_end", contentIndex: 1, content: "Reading…" }),
    fixtures.messageUpdate({
      type: "toolcall_start",
      contentIndex: 2,
      id: "call-1",
      toolName: "read",
    }),
    fixtures.messageUpdate({
      type: "toolcall_delta",
      contentIndex: 2,
      delta: '{"path":"note.txt"}',
    }),
    fixtures.messageUpdate({ type: "toolcall_end", contentIndex: 2, toolCall }),
    fixtures.messageEnd(
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Need the file" },
          { type: "text", text: "Reading…" },
          toolCall,
        ],
        stopReason: "toolUse",
      },
      "assistant-1",
    ),
    fixtures.toolStart("call-1", "read", { path: "note.txt" }),
    fixtures.toolUpdate("call-1", { content: [{ type: "text", text: "GIZMO\n" }] }),
    fixtures.toolEnd("call-1", "read", { content: [{ type: "text", text: "GIZMO\n" }] }),
    ...fixtures.toolResult("call-1", "read", [{ type: "text", text: "GIZMO\n" }]),
    fixtures.messageStart({ role: "assistant" }, "assistant-2"),
    fixtures.messageUpdate({ type: "text_start", contentIndex: 0 }),
    fixtures.messageUpdate({ type: "text_delta", contentIndex: 0, delta: "It says GIZMO." }),
    fixtures.messageUpdate({ type: "text_end", contentIndex: 0, content: "It says GIZMO." }),
    fixtures.messageEnd(
      { role: "assistant", content: [{ type: "text", text: "It says GIZMO." }], stopReason: "end" },
      "assistant-2",
    ),
    fixtures.agentEnd(),
    fixtures.agentSettled(),
  ];
}
