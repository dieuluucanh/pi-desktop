/**
 * Session state snapshots and the SDK-event → host-frame mapping.
 *
 * Frames mirror the SDK's event names one-to-one (`agent_start`, `message_update`,
 * `tool_execution_end`, …) so the renderer switches on the same vocabulary the
 * extension ecosystem uses, and a new SDK event needs no protocol change.
 */

export interface ModelSummary {
  id: string;
  provider: string;
  name: string | null;
}

export interface SessionSnapshot {
  sessionId: string | null;
  sessionFile: string | null;
  sessionName: string | null;
  cwd: string;
  model: ModelSummary | null;
  thinkingLevel: string | null;
  thinkingLevels: string[];
  streaming: boolean;
  idle: boolean;
  compacting: boolean;
  retrying: boolean;
  messageCount: number;
  pendingMessages: number;
  steering: string[];
  followUp: string[];
  activeTools: string[];
  toolCount: number;
  autoCompaction: boolean;
}

/** The narrow `AgentSession` surface `sessionSnapshot` reads. */
export interface SessionStateLike {
  sessionId?: string;
  sessionFile?: string;
  sessionName?: string;
  model?: { id?: string; provider?: string; name?: string } | undefined;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isIdle?: boolean;
  isCompacting?: boolean;
  isRetrying?: boolean;
  messages?: readonly unknown[];
  pendingMessageCount?: number;
  getSteeringMessages?: () => readonly string[];
  getFollowUpMessages?: () => readonly string[];
  getActiveToolNames?: () => string[];
  getAllTools?: () => readonly unknown[];
  getAvailableThinkingLevels?: () => string[];
  autoCompactionEnabled?: boolean;
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read() ?? fallback;
  } catch {
    return fallback;
  }
}

export function summarizeModel(model: SessionStateLike["model"]): ModelSummary | null {
  if (!model || typeof model.id !== "string") return null;
  return {
    id: model.id,
    provider: typeof model.provider === "string" ? model.provider : "unknown",
    name: typeof model.name === "string" ? model.name : null,
  };
}

export function sessionSnapshot(session: SessionStateLike, cwd: string): SessionSnapshot {
  const tools = safe(() => session.getAllTools?.() ?? [], []);

  return {
    sessionId: session.sessionId ?? null,
    sessionFile: session.sessionFile ?? null,
    sessionName: session.sessionName ?? null,
    cwd,
    model: summarizeModel(session.model),
    thinkingLevel: session.thinkingLevel ?? null,
    thinkingLevels: [...safe(() => session.getAvailableThinkingLevels?.() ?? [], [])],
    streaming: session.isStreaming === true,
    idle: session.isIdle ?? !session.isStreaming,
    compacting: session.isCompacting === true,
    retrying: session.isRetrying === true,
    messageCount: safe(() => session.messages?.length ?? 0, 0),
    pendingMessages: session.pendingMessageCount ?? 0,
    steering: [...safe(() => session.getSteeringMessages?.() ?? [], [])],
    followUp: [...safe(() => session.getFollowUpMessages?.() ?? [], [])],
    activeTools: [...safe(() => session.getActiveToolNames?.() ?? [], [])],
    toolCount: tools.length,
    autoCompaction: session.autoCompactionEnabled === true,
  };
}

export interface SessionEventLike {
  type: string;
  [key: string]: unknown;
}

export interface HostEventFrame {
  event: string;
  payload: unknown;
}

/**
 * Maps one SDK session event onto a host frame. The `type` becomes the frame's
 * `event`; every other field is the payload.
 */
export function eventToFrame(event: SessionEventLike): HostEventFrame {
  const { type, ...payload } = event;
  return { event: type, payload };
}

/** Events worth mirroring to the app; anything else is still forwarded verbatim. */
export const FORWARDED_SESSION_EVENTS: readonly string[] = [
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "entry_appended",
  "session_info_changed",
] as const;
