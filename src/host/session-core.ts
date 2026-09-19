import type { HostMethod } from "../shared/host-protocol";
import {
  eventToFrame,
  sessionSnapshot,
  type SessionSnapshot,
  type SessionStateLike,
} from "./events";
import {
  createProjectTrust,
  type ProjectTrust,
  type TrustAnswer,
  type TrustStoreLike,
} from "./project-trust";
import type { HostHandler } from "./service";

/**
 * The host's session core (plan step 5): it owns the live `AgentSession`, keeps
 * the app's state snapshot fresh, mirrors SDK events into host frames and answers
 * the session/conversation/state methods of the protocol.
 *
 * Every SDK contact is injected (`createRuntime`, `trustStore`, `requiresTrust`,
 * `bindSession`), so this module has no `@earendil-works/*` import: the
 * composition root `src/host/index.ts` supplies the real adapters from
 * `src/host/sdk/index.ts`.
 */

/** What `clearQueue` reports back about the messages it removed. */
export interface ClearedQueue {
  steering?: readonly string[];
  followUp?: readonly string[];
}

/** One row of the session browser (passed through from the SDK's listing). */
export interface SessionListEntry {
  [key: string]: unknown;
}

/** The narrow `AgentSession` surface the core drives. */
export interface HostSession extends SessionStateLike {
  subscribe?(listener: (event: { type: string; [key: string]: unknown }) => void): () => void;
  prompt(text: string, options?: unknown): Promise<void>;
  steer?(text: string): Promise<void>;
  followUp?(text: string): Promise<void>;
  abort?(): Promise<void>;
  clearQueue?(): ClearedQueue;
  setModel?(model: unknown, options?: unknown): Promise<void>;
  setThinkingLevel?(level: string, options?: unknown): void;
  setActiveToolsByName?(names: string[]): void;
  compact?(instructions?: string): Promise<unknown>;
  reload?(options?: unknown): Promise<void>;
}

export interface SessionManagerLike {
  /** Creates a new on-disk session (the JSONL header is written by the SDK). */
  create(cwd: string, sessionDir?: string): SessionManagerHandle;
  open(path: string, sessionDir?: string, cwdOverride?: string): SessionManagerHandle;
  list?(cwd: string, sessionDir?: string): Promise<unknown[]>;
}

export interface SessionManagerHandle {
  /** Persists the session (the SDK writes the v3 JSONL header) and names it. */
  appendSessionInfo?(name: string): string;
  getSessionFile?(): string | undefined;
  [key: string]: unknown;
}

export interface RuntimeHandleLike {
  readonly session: HostSession;
  readonly services: { settingsManager?: SettingsLike; cwd?: string } | undefined;
}

export interface RuntimeLike {
  get session(): HostSession;
  get services(): { settingsManager?: SettingsLike; cwd?: string };
  newSession?(options?: unknown): Promise<{ cancelled: boolean }>;
  switchSession?(path: string, options?: unknown): Promise<{ cancelled: boolean }>;
  fork?(entryId: string, options?: unknown): Promise<{ cancelled: boolean; selectedText?: string }>;
  setRebindSession?(rebind?: () => Promise<void>): void;
  dispose?(): Promise<void>;
}

export interface SettingsLike {
  get?(): Record<string, unknown>;
  flush?(): Promise<void>;
  drainErrors?(): unknown[];
}

export interface SessionRuntimeRequest {
  cwd: string;
  agentDir: string;
  sessionManager: SessionManagerHandle;
  npmCommand?: readonly string[] | null;
}

export interface SessionCoreDeps {
  cwd: string;
  agentDir: string;
  sessionDir?: string;
  npmCommand?: readonly string[] | null;
  /** Creates the SDK runtime (see `src/host/sdk/index.ts`). */
  createRuntime(
    request: SessionRuntimeRequest,
  ): Promise<{ runtime: RuntimeLike; session: HostSession }>;
  /** Opens an existing session JSONL file. */
  openSessionManager?(sessionFile: string, cwd: string, sessionDir?: string): SessionManagerHandle;
  /** Creates a new session manager (defaults to `openSessionManager`'s counterpart). */
  newSessionManager?(cwd: string, sessionDir?: string): SessionManagerHandle;
  trustStore?: TrustStoreLike;
  requiresTrust?(cwd: string): boolean;
  /** Session browser listing (plan step 11 surfaces it). */
  listSessions?(cwd: string): Promise<SessionListEntry[]>;
  /** Injected by the extension UI host (plan step 6). */
  bindSession?(session: HostSession): Promise<void>;
  emit(event: string, payload?: unknown, sessionId?: string): void;
  now?: () => number;
}

export interface SessionCore {
  handlers(): Partial<Record<HostMethod, HostHandler>>;
  snapshot(): SessionSnapshot;
  session(): HostSession | null;
  cwd(): string;
  dispose(): Promise<void>;
}

class SessionCoreError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SessionCoreError(`${field} must be a non-empty string`, "bad_request");
  }
  return value;
}

