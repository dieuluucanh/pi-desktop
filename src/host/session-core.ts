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
import type { FileListing } from "./file-listing";
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

/**
 * Opaque, Pi-owned payloads forwarded verbatim (session tree nodes, `Settings`
 * objects, statistics). Their fields belong to the SDK, so the host hands them
 * through instead of re-declaring a shape it would then have to keep in sync.
 */
export type PiPayload = object;

/** The narrow `AgentSession` surface the core drives. */
export interface HostSession extends SessionStateLike {
  subscribe?(listener: (event: { type: string; [key: string]: unknown }) => void): () => void;
  prompt(text: string, options?: unknown): Promise<void>;
  steer?(text: string): Promise<void>;
  followUp?(text: string): Promise<void>;
  abort?(): Promise<void>;
  clearQueue?(): ClearedQueue;
  setModel?(model: unknown, options?: unknown): Promise<void>;
  cycleModel?(direction?: "forward" | "backward", options?: unknown): Promise<unknown>;
  setThinkingLevel?(level: string, options?: unknown): void;
  /** Returns the new level upstream; the host reports it through the snapshot. */
  cycleThinkingLevel?(options?: unknown): void;
  setActiveToolsByName?(names: string[]): void;
  setAutoCompactionEnabled?(enabled: boolean): void;
  setAutoRetryEnabled?(enabled: boolean): void;
  abortRetry?(): void;
  setSteeringMode?(mode: string): void;
  setFollowUpMode?(mode: string): void;
  getLastAssistantText?(): string | undefined;
  /** Models the user has scoped through `enabledModels`, with their own thinking level. */
  scopedModels?: readonly unknown[];
  /**
   * Pi's `ModelRuntime`, reached the way the RPC mode does: the picker needs the
   * available catalog and the per-provider credential state (plan step 8), and
   * both are forwarded rather than re-derived from the environment.
   */
  modelRuntime?: {
    getAvailableSnapshot?(): readonly unknown[];
    getProviderAuthStatus?(
      providerId: string,
    ): { configured?: boolean; source?: string; label?: string } | undefined;
  };
  /** Command/template/skill sources, mirroring Pi's RPC `get_commands`. */
  extensionRunner?: { getRegisteredCommands?: () => readonly unknown[] };
  promptTemplates?: readonly unknown[];
  resourceLoader?: { getSkills?: () => { skills?: readonly unknown[] } };
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
  /** Session tree access for `entries.get` / `tree.get` / `session.forkMessages`. */
  getEntries?(): readonly unknown[];
  getBranch?(fromId?: string): readonly unknown[];
  getTree?(): PiPayload;
  getLeafId?(): string | undefined;
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
  clone?(options?: unknown): Promise<{ cancelled: boolean }>;
  fork?(entryId: string, options?: unknown): Promise<{ cancelled: boolean; selectedText?: string }>;
  setRebindSession?(rebind?: () => Promise<void>): void;
  dispose?(): Promise<void>;
}

