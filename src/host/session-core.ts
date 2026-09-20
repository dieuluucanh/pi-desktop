import type { HostMethod } from "../shared/host-protocol";
import type { ExtensionRuntimeErrorSummary } from "../shared/resources";
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
import { createSettingsHandlers, type SettingsPort } from "./settings";
import { createShortcutHandlers, ShortcutError, type ShortcutRunner } from "./shortcuts";
import { createThemeHandlers, type ThemePort } from "./themes";
import {
  createKeybindingHandlers,
  parseKeybindingsDocument,
  type KeybindingPort,
} from "./keybindings";
import { buildResourcesSnapshot } from "./resources";
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
  extensionRunner?: {
    getRegisteredCommands?: () => readonly unknown[];
    /**
     * Live `extension_error` history (plan step 13): Pi reports an error an
     * extension threw while handling an event, which a loader error cannot show.
     */
    onError?: (listener: (error: unknown) => void) => () => void;
    /**
     * Extension-registered shortcuts (plan step 15). The composition root
     * wraps this in an SDK adapter; the core only checks presence and
     * forwards it opaquely, so the fields stay `unknown` and any SDK shape
     * satisfies them.
     */
    getShortcuts?: unknown;
    getShortcutDiagnostics?: unknown;
    createContext?: unknown;
  };
  promptTemplates?: readonly unknown[];
  resourceLoader?: {
    getSkills?: () => { skills?: readonly unknown[] };
    /** The four loader collections the Extensions hub reports (plan step 13). */
    getExtensions?: () => unknown;
    getPrompts?: () => unknown;
    getThemes?: () => unknown;
  };
  compact?(instructions?: string): Promise<unknown>;
  reload?(options?: unknown): Promise<void>;
  /** Blocks until the session is idle; `ExtensionCommandContextActions.waitForIdle`. */
  waitForIdle?(): Promise<void>;
  /**
   * Branch navigation inside the session file (plan step 11): unlike `fork`,
   * which creates a new JSONL, this moves the leaf in place. The session owns it
   * because it also refreshes agent state and emits the SDK's `session_tree`
   * event, which the TUI selector relies on.
   */
  navigateTree?(
    targetId: string,
    options?: {
      summarize?: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
      label?: string;
    },
  ): Promise<{ editorText?: string; cancelled: boolean }>;
  /** Exports the session to a standalone HTML file; returns the written path. */
  exportToHtml?(outputPath?: string, options?: { themeName?: string }): Promise<string>;
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
  /** Sets or clears a display label on a tree entry (plan step 11). */
  appendLabelChange?(targetId: string, label: string | undefined): string;
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
  /** Safe mode (plan step 22): load no third-party extensions/skills/prompts/themes. */
  safeMode?: boolean;
}

export interface SessionCoreDeps {
  cwd: string;
  agentDir: string;
  sessionDir?: string;
  npmCommand?: readonly string[] | null;
  /** Safe mode (plan step 22): the runtime is built with every loader disabled. */
  safeMode?: boolean;
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
  /**
   * Injected by the extension UI host (plan step 16). Receives the live session
   * *and* its runtime: binding an extension's UI context needs the runtime's
   * session-replacement commands (`newSession`/`fork`/`switchSession`), which do
   * not live on the session itself.
   */
  bindSession?(session: HostSession, runtime: RuntimeLike): Promise<void>;
  /**
   * Settings writes (plan step 12). The composition root supplies the SDK port
   * built over this session's own manager, so `settings.set` here is visible to
   * the session without a second manager.
   */
  createSettingsPort?(manager: SettingsLike | null): SettingsPort;
  /**
   * Theme catalogue (plan step 15). Built over the session's own manager and
   * loader when a session is open, so the active theme and project themes are
   * the running truth; null answers `not_implemented`.
   */
  createThemePort?(input: { manager: unknown; loader: unknown }): ThemePort | null;
  /**
   * Profile keybindings (plan step 15). `keybindings.json` is profile-wide,
   * so one port serves the whole host process.
   */
  keybindingPort?: KeybindingPort;
  /**
   * Wraps the session's live `extensionRunner` in the SDK shortcut adapter
   * (plan step 15). Lives in `src/host/sdk/*`; the core only sees
   * `ShortcutRunner`.
   */
  wrapShortcutRunner?(runner: unknown): ShortcutRunner | null;
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
  let unsubscribeErrors: (() => void) | null = null;
  let settingsManager: SettingsLike | null = null;

  /**
   * Bounded `extension_error` history for the Extensions hub (plan step 13). Pi
   * reports an error an extension threw while handling an event, which is a
   * different (and more actionable) signal than a load error.
   */
  const runtimeErrors: ExtensionRuntimeErrorSummary[] = [];
  const recordRuntimeError = (error: unknown): void => {
    const record = asRecord(error);
    const message =
      typeof record.error === "string"
        ? record.error
        : error instanceof Error
          ? error.message
          : String(error);
    const stack =
      typeof record.stack === "string"
        ? record.stack
        : error instanceof Error
          ? error.stack
          : undefined;
    runtimeErrors.unshift({
      extensionPath: typeof record.extensionPath === "string" ? record.extensionPath : "",
      event: typeof record.event === "string" ? record.event : "unknown",
      error: message,
      ...(stack ? { stack } : {}),
      at: deps.now?.() ?? Date.now(),
    });
    if (runtimeErrors.length > 50) runtimeErrors.length = 50;
  };