export function createSessionCore(deps: SessionCoreDeps): SessionCore {
  const trust: ProjectTrust = createProjectTrust({
    store: deps.trustStore ?? { get: () => null, set: () => {} },
    requiresTrust: deps.requiresTrust ?? (() => false),
  });

  let cwd = deps.cwd;
  let session: HostSession | null = null;
  let runtime: RuntimeLike | null = null;
  let manager: SessionManagerHandle | null = null;
  let unsubscribe: (() => void) | null = null;
  let settingsManager: SettingsLike | null = null;

  /** Events after which the app should refresh its state snapshot. */
  const STATE_EVENTS = new Set([
    "agent_start",
    "agent_end",
    "agent_settled",
    "queue_update",
    "compaction_end",
    "message_end",
    "session_info_changed",
  ]);

  const emitState = (): void => {
    deps.emit("state", snapshot(), session?.sessionId ?? undefined);
  };

  const attach = (next: HostSession): void => {
    unsubscribe?.();
    session = next;
    const listener = (event: { type: string; [key: string]: unknown }): void => {
      const frame = eventToFrame(event);
      deps.emit(frame.event, frame.payload, next.sessionId ?? undefined);
      if (STATE_EVENTS.has(event.type)) emitState();
    };
    unsubscribe = next.subscribe ? next.subscribe(listener) : null;
  };

  const rebind = async (): Promise<void> => {
    if (!runtime) return;
    attach(runtime.session);
    settingsManager = runtime.services?.settingsManager ?? settingsManager;
    await deps.bindSession?.(runtime.session);
    deps.emit("session_replaced", snapshot(), runtime.session.sessionId ?? undefined);
    emitState();
  };

  const snapshot = (): SessionSnapshot => {
    if (!session) {
      return {
        sessionId: null,
        sessionFile: null,
        sessionName: null,
        cwd,
        model: null,
        thinkingLevel: null,
        thinkingLevels: [],
        streaming: false,
        idle: true,
        compacting: false,
        retrying: false,
        messageCount: 0,
        pendingMessages: 0,
        steering: [],
        followUp: [],
        activeTools: [],
        toolCount: 0,
        autoCompaction: false,
      };
    }
    return sessionSnapshot(session, cwd);
  };

  const ensure = (): HostSession => {
    if (!session)
      throw new SessionCoreError("no session is open; call session.create first", "no_session");
    return session;
  };

  const startSession = async (options: {
    cwd: string;
    sessionManager: SessionManagerHandle;
    trustAnswer?: TrustAnswer;
  }): Promise<SessionSnapshot> => {
    const status = trust.status(options.cwd);
    if (status.needsPrompt && !options.trustAnswer) {
      deps.emit("project_trust", status, undefined);
      throw new SessionCoreError(
        `${options.cwd} ships project resources; answer the trust prompt before opening it`,
        "trust_required",
      );
    }
    if (options.trustAnswer) trust.answer(options.cwd, options.trustAnswer);

    cwd = options.cwd;
    manager = options.sessionManager;
    const created = await deps.createRuntime({
      cwd,
      agentDir: deps.agentDir,
      sessionManager: options.sessionManager,
      npmCommand: deps.npmCommand,
    });
    runtime = created.runtime;
    settingsManager = created.runtime.services?.settingsManager ?? null;
    attach(created.session);
    runtime.setRebindSession?.(rebind);
    await deps.bindSession?.(created.session);

    deps.emit("session_started", snapshot(), created.session.sessionId ?? undefined);
    emitState();
    return snapshot();
  };

  const handlers: Partial<Record<HostMethod, HostHandler>> = {
    "session.create": async (params) => {
      const input = asRecord(params);
      const targetCwd =
        typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : deps.cwd;
      const trustAnswer =
        input.trust === "trust" || input.trust === "never" || input.trust === "session"
          ? (input.trust as TrustAnswer)
          : undefined;
      const sessionManager = deps.newSessionManager
        ? deps.newSessionManager(targetCwd, deps.sessionDir)
        : {};
      return startSession({
        cwd: targetCwd,
        sessionManager,
        ...(trustAnswer ? { trustAnswer } : {}),
      });
    },

    "session.open": async (params) => {
      const input = asRecord(params);
      const sessionFile = requireString(input.sessionFile ?? input.path, "sessionFile");
      return startSession({
        cwd: typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : deps.cwd,
        sessionManager: openManager(deps, sessionFile, cwd),
      });
    },

    "session.resume": async (params) => {
      const input = asRecord(params);
      if (runtime?.switchSession && typeof input.sessionFile === "string") {
        await runtime.switchSession(input.sessionFile);
        return snapshot();
      }
      const sessionFile = requireString(input.sessionFile ?? input.path, "sessionFile");
      return startSession({ cwd, sessionManager: openManager(deps, sessionFile, cwd) });
    },

    "session.list": async () => {
      if (!deps.listSessions) return { sessions: [] };
      return { sessions: await deps.listSessions(cwd) };
    },

    "session.fork": async (params) => {
      const input = asRecord(params);
      const entryId = requireString(input.entryId ?? input.id, "entryId");
      if (!runtime?.fork)
        throw new SessionCoreError("fork is not supported by this runtime", "unsupported");
      const result = await runtime.fork(entryId, {
        position: input.position === "before" ? "before" : "at",
      });
      await rebind();
      return {
        ...snapshot(),
        cancelled: result.cancelled,
        selectedText: result.selectedText ?? null,
      };
    },

    "session.reload": async () => {
      const current = ensure();
      await current.reload?.();
      await rebind();
      return snapshot();
    },

    "session.rename": (params) => {
      const name = requireString(asRecord(params).name, "name");
      if (!manager?.appendSessionInfo) {
        throw new SessionCoreError("this session cannot be renamed", "unsupported");
      }
      manager.appendSessionInfo(name);
      emitState();
      return { name, sessionFile: manager.getSessionFile?.() ?? session?.sessionFile ?? null };
    },

    prompt: async (params) => {
      const current = ensure();
      const input = asRecord(params);
      const text = requireString(input.text, "text");
      await current.prompt(text, input.images ? { images: input.images } : undefined);
      return snapshot();
    },

    steer: async (params) => {
      const current = ensure();
      const text = requireString(asRecord(params).text, "text");
      if (!current.steer) throw new SessionCoreError("steering is not supported", "unsupported");
      await current.steer(text);
      return { queued: true };
    },

    followUp: async (params) => {
      const current = ensure();
      const text = requireString(asRecord(params).text, "text");
      if (!current.followUp)
        throw new SessionCoreError("follow-up is not supported", "unsupported");
      await current.followUp(text);
      return { queued: true };
    },

    abort: async () => {
      await ensure().abort?.();
      emitState();
      return { aborted: true };
    },

    clearQueue: () => {
      const cleared = ensure().clearQueue?.() ?? null;
      emitState();
      return { cleared };
    },

    "state.get": () => snapshot(),

    "messages.get": (params) => {
      const input = asRecord(params);
      const limit =
        typeof input.limit === "number" && input.limit > 0 ? Math.floor(input.limit) : undefined;
      const messages = ensure().messages ?? [];
      return { messages: limit ? messages.slice(-limit) : messages, total: messages.length };
    },

    "stats.get": () => {
      const current = snapshot();
      return {
        messageCount: current.messageCount,
        toolCount: current.toolCount,
        model: current.model,
        thinkingLevel: current.thinkingLevel,
        streaming: current.streaming,
        pendingMessages: current.pendingMessages,
      };
    },

    "settings.get": () => {
      const settings = settingsManager?.get?.() ?? {};
      return { settings, errors: settingsManager?.drainErrors?.() ?? [] };
    },

    "settings.raw": () => ({ settings: settingsManager?.get?.() ?? {} }),

    "model.list": () => {
      const current = ensure();
      const scoped = (current as { scopedModels?: readonly unknown[] }).scopedModels ?? [];
      return { scoped, current: snapshot().model };
    },

    "model.set": async (params) => {
      const current = ensure();
      const input = asRecord(params);
      if (!input.model)
        throw new SessionCoreError("model.set requires a model object", "bad_request");
      if (!current.setModel)
        throw new SessionCoreError("model changes are not supported", "unsupported");
      await current.setModel(input.model, { persist: input.persist === true });
      emitState();
      return snapshot();
    },

    "thinking.levels": () => ({
      levels: snapshot().thinkingLevels,
      current: snapshot().thinkingLevel,
    }),

    "thinking.set": (params) => {
      const current = ensure();
      const level = requireString(asRecord(params).level, "level");
      current.setThinkingLevel?.(level, { persist: asRecord(params).persist === true });
      emitState();
      return snapshot();
    },

    "tools.list": () => {
      const current = ensure();
      const tools = (current as { getAllTools?: () => readonly unknown[] }).getAllTools?.() ?? [];
      return { tools, active: snapshot().activeTools };
    },

    "tools.setActive": (params) => {
      const current = ensure();
      const names = asRecord(params).names;
      if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) {
        throw new SessionCoreError("tools.setActive requires a names array", "bad_request");
      }
      current.setActiveToolsByName?.(names as string[]);
      emitState();
      return snapshot();
    },

    compact: async (params) => {
      const current = ensure();
      const instructions = asRecord(params).instructions;
      const result = await current.compact?.(
        typeof instructions === "string" ? instructions : undefined,
      );
      emitState();
      return { result: result ?? null, state: snapshot() };
    },
  };

  return {
    handlers: () => handlers,
    snapshot,
    session: () => session,
    cwd: () => cwd,
    dispose: async () => {
      unsubscribe?.();
      unsubscribe = null;
      await runtime?.dispose?.();
      runtime = null;
      session = null;
    },
  };
}

function openManager(
  deps: SessionCoreDeps,
  sessionFile: string,
  cwd: string,
): SessionManagerHandle {
  if (!deps.openSessionManager) {
    throw new SessionCoreError("resuming sessions is not configured", "unsupported");
  }
  return deps.openSessionManager(sessionFile, cwd, deps.sessionDir);
}