export interface SettingsLike {
  /** Pi's `Settings` objects, forwarded verbatim (see the control core). */
  getGlobalSettings?(): PiPayload;
  getProjectSettings?(): PiPayload;
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
  /**
   * Workspace files for `@` completion (plan step 7). The root is this host's
   * own cwd, never a renderer-supplied path, so the listing cannot escape the
   * session it belongs to.
   */
  listFiles?(cwd: string, options: { limit?: number }): Promise<FileListing>;
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
        contextUsage: null,
        tokens: null,
        steeringMode: null,
        followUpMode: null,
        autoRetry: false,
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
    /** Per-project default applied only to a brand-new session (plan step 10). */
    model?: string;
    /** Per-project default thinking level for a brand-new session. */
    thinking?: string;
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
    // Per-project defaults (plan step 10) apply only to a *new* session: a
    // resumed session must keep the model and thinking level it recorded.
    if (options.model) await applyModel(created.session, options.model);
    if (options.thinking) {
      created.session.setThinkingLevel?.(options.thinking, { persist: false });
    }
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
      const model =
        typeof input.model === "string" && input.model.length > 0 ? input.model : undefined;
      const thinking =
        typeof input.thinking === "string" && input.thinking.length > 0
          ? input.thinking
          : undefined;
      const sessionManager = deps.newSessionManager
        ? deps.newSessionManager(targetCwd, deps.sessionDir)
        : {};
      return startSession({
        cwd: targetCwd,
        sessionManager,
        ...(trustAnswer ? { trustAnswer } : {}),
        ...(model ? { model } : {}),
        ...(thinking ? { thinking } : {}),
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
      const behavior = input.streamingBehavior;
      if (behavior !== undefined && behavior !== "steer" && behavior !== "followUp") {
        throw new SessionCoreError(
          'streamingBehavior must be "steer" or "followUp"',
          "bad_request",
        );
      }
      // Same rule as Pi's RPC mode: while streaming you must say what the message
      // is, otherwise the client cannot tell a steer from a follow-up.
      if (current.isStreaming === true && behavior === undefined) {
        throw new SessionCoreError(
          "the agent is already streaming; pass streamingBehavior to steer or follow up",
          "bad_request",
        );
      }
      const options = {
        ...(input.images ? { images: input.images } : {}),
        ...(behavior ? { streamingBehavior: behavior } : {}),
      };
      await current.prompt(text, Object.keys(options).length > 0 ? options : undefined);
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
        contextUsage: current.contextUsage,
        tokens: current.tokens,
        steeringMode: current.steeringMode,
        followUpMode: current.followUpMode,
        autoCompaction: current.autoCompaction,
        autoRetry: current.autoRetry,
        // The full SDK stats object (message/tool counts, tokens, cost).
        stats: readStats(ensure()),
      };
    },

    "entries.get": (params) => {
      const input = asRecord(params);
      const entries = [...(manager?.getEntries?.() ?? [])];
      const since = input.since;
      let slice = entries;
      if (typeof since === "string" && since.length > 0) {
        const index = entries.findIndex((entry) => asRecord(entry).id === since);
        if (index === -1) {
          throw new SessionCoreError(`no session entry with id ${since}`, "bad_request");
        }
        slice = entries.slice(index + 1);
      }
      return { entries: slice, leafId: manager?.getLeafId?.() ?? null };
    },

    "tree.get": () => ({
      tree: manager?.getTree?.() ?? [],
      leafId: manager?.getLeafId?.() ?? null,
    }),

    "commands.list": () => ({ commands: collectCommands(ensure()) }),

    "files.list": async (params) => {
      if (!deps.listFiles) {
        throw new SessionCoreError("listing workspace files is not supported", "unsupported");
      }
      const rawLimit = asRecord(params).limit;
      const listing = await deps.listFiles(
        cwd,
        typeof rawLimit === "number" && Number.isFinite(rawLimit) ? { limit: rawLimit } : {},
      );
      return { root: cwd, files: listing.files, truncated: listing.truncated };
    },

    "session.new": async (params) => {
      if (!runtime?.newSession) {
        throw new SessionCoreError("starting a new session is not supported", "unsupported");
      }
      const parent = asRecord(params).parentSession;
      const result = await runtime.newSession(
        typeof parent === "string" && parent.length > 0 ? { parentSession: parent } : undefined,
      );
      await rebind();
      return { ...snapshot(), cancelled: result.cancelled };
    },

    "session.switch": async (params) => {
      const input = asRecord(params);
      const sessionFile = requireString(input.sessionFile ?? input.path, "sessionFile");
      if (!runtime?.switchSession) {
        throw new SessionCoreError("switching sessions is not supported", "unsupported");
      }
      const result = await runtime.switchSession(sessionFile);
      await rebind();
      return { ...snapshot(), cancelled: result.cancelled };
    },

    "session.clone": async () => {
      if (!runtime?.clone) {
        throw new SessionCoreError("cloning is not supported by this runtime", "unsupported");
      }
      const result = await runtime.clone();
      await rebind();
      return { ...snapshot(), cancelled: result.cancelled };
    },

    "session.forkMessages": () => ({ messages: collectForkMessages(manager) }),

    "session.lastAssistantText": () => {
      const current = ensure();
      const text = current.getLastAssistantText?.();
      return { text: typeof text === "string" ? text : lastAssistantTextOf(current) };
    },