  /**
   * Settings writes (plan step 12) are built lazily over whichever manager is
   * current, so a session replacement (`rebind`) picks up the new one.
   */
  let settingsPort: SettingsPort | null = null;
  let settingsPortManager: SettingsLike | null = null;
  const resolveSettingsPort = (): SettingsPort | null => {
    if (!deps.createSettingsPort) return null;
    if (!settingsPort || settingsPortManager !== settingsManager) {
      settingsPortManager = settingsManager;
      settingsPort = deps.createSettingsPort(settingsManager);
    }
    return settingsPort;
  };
  const settingsSetHandler = createSettingsHandlers({
    resolvePort: resolveSettingsPort,
  }).handlers()["settings.set"];

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
    unsubscribeErrors?.();
    session = next;
    unsubscribeErrors = next.extensionRunner?.onError?.(recordRuntimeError) ?? null;
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
    await deps.bindSession?.(runtime.session, runtime);
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
      ...(deps.safeMode ? { safeMode: true } : {}),
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
    await deps.bindSession?.(created.session, created.runtime);

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

    // The Extensions hub (plan step 13): what this session actually loaded, with
    // provenance, contributions and errors. A session host answers from its live
    // resource loader + extension runner, so the data is the running truth.
    "resources.list": () =>
      buildResourcesSnapshot({
        cwd,
        scope: "session",
        settings: readSettingsScopes(settingsManager),
        source: {
          extensions: session?.resourceLoader?.getExtensions?.(),
          skills: session?.resourceLoader?.getSkills?.(),
          prompts: session?.resourceLoader?.getPrompts?.(),
          themes: session?.resourceLoader?.getThemes?.(),
        },
        runtimeErrors,
        now: deps.now,
      }),

    // Skills, themes and keybindings (plan step 15). Themes come from the
    // session's own manager and loader when a session is open, so the active
    // theme and project themes are the running truth; keybindings are
    // profile-wide, so one port serves the whole host.
    ...createThemeHandlers({
      resolvePort: () =>
        deps.createThemePort?.({
          manager: settingsManager,
          loader: session?.resourceLoader?.getThemes?.() ?? null,
        }) ?? null,
    }).handlers(),
    ...createKeybindingHandlers({ resolvePort: () => deps.keybindingPort ?? null }).handlers(),
    // Extension shortcuts (plan step 15) only exist on a live session: the
    // handler runs with the runner's own extension context. Bindings resolve
    // through the keybinding port so a user remap is honoured.
    ...createShortcutHandlers({
      resolveRunner: () => {
        const runner = session?.extensionRunner;
        if (!runner?.getShortcuts) return null;
        return (
          deps.wrapShortcutRunner?.(runner) ?? {
            getShortcuts: () => new Map(),
            getShortcutDiagnostics: () => [],
            createContext: () => ({}),
            invokeShortcut: () => {
              throw new ShortcutError("shortcuts.invoke needs the SDK adapter");
            },
          }
        );
      },
      resolveKeybindings: async () => {
        if (!deps.keybindingPort) return {};
        const document = parseKeybindingsDocument(await deps.keybindingPort.read());
        const user: Record<string, unknown> = {};
        for (const [id, value] of Object.entries(document)) user[id] = value;
        return user;
      },
    }).handlers(),

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

    "session.exportHtml": async (params) => {
      const current = ensure();
      if (!current.exportToHtml) {
        throw new SessionCoreError("exporting this session is not supported", "unsupported");
      }
      const outputPath = asRecord(params).outputPath;
      const path = await current.exportToHtml(
        typeof outputPath === "string" && outputPath.length > 0 ? outputPath : undefined,
      );
      return { path };
    },

    "session.navigateTree": async (params) => {
      const current = ensure();
      const input = asRecord(params);
      const targetId = requireString(input.targetId ?? input.entryId ?? input.id, "targetId");
      if (!current.navigateTree) {
        throw new SessionCoreError("navigating the session tree is not supported", "unsupported");
      }
      const options: {
        summarize?: boolean;
        customInstructions?: string;
        replaceInstructions?: boolean;
        label?: string;
      } = {};
      if (input.summarize === true) options.summarize = true;
      if (typeof input.customInstructions === "string" && input.customInstructions.length > 0) {
        options.customInstructions = input.customInstructions;
      }
      if (input.replaceInstructions === true) options.replaceInstructions = true;
      if (typeof input.label === "string" && input.label.length > 0) options.label = input.label;
      const result = await current.navigateTree(
        targetId,
        Object.keys(options).length > 0 ? options : undefined,
      );
      await rebind();
      return {
        ...snapshot(),
        cancelled: result.cancelled,
        editorText: result.editorText ?? null,
      };
    },

    "session.setLabel": (params) => {
      const input = asRecord(params);
      const targetId = requireString(input.targetId ?? input.entryId ?? input.id, "targetId");
      if (!manager?.appendLabelChange) {
        throw new SessionCoreError("this session cannot store labels", "unsupported");
      }
      const rawLabel = input.label;
      if (rawLabel !== undefined && rawLabel !== null && typeof rawLabel !== "string") {
        throw new SessionCoreError("label must be a string or null", "bad_request");
      }
      const label =
        typeof rawLabel === "string" && rawLabel.trim().length > 0 ? rawLabel.trim() : undefined;
      manager.appendLabelChange(targetId, label);
      return { targetId, label: label ?? null };
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
    // port writes through a named setter when one exists and through an atomic,
    // schema-validated document edit otherwise (plan step 12).
    "settings.set":
      settingsSetHandler ??
      (() => notImplemented("settings.set", "the settings port is not configured")),
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
      unsubscribeErrors?.();
      unsubscribeErrors = null;
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
  global: Record<string, unknown>;
  project: Record<string, unknown>;
} {
  return {
    global: asRecord(manager?.getGlobalSettings?.() ?? {}),
    project: asRecord(manager?.getProjectSettings?.() ?? {}),
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
