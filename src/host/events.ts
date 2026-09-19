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

/** Context-window usage for the session header (plan step 8 renders it). */
export interface ContextUsageSummary {
  /** Estimated tokens, or null right after compaction (Pi reports null then). */
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/** Token and cost totals accumulated by the session (plan step 8). */
export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
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
  /** Plan step 4: usage and queue modes the transcript/header need. */
  contextUsage: ContextUsageSummary | null;
  tokens: TokenTotals | null;
  steeringMode: string | null;
  followUpMode: string | null;
  autoRetry: boolean;
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
  /** Plan step 4: usage, queue modes and retry state. */
  getContextUsage?: () => ContextUsageLike | undefined;
  getSessionStats?: () => SessionStatsLike | undefined;
  getSteeringMode?: () => string;
  getFollowUpMode?: () => string;
  autoRetryEnabled?: boolean;
}

export interface ContextUsageLike {
  tokens?: number | null;
  contextWindow?: number;
  percent?: number | null;
}

export interface SessionStatsLike {
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  cost?: number;
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

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Context usage, when the session can report it. */
export function summarizeContextUsage(
  usage: ContextUsageLike | undefined,
): ContextUsageSummary | null {
  if (!usage || typeof usage.contextWindow !== "number") return null;
  return {
    tokens: typeof usage.tokens === "number" ? usage.tokens : null,
    contextWindow: usage.contextWindow,
    percent: typeof usage.percent === "number" ? usage.percent : null,
  };
}

/** Token/cost totals, when the session can report them. */
export function summarizeTokens(stats: SessionStatsLike | undefined): TokenTotals | null {
  const tokens = stats?.tokens;
  if (!tokens) return null;
  const input = toNumber(tokens.input);
  const output = toNumber(tokens.output);
  const cacheRead = toNumber(tokens.cacheRead);
  const cacheWrite = toNumber(tokens.cacheWrite);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: toNumber(tokens.total, input + output + cacheRead + cacheWrite),
    cost: toNumber(stats?.cost),
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
    contextUsage: summarizeContextUsage(safe(() => session.getContextUsage?.(), undefined)),
    tokens: summarizeTokens(safe(() => session.getSessionStats?.(), undefined)),
    steeringMode: safe(() => session.getSteeringMode?.() ?? null, null) as string | null,
    followUpMode: safe(() => session.getFollowUpMode?.() ?? null, null) as string | null,
    autoRetry: session.autoRetryEnabled === true,
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