    "session.queueMode": (params) => {
      const input = asRecord(params);
      const mode = requireString(input.mode, "mode");
      if (mode !== "all" && mode !== "one-at-a-time") {
        throw new SessionCoreError('mode must be "all" or "one-at-a-time"', "bad_request");
      }
      const kind = input.kind === "followUp" ? "followUp" : "steering";
      const current = ensure();
      if (kind === "followUp") current.setFollowUpMode?.(mode);
      else current.setSteeringMode?.(mode);
      emitState();
      return { kind, mode, state: snapshot() };
    },

    "session.autoCompaction": (params) => {
      const enabled = asRecord(params).enabled;
      if (typeof enabled !== "boolean") {
        throw new SessionCoreError("enabled must be a boolean", "bad_request");
      }
      ensure().setAutoCompactionEnabled?.(enabled);
      emitState();
      return snapshot();
    },

    "session.autoRetry": (params) => {
      const enabled = asRecord(params).enabled;
      if (typeof enabled !== "boolean") {
        throw new SessionCoreError("enabled must be a boolean", "bad_request");
      }
      ensure().setAutoRetryEnabled?.(enabled);
      emitState();
      return snapshot();
    },

    "session.abortRetry": () => {
      ensure().abortRetry?.();
      emitState();
      return { aborted: true };
    },

    "model.cycle": async (params) => {
      const input = asRecord(params);
      const current = ensure();
      if (!current.cycleModel) {
        throw new SessionCoreError("cycling models is not supported", "unsupported");
      }
      await current.cycleModel(input.direction === "backward" ? "backward" : "forward", {
        persist: input.persist === true,
      });
      emitState();
      return snapshot();
    },

    "thinking.cycle": (params) => {
      ensure().cycleThinkingLevel?.({ persist: asRecord(params).persist === true });
      emitState();
      return snapshot();
    },

    "model.available": () => {
      const current = ensure();
      // Parity with Pi's RPC `get_available_models`, which reads the runtime
      // snapshot; the scoped set is the fallback for a session without one.
      const catalog = current.modelRuntime?.getAvailableSnapshot?.() ?? [];
      const scoped = current.scopedModels ?? [];
      const models = catalog.length > 0 ? catalog : scoped;
      return {
        models,
        scoped,
        auth: providerAuthStatus(current, models),
        thinkingLevels: snapshot().thinkingLevels,
        current: snapshot().model,
      };
    },

    "settings.get": () => ({
      settings: readSettingsScopes(settingsManager),
      errors: settingsManager?.drainErrors?.() ?? [],
    }),

    "settings.raw": () => ({ settings: readSettingsScopes(settingsManager) }),

    "settings.flush": async () => {
      await settingsManager?.flush?.();
      return { flushed: true, errors: settingsManager?.drainErrors?.() ?? [] };
    },

    // Pi's manager exposes named setters, not a generic set(key, value); the
    // per-key schema and writers belong to the settings mirror (step 12).
    "settings.set": () =>
      notImplemented("settings.set", "the per-key settings schema lands in step 12"),
    "session.delete": () =>
      notImplemented("session.delete", "the app deletes session files to the OS trash (step 11)"),
    "session.exportHtml": () =>
      notImplemented("session.exportHtml", "HTML export lands with the session browser (step 11)"),
    "bash.run": () =>
      notImplemented("bash.run", "direct bash runs land with the composer (step 6)"),
    "bash.abort": () =>
      notImplemented("bash.abort", "direct bash runs land with the composer (step 6)"),

    "model.list": () => {
      const current = ensure();
      return { scoped: current.scopedModels ?? [], current: snapshot().model };
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

/**
 * Resolves a `provider/id` (or bare `id`) default against the session's own model
 * catalog and applies it without persisting (plan step 10). Returns false when
 * the catalog does not offer it — a project default must never invent a model.
 */
async function applyModel(session: HostSession, wanted: string): Promise<boolean> {
  if (!session.setModel) return false;
  const catalog = session.modelRuntime?.getAvailableSnapshot?.() ?? session.scopedModels ?? [];
  const match = catalog.find((entry) => {
    const record = asRecord(entry);
    const inner =
      record.model && typeof record.model === "object" ? asRecord(record.model) : record;
    const id = typeof inner.id === "string" ? inner.id : null;
    const provider = typeof inner.provider === "string" ? inner.provider : null;
    if (!id) return false;
    return `${provider ?? ""}/${id}` === wanted || id === wanted;
  });
  if (!match) return false;
  await session.setModel(match, { persist: false });
  return true;
}

/** A handler that is deliberately not wired yet, with the step that owns it. */
function notImplemented(method: string, note: string): never {
  throw new SessionCoreError(`${method} is not implemented yet: ${note}`, "not_implemented");
}

/**
 * Per-provider credential state for the model picker's auth badges (plan step 8).
 * Reported from Pi's own runtime, so "Sign in" reflects what Pi knows instead of
 * the app guessing from an environment variable's presence.
 */
function providerAuthStatus(
  session: HostSession,
  models: readonly unknown[],
): Record<string, unknown> {
  const runtime = session.modelRuntime;
  if (!runtime?.getProviderAuthStatus) return {};
  const statuses: Record<string, unknown> = {};
  for (const model of models) {
    const provider = asRecord(model).provider;
    if (typeof provider !== "string" || provider.length === 0) continue;
    if (provider in statuses) continue;
    statuses[provider] = runtime.getProviderAuthStatus(provider) ?? null;
  }
  return statuses;
}

/**
 * Both settings scopes, never a merged object: Pi keeps global and project
 * settings apart with nested-merge semantics, and the settings UI (step 12)
 * needs to show and edit each scope.
 */
function readSettingsScopes(manager: SettingsLike | null): {
  global: PiPayload;
  project: PiPayload;
} {
  return {
    global: manager?.getGlobalSettings?.() ?? {},
    project: manager?.getProjectSettings?.() ?? {},
  };
}

/** Pi's `SessionStats` object, forwarded verbatim (its fields belong to Pi). */
type SessionStatsSummary = object;

/** The full SDK stats object, or null when the session cannot report it. */
function readStats(session: HostSession): SessionStatsSummary | null {
  const stats = (session as { getSessionStats?: () => SessionStatsSummary }).getSessionStats;
  if (typeof stats !== "function") return null;
  try {
    return stats.call(session) ?? null;
  } catch {
    return null;
  }
}

/**
 * Slash commands exactly as Pi's RPC `get_commands` builds them: extension
 * commands, then prompt templates, then skills (prefixed `skill:`).
 */
function collectCommands(session: HostSession): unknown[] {
  const commands: unknown[] = [];
  for (const command of session.extensionRunner?.getRegisteredCommands?.() ?? []) {
    const record = asRecord(command);
    commands.push({
      name: record.invocationName ?? record.name,
      description: record.description,
      source: "extension",
      sourceInfo: record.sourceInfo,
    });
  }
  for (const template of session.promptTemplates ?? []) {
    const record = asRecord(template);
    commands.push({
      name: record.name,
      description: record.description,
      argumentHint: record.argumentHint,
      source: "prompt",
      sourceInfo: record.sourceInfo,
    });
  }
  for (const skill of session.resourceLoader?.getSkills?.().skills ?? []) {
    const record = asRecord(skill);
    commands.push({
      name: `skill:${String(record.name ?? "")}`,
      description: record.description,
      source: "skill",
      sourceInfo: record.sourceInfo,
    });
  }
  return commands;
}

/** Text of a message content field (string or text blocks). */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (asRecord(block).type === "text" ? String(asRecord(block).text ?? "") : ""))
    .join("")
    .trim();
}

/**
 * User messages available for forking (Pi's `get_fork_messages`): the entries of
 * the active branch that are user messages, with the ids the fork call needs.
 */
function collectForkMessages(
  manager: SessionManagerHandle | null,
): Array<{ entryId: string; text: string }> {
  const entries = manager?.getBranch?.() ?? manager?.getEntries?.() ?? [];
  const messages: Array<{ entryId: string; text: string }> = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    const message = asRecord(record.message);
    if (record.type !== "message" || message.role !== "user") continue;
    const text = textOf(message.content);
    if (typeof record.id === "string" && text.length > 0) {
      messages.push({ entryId: record.id, text });
    }
  }
  return messages;
}

/** Fallback for `session.lastAssistantText` when the session does not provide it. */
function lastAssistantTextOf(session: HostSession): string {
  const messages = session.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (message.role !== "assistant") continue;
    const text = textOf(message.content);
    if (text.length > 0) return text;
  }
  return "";
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
