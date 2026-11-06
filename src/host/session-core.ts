import type { HostMethod } from "../shared/host-protocol";
import { isDeepStrictEqual } from "node:util";
import {
  KEYBINDING_DEFINITIONS,
  resolveKeybindings as resolveEffectiveKeybindings,
} from "../shared/keybindings";
import {
  SCOPE_PATTERN_MAX_LENGTH,
  effectiveScopePatterns,
  hasExactScopeRef,
  normalizeScopePatterns,
  scopeKeys,
  scopeWriteTarget,
} from "../shared/model-scope";
import type { ScopeDiagnosticInfo, ScopeSnapshot } from "../shared/model-scope";
import type { ExtensionRuntimeErrorSummary } from "../shared/resources";
import type { SettingsScope } from "../shared/settings-schema";
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
import { createCommandHandlers, type CommandRunner } from "./commands";
import { createPromptOriginTracker } from "./prompt-origin";
import { createSettingsHandlers, SettingsError, type SettingsPort } from "./settings";
import { createShortcutHandlers, ShortcutError, type ShortcutRunner } from "./shortcuts";
import { createThemeHandlers, type ThemePort } from "./themes";
import {
  createKeybindingHandlers,
  parseKeybindingsDocument,
  type KeybindingPort,
} from "./keybindings";
import { buildResourcesSnapshot } from "./resources";
import type { FileListing } from "../workspace/file-listing";
import type { WorkspaceReadResult } from "../workspace/workspace-files";
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
  steer?(text: string, images?: unknown, options?: { source?: string }): Promise<unknown>;
  followUp?(text: string, images?: unknown, options?: { source?: string }): Promise<unknown>;
  abort?(): Promise<void>;
  clearQueue?(): ClearedQueue;
  executeBash?(
    command: string,
    onChunk?: (chunk: string) => void,
    options?: { excludeFromContext?: boolean; id?: string; operations?: unknown },
  ): Promise<BashResultLike>;
  /** Records a result an extension already produced (`user_bash` replacement). */
  recordBashResult?(
    command: string,
    result: BashResultLike,
    options?: { excludeFromContext?: boolean },
  ): void;
  abortBash?(): void;
  isBashRunning?: boolean;
  setModel?(model: unknown, options?: unknown): Promise<void>;
  cycleModel?(direction?: "forward" | "backward", options?: unknown): Promise<unknown>;
  setThinkingLevel?(level: string, options?: unknown): void;
  /** Returns the new level upstream; the host reports it through the snapshot. */
  cycleThinkingLevel?(options?: unknown): void;
  setActiveToolsByName?(names: string[]): void;
  setAutoCompactionEnabled?(enabled: boolean): void;
  setAutoRetryEnabled?(enabled: boolean): void;
  abortRetry?(): void;
  abortCompaction?(): void;
  abortBranchSummary?(): void;
  setSteeringMode?(mode: string): void;
  setFollowUpMode?(mode: string): void;
  getLastAssistantText?(): string | undefined;
  /** Models the user has scoped through `enabledModels`, with their own thinking level. */
  scopedModels?: readonly unknown[];
  /**
   * Replaces the live scope (Pi's `AgentSession.setScopedModels`). The model
   * dialog's star applies a scope edit to the running session without waiting
   * for a reload, so extension pickers and `cycleModel` see it immediately.
   */
  setScopedModels?(scopedModels: readonly unknown[]): void;
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
     * The entry-renderer lookup (`registerEntryRenderer`), used to tell the app
     * whether a bare `custom` entry has anything to display. Structural so the
     * core stays SDK-free.
     */
    getEntryRenderer?: (customType: string) => unknown;
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
  /** Pi's own JSONL export (plan step 14); synchronous and path-returning. */
  exportToJsonl?(outputPath?: string): string;
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

/** Pi's `BashResult`, structurally: `executeBash` resolves to exactly this. */
export interface BashResultLike {
  output: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
}

/**
 * Pi's `user_bash` hook (plan step 7): an extension may supply `operations` for
 * the real executor or replace the execution with its own `result`. The port
 * lives in `src/host/sdk/bash.ts`; the core only sees this narrow shape.
 */
export interface BashRunOutcome {
  operations?: unknown;
  result?: BashResultLike;
}

export interface BashPort {
  run(
    command: string,
    options: { excludeFromContext: boolean; cwd: string },
  ): Promise<BashRunOutcome>;
}

export interface RuntimeLike {
  get session(): HostSession;
  get services(): { settingsManager?: SettingsLike; cwd?: string };
  newSession?(options?: unknown): Promise<{ cancelled: boolean }>;
  switchSession?(path: string, options?: unknown): Promise<{ cancelled: boolean }>;
  clone?(options?: unknown): Promise<{ cancelled: boolean }>;
  fork?(entryId: string, options?: unknown): Promise<{ cancelled: boolean; selectedText?: string }>;
  /** JSONL import (plan step 14): replaces the live session from a file. */
  importFromJsonl?(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }>;
  setRebindSession?(rebind?: () => Promise<void>): void;
  dispose?(): Promise<void>;
}

export interface SettingsLike {
  /** Pi's `Settings` objects, forwarded verbatim (see the control core). */
  getGlobalSettings?(): PiPayload;
  getProjectSettings?(): PiPayload;
  /** The effective `enabledModels` after Pi's project-over-global merge. */
  getEnabledModels?(): string[] | undefined;
  reload?(): Promise<void>;
  flush?(): Promise<void>;
  drainErrors?(): unknown[];
}

/** One scope diagnostic, shared with the renderer's model-scope snapshot. */
export type ModelScopeDiagnosticInfo = ScopeDiagnosticInfo;

export interface ModelScopeResolution {
  scopedModels: readonly unknown[];
  diagnostics: readonly ModelScopeDiagnosticInfo[];
}

export interface ModelScopeToggleInput {
  patterns: readonly string[] | undefined;
  runtime: unknown;
  provider: string;
  id: string;
  enabled: boolean;
  /** The project settings toggle's target; absent means derive from the file. */
  scope?: SettingsScope;
}

export interface ModelScopeToggleResult extends ModelScopeResolution {
  /** `undefined` means "no scope": the handler deletes `enabledModels`. */
  patterns: string[] | undefined;
}

/**
 * The model-scope adapter (implemented in `src/host/sdk/model-scope.ts`).
 * Injected so this core stays SDK-free: it resolves `enabledModels` into models
 * and rewrites the pattern list for one star toggle.
 */
export interface ModelScopePort {
  resolve(patterns: readonly string[] | undefined, runtime: unknown): Promise<ModelScopeResolution>;
  toggle(input: ModelScopeToggleInput): Promise<ModelScopeToggleResult>;
}

export interface SessionRuntimeRequest {
  cwd: string;
  agentDir: string;
  sessionManager: SessionManagerHandle;
  npmCommand?: readonly string[] | null;
  /** Safe mode (plan step 22): load no third-party extensions/skills/prompts/themes. */
  safeMode?: boolean;
  /** Whether the project is trusted, so its `.pi/settings.json` may be read. */
  projectTrusted?: boolean;
  /**
   * The bundled checkpoint extension's path (git-checkpoint plan step 24). The
   * composition root resolves it next to the host bundle; safe mode ignores it.
   */
  checkpointsExtensionPath?: string | null;
}

export interface SessionCoreDeps {
  cwd: string;
  agentDir: string;
  sessionDir?: string;
  npmCommand?: readonly string[] | null;
  /** Safe mode (plan step 22): the runtime is built with every loader disabled. */
  safeMode?: boolean;
  /** The bundled checkpoint extension (git-checkpoint plan step 24). Safe mode wins. */
  checkpointsExtensionPath?: string | null;
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
  /**
   * Workspace files for `@` completion (plan step 7). The root is this host's
   * own cwd, never a renderer-supplied path, so the listing cannot escape the
   * session it belongs to.
   */
  listFiles?(cwd: string, options: { limit?: number }): Promise<FileListing>;
  /**
   * Reads one workspace file for `files.read` (plan step 23). The root is this
   * host's own cwd and the injected implementation enforces path containment
   * (lexical + symlink), so a renderer-supplied path cannot leave the session.
   */
  readWorkspaceFile?(
    cwd: string,
    path: string,
    options?: { limit?: number },
  ): Promise<WorkspaceReadResult>;
  /**
   * Writes one workspace file for `files.write` (plan step 23), with the same
   * containment rule as `readWorkspaceFile`.
   */
  writeWorkspaceFile?(
    cwd: string,
    path: string,
    text: string,
  ): Promise<{ path: string; relativePath: string; bytes: number }>;
  /**
   * Injected by the extension UI host (plan step 16). Receives the live session
   * *and* its runtime: binding an extension's UI context needs the runtime's
   * session-replacement commands (`newSession`/`fork`/`switchSession`), which do
   * not live on the session itself.
   */
  bindSession?(session: HostSession, runtime: RuntimeLike): Promise<void>;
  /**
   * Observes extension-driven model/thinking selections (workflow `/profile`,
   * role switches). Pi announces `model_select` only on the extension runner,
   * never on the session's subscriber stream, so the core needs this port to
   * refresh its state snapshot. The returned disposer restores the runner and
   * is called on rebind and dispose.
   */
  observeModelChanges?(session: HostSession, onChange: () => void): () => void;
  /**
   * Per-model supported thinking levels for `model.available` (2026-10-31 UI
   * plan). The SDK adapter lives in `src/host/sdk/model-thinking.ts`; the core
   * stays SDK-free. Missing means the renderer simply has no preview.
   */
  describeModelThinking?(models: readonly unknown[]): Record<string, string[]>;
  /**
   * Settings writes (plan step 12). The composition root supplies the SDK port
   * built over this session's own manager, so `settings.set` here is visible to
   * the session without a second manager.
   */
  createSettingsPort?(manager: SettingsLike | null, cwd: string): SettingsPort;
  /**
   * The model-scope adapter. Session creation resolves the scope in
   * `src/host/sdk/index.ts`; this port is for the live edits
   * (`model.scope.apply` / `model.scope.toggle`).
   */
  modelScope?: ModelScopePort;
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
  /**
   * Wraps the session's live `extensionRunner` in the SDK command adapter
   * (2026-10-24 command parity plan). Lives in `src/host/sdk/*`; the core only
   * sees `CommandRunner`, so command execution and argument completion stay
   * testable with a fictitious runner.
   */
  wrapCommandRunner?(runner: unknown): CommandRunner | null;
  /**
   * Wraps the session's live `extensionRunner` in the SDK `user_bash` adapter
   * (plan step 7). Null means the runner has no hook and the host runs the
   * command itself, exactly as terminal Pi falls back when no extension
   * intercepts.
   */
  createBashPort?(session: HostSession): BashPort | null;
  /**
   * Pi's packaged changelog for `/changelog` (plan step 15). The SDK exports the
   * path, not the text, so the composition root reads it through the file port.
   */
  readChangelog?(): Promise<{ path: string; text: string | null }>;
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
  let unsubscribeModelChanges: (() => void) | null = null;
  let settingsManager: SettingsLike | null = null;
  // Pairs each accepted prompt/command with the user message it produces, so
  // the renderer can name the command instead of showing its expanded body.
  const promptOrigins = createPromptOriginTracker();

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
  let settingsPortCwd: string | null = null;
  let scopeFingerprint: string | null = null;
  const resolveSettingsPort = (): SettingsPort | null => {
    if (!deps.createSettingsPort) return null;
    if (!settingsPort || settingsPortManager !== settingsManager || settingsPortCwd !== cwd) {
      settingsPortManager = settingsManager;
      settingsPortCwd = cwd;
      settingsPort = deps.createSettingsPort(settingsManager, cwd);
    }
    return settingsPort;
  };
  const settingsSetHandler = createSettingsHandlers({
    resolvePort: resolveSettingsPort,
  }).handlers()["settings.set"];

  /**
   * The effective `enabledModels` for this session. Prefer the SDK manager's
   * merged getter (project over global); the document fallback keeps the core
   * usable with a narrow/fake settings manager.
   */
  const effectiveModelScope = (): string[] =>
    normalizeScopePatterns(
      settingsManager?.getEnabledModels?.() ??
        effectiveScopePatterns(readSettingsScopes(settingsManager)),
    );

  /**
   * Reloads settings and resolves the persisted scope into the live session.
   * Called after extensions' `session_start` (they may register models), on
   * `model.available` (opening the picker), and by `model.scope.apply` (focus,
   * Settings reload, another host's write). It never throws for a resolver
   * failure: a failed resolve keeps the previous live scope.
   */
  const reconcileModelScope = async (options: {
    reload: boolean;
  }): Promise<ScopeSnapshot | null> => {
    const current = session;
    if (!current) return null;
    if (options.reload) {
      try {
        const port = resolveSettingsPort();
        if (port) await port.reload(cwd);
        else await settingsManager?.reload?.();
      } catch {
        // Keep the cached settings: a stale scope beats a dead dialog.
      }
    }

    const scopes = readSettingsScopes(settingsManager);
    const enabledModels = normalizeScopePatterns(
      settingsManager?.getEnabledModels?.() ?? effectiveScopePatterns(scopes),
    );
    const source = scopeWriteTarget(scopes);
    let scoped = current.scopedModels ?? [];
    let diagnostics: ScopeDiagnosticInfo[] = [];

    if (deps.modelScope) {
      const resolution = await deps.modelScope.resolve(enabledModels, current.modelRuntime);
      diagnostics = [...resolution.diagnostics];
      if (!diagnostics.some((diagnostic) => diagnostic.code === "resolve-failed")) {
        scoped = resolution.scopedModels;
        current.setScopedModels?.(enabledModels.length === 0 ? [] : scoped);
      }
    }

    const snapshot: ScopeSnapshot = { enabledModels, scoped, source, diagnostics };
    const fingerprint = JSON.stringify({
      enabledModels,
      source,
      scoped: scopeKeys(scoped),
      diagnostics,
    });
    if (fingerprint !== scopeFingerprint) {
      scopeFingerprint = fingerprint;
      deps.emit("model_scope_changed", snapshot, current.sessionId ?? undefined);
    }
    return snapshot;
  };

  /**
   * Writes the scope to the chosen document. A failure throws before the live
   * session is touched, so a refused write can never leave `settings.json` and
   * the session scope disagreeing. The caller owns the target/expected pair.
   */
  const persistModelScope = async (
    patterns: string[] | undefined,
    expected: unknown,
    target: SettingsScope,
  ): Promise<void> => {
    const port = resolveSettingsPort();
    if (!port) {
      throw new SessionCoreError(
        "settings are not available; the model scope was not changed",
        "unsupported",
      );
    }
    await port.compareAndWrite(cwd, "enabledModels", expected, patterns, target);
  };

  /**
   * Adds one picked model to a non-empty persisted scope, using the same CAS
   * contract as the star. Empty scope means "every model is allowed", so it is
   * left empty (Pi's `_addPersistedDefaultToNonEmptyScope` does the same).
   */
  const appendScopeRef = async (target: SettingsScope, ref: string): Promise<void> => {
    const port = resolveSettingsPort();
    if (!port) {
      throw new SessionCoreError(
        "settings are not available; the model was not added to the scope",
        "unsupported",
      );
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await port.reload(cwd);
      const patterns = effectiveModelScope();
      if (patterns.length === 0 || hasExactScopeRef(patterns, ref)) return;
      const scopes = readSettingsScopes(settingsManager);
      const expected = asRecord(scopes[target]).enabledModels;
      try {
        await port.compareAndWrite(cwd, "enabledModels", expected, [...patterns, ref], target);
        return;
      } catch (error) {
        if (error instanceof SettingsError && error.code === "conflict" && attempt === 0) {
          continue;
        }
        throw error;
      }
    }
  };

  const requireModelScope = (current: HostSession): ModelScopePort => {
    if (!deps.modelScope) {
      throw new SessionCoreError("the model scope is not supported", "unsupported");
    }
    if (!current.setScopedModels) {
      throw new SessionCoreError("changing the model scope is not supported", "unsupported");
    }
    return deps.modelScope;
  };

  const scopeConflict = (): SessionCoreError =>
    new SessionCoreError(
      "the model scope changed on disk again; reopen the picker and retry",
      "conflict",
    );

  /** Events after which the app should refresh its state snapshot. */
  const STATE_EVENTS = new Set([
    "agent_start",
    "agent_end",
    "agent_settled",
    "queue_update",
    "compaction_start",
    "compaction_end",
    "auto_retry_start",
    "auto_retry_end",
    "summarization_retry_scheduled",
    "summarization_retry_attempt_start",
    "summarization_retry_finished",
    "message_end",
    "session_info_changed",
    // `setThinkingLevel` emits this on the session's own bus. It is the only
    // signal for a same-model thinking change (an extension re-applying a role
    // level), because `model_select` fires only when the model itself differs.
    "thinking_level_changed",
  ]);

  const emitState = (): void => {
    deps.emit("state", snapshot(), session?.sessionId ?? undefined);
  };

  /**
   * A bare `custom` entry is transcript content only when an extension
   * registered an entry renderer for its type — Pi's
   * `CustomEntryComponent.hasContent()`. The host is the only side that knows
   * the registry, so the event carries the answer; the renderer must not keep a
   * second copy. A throw or a missing runner is `false` (hide), never a card.
   */
  const withEntryRenderability = (
    current: HostSession,
    event: { type: string; [key: string]: unknown },
  ): { type: string; [key: string]: unknown } => {
    if (event.type !== "entry_appended") return event;
    const entry = asRecord(event.entry);
    if (entry.type !== "custom") return event;
    const customType = typeof entry.customType === "string" ? entry.customType : "";
    let renderable = false;
    if (customType.length > 0) {
      try {
        renderable = Boolean(current.extensionRunner?.getEntryRenderer?.(customType));
      } catch {
        renderable = false;
      }
    }
    return { ...event, entryRenderable: renderable };
  };

  /**
   * Adds the raw command that produced this user message (2026-10-26
   * composer/command-prompt plan). The tracker consumes exactly one dispatch per
   * user message; a plain prompt matches its own text and is consumed without a
   * tag. Never mutates the SDK event.
   */
  const withPromptOrigin = (event: {
    type: string;
    [key: string]: unknown;
  }): { type: string; [key: string]: unknown } => {
    if (event.type !== "message_start") return event;
    const message = asRecord(event.message);
    if (message.role !== "user") return event;
    const origin = promptOrigins.consumeUserMessage(textOf(message.content));
    return origin === null ? event : { ...event, promptOrigin: origin };
  };

  const attach = (next: HostSession): void => {
    unsubscribe?.();
    unsubscribeErrors?.();
    unsubscribeModelChanges?.();
    promptOrigins.reset();
    session = next;
    unsubscribeErrors = next.extensionRunner?.onError?.(recordRuntimeError) ?? null;
    // A broken observer must not prevent the session from opening; the state
    // still refreshes on the ordinary SDK events above.
    try {
      unsubscribeModelChanges = deps.observeModelChanges?.(next, emitState) ?? null;
    } catch {
      unsubscribeModelChanges = null;
    }
    const listener = (event: { type: string; [key: string]: unknown }): void => {
      const enriched = withPromptOrigin(withEntryRenderability(next, event));
      const frame = eventToFrame(enriched);
      deps.emit(frame.event, frame.payload, next.sessionId ?? undefined);
      if (event.type === "agent_settled") promptOrigins.settle();
      if (STATE_EVENTS.has(event.type)) emitState();
    };
    unsubscribe = next.subscribe ? next.subscribe(listener) : null;
  };

  const rebind = async (): Promise<void> => {
    if (!runtime) return;
    attach(runtime.session);
    settingsManager = runtime.services?.settingsManager ?? settingsManager;
    await deps.bindSession?.(runtime.session, runtime);
    scopeFingerprint = null;
    await reconcileModelScope({ reload: true });
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
        bashRunning: false,
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
      projectTrusted: trust.status(cwd).trusted,
      ...(deps.safeMode ? { safeMode: true } : {}),
      ...(deps.checkpointsExtensionPath
        ? { checkpointsExtensionPath: deps.checkpointsExtensionPath }
        : {}),
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
    scopeFingerprint = null;
    await reconcileModelScope({ reload: true });

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
      // `promptOrigin` is display metadata for a command prompt; it never reaches
      // the SDK message. `ack` is the renderer's opt-in to Pi's preflight
      // disposition (`agent-session.js:1676-1693`), so the composer does not wait
      // for the whole run before it clears.
      const rawOrigin = input.promptOrigin;
      if (
        rawOrigin !== undefined &&
        (typeof rawOrigin !== "string" ||
          rawOrigin.trim().length === 0 ||
          rawOrigin.trim().length > 400)
      ) {
        throw new SessionCoreError(
          "promptOrigin must be a non-empty string of at most 400 characters",
          "bad_request",
        );
      }
      if (input.ack !== undefined && input.ack !== "preflight") {
        throw new SessionCoreError('ack must be "preflight" when provided', "bad_request");
      }
      // A new prompt while idle supersedes any dispatch that never produced a
      // user message (a notify-only command); queued follow-ups are streaming
      // and are therefore never dropped here.
      if (current.isStreaming !== true) promptOrigins.dropStale();
      const pending = promptOrigins.rememberPrompt(
        typeof rawOrigin === "string" ? rawOrigin : null,
        text,
      );
      const options: Record<string, unknown> = {
        ...(input.images ? { images: input.images } : {}),
        ...(behavior ? { streamingBehavior: behavior } : {}),
        // Pi's RPC mode labels prompts this way; the checkpoint extension uses
        // it to distinguish user input from extension-originated messages.
        source: "rpc",
      };
      if (input.ack === "preflight") {
        return await new Promise<unknown>((resolve, reject) => {
          let settled = false;
          const finish = (disposition: string): void => {
            if (settled) return;
            settled = true;
            resolve({ ...snapshot(), disposition });
          };
          options.preflightResult = (disposition: string) => finish(disposition);
          let run: Promise<void>;
          try {
            run = current.prompt(text, options);
          } catch (error) {
            promptOrigins.forget(pending);
            reject(error);
            return;
          }
          run.then(
            () => {
              // Fake sessions and older SDKs settle here without the hook.
              if (!settled) finish("started");
            },
            (error: unknown) => {
              if (!settled) {
                promptOrigins.forget(pending);
                reject(error);
                return;
              }
              // Already acknowledged: a later run failure is a notice, not a
              // rejection of a request the renderer has resolved.
              deps.emit(
                "session_error",
                { message: error instanceof Error ? error.message : String(error) },
                current.sessionId ?? undefined,
              );
            },
          );
        });
      }
      try {
        await current.prompt(text, Object.keys(options).length > 0 ? options : undefined);
        return snapshot();
      } catch (error) {
        promptOrigins.forget(pending);
        throw error;
      }
    },

    steer: async (params) => {
      const current = ensure();
      const text = requireString(asRecord(params).text, "text");
      if (!current.steer) throw new SessionCoreError("steering is not supported", "unsupported");
      await current.steer(text, undefined, { source: "rpc" });
      return { queued: true };
    },

    followUp: async (params) => {
      const current = ensure();
      const text = requireString(asRecord(params).text, "text");
      if (!current.followUp)
        throw new SessionCoreError("follow-up is not supported", "unsupported");
      await current.followUp(text, undefined, { source: "rpc" });
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
        // Parity with terminal Pi (2026-10-20 startup-tab-cycle plan): Pi
        // resolves shortcuts against the *effective* config (documented
        // defaults with the user's overrides applied), not the raw user
        // document, so a user override of a reserved chord is honoured here
        // exactly the way the terminal honours it.
        return resolveEffectiveKeybindings(user, KEYBINDING_DEFINITIONS);
      },
    }).handlers(),
    // Extension commands (2026-10-24 command parity plan): `commands.run`
    // executes the live handler (including while streaming) and
    // `commands.complete` evaluates its `getArgumentCompletions` in the host.
    ...createCommandHandlers({
      resolveRunner: () => {
        const runner = session?.extensionRunner;
        if (!runner) return null;
        return deps.wrapCommandRunner?.(runner) ?? null;
      },
      emit: deps.emit,
      onRun: (name, args) => {
        if (session?.isStreaming !== true) promptOrigins.dropStale();
        promptOrigins.rememberCommand(`/${name}${args.length > 0 ? ` ${args}` : ""}`);
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

    // Workspace file access (plan step 23). Both handlers are rooted at the
    // session's own cwd; the injected port enforces containment, so the only
    // thing this layer does is reject a malformed request before it reaches it.
    "files.read": async (params) => {
      if (!deps.readWorkspaceFile) {
        throw new SessionCoreError("reading workspace files is not supported", "unsupported");
      }
      const input = asRecord(params);
      const path = requireString(input.path ?? input.file, "path");
      const rawLimit = input.limit;
      return deps.readWorkspaceFile(
        cwd,
        path,
        typeof rawLimit === "number" && Number.isFinite(rawLimit) ? { limit: rawLimit } : undefined,
      );
    },

    "files.write": async (params) => {
      if (!deps.writeWorkspaceFile) {
        throw new SessionCoreError("writing workspace files is not supported", "unsupported");
      }
      const input = asRecord(params);
      const path = requireString(input.path ?? input.file, "path");
      const text = input.text ?? input.content;
      if (typeof text !== "string") {
        throw new SessionCoreError("files.write requires text", "bad_request");
      }
      return deps.writeWorkspaceFile(cwd, path, text);
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
      ensure();
      // Terminal's RPC implements `/clone` as a fork at the leaf when the runtime
      // offers no `clone()` (`rpc-mode.js:490-499`), which is the case for the
      // SDK version this app runs. Same session semantics: a new file whose
      // parent is this one, positioned at the current leaf.
      if (!runtime?.clone) {
        if (!runtime?.fork) {
          throw new SessionCoreError("cloning is not supported by this runtime", "unsupported");
        }
        const leafId = manager?.getLeafId?.();
        if (!leafId) {
          throw new SessionCoreError("this session has no entry to clone from", "no_leaf");
        }
        const forked = await runtime.fork(leafId, { position: "at" });
        await rebind();
        return { ...snapshot(), cancelled: forked.cancelled };
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

    "session.exportJsonl": (params) => {
      const current = ensure();
      if (!current.exportToJsonl) {
        throw new SessionCoreError("exporting JSONL is not supported", "unsupported");
      }
      const outputPath = asRecord(params).outputPath;
      const path = current.exportToJsonl(
        typeof outputPath === "string" && outputPath.length > 0 ? outputPath : undefined,
      );
      return { path };
    },

    "session.importJsonl": async (params) => {
      ensure();
      const input = asRecord(params);
      const path = requireString(input.path ?? input.file, "path");
      if (!runtime?.importFromJsonl) {
        throw new SessionCoreError("importing a session is not supported", "unsupported");
      }
      const cwdOverride =
        typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : undefined;
      try {
        const result = await runtime.importFromJsonl(path, cwdOverride);
        await rebind();
        return { ...snapshot(), cancelled: result.cancelled };
      } catch (error) {
        // Pi's two documented import failures need actionable text: the renderer
        // shows this message verbatim in the import dialog / hint.
        const message = error instanceof Error ? error.message : String(error);
        const name = error instanceof Error ? error.name : "";
        if (name === "SessionImportFileNotFoundError" || /ENOENT|not found/i.test(message)) {
          throw new SessionCoreError(`The session file was not found: ${path}`, "not_found");
        }
        if (name === "MissingSessionCwdError" || /cwd/i.test(message)) {
          throw new SessionCoreError(
            `The imported session's working folder no longer exists. Open it or import with a cwd override.`,
            "missing_cwd",
          );
        }
        throw new SessionCoreError(`Importing ${path} failed: ${message}`, "import_failed");
      }
    },

    "session.changelog": async () => {
      ensure();
      if (!deps.readChangelog) {
        throw new SessionCoreError("the changelog is not available", "unsupported");
      }
      return deps.readChangelog();
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

    "session.abortCompaction": () => {
      ensure().abortCompaction?.();
      emitState();
      return { aborted: true };
    },

    "session.abortBranchSummary": () => {
      ensure().abortBranchSummary?.();
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

    "model.available": async () => {
      const current = ensure();
      const scopeState = await reconcileModelScope({ reload: true });
      // Parity with Pi's RPC `get_available_models`, which reads the runtime
      // snapshot; the scoped set is the fallback for a session without one.
      const catalog = current.modelRuntime?.getAvailableSnapshot?.() ?? [];
      const scoped = scopeState?.scoped ?? current.scopedModels ?? [];
      const models = catalog.length > 0 ? catalog : scoped;
      return {
        models,
        scoped,
        enabledModels: scopeState?.enabledModels ?? effectiveModelScope(),
        source: scopeState?.source ?? scopeWriteTarget(readSettingsScopes(settingsManager)),
        diagnostics: scopeState?.diagnostics ?? [],
        auth: providerAuthStatus(current, models),
        thinkingByModel: deps.describeModelThinking ? deps.describeModelThinking(models) : {},
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
    "bash.run": async (params) => {
      const input = asRecord(params);
      const command = requireString(input.command, "command").trim();
      if (command.length === 0) {
        throw new SessionCoreError("command must not be empty", "bad_request");
      }
      if (input.ack !== undefined && input.ack !== "started") {
        throw new SessionCoreError('ack must be "started" when provided', "bad_request");
      }
      const current = ensure();
      const executeBash = current.executeBash;
      if (!executeBash) {
        throw new SessionCoreError("running bash is not supported", "unsupported");
      }
      // `AgentSession.executeBash` is a class method that reads
      // `this._bashAbortControllers`; extracting it and calling it bare made
      // `this` undefined (the `!`/`!!` error). Keep the receiver explicitly so
      // a later "cleanup" cannot reintroduce the failure.
      const runBash: typeof executeBash = (command, onChunk, options) =>
        executeBash.call(current, command, onChunk, options);
      // Terminal Pi refuses a second command while one runs (`interactive-mode`
      // checks `session.isBashRunning`); the run is not queued, so a double
      // submit must say so instead of racing two shells.
      if (current.isBashRunning === true) {
        throw new SessionCoreError("a bash command is already running", "busy");
      }
      const excludeFromContext = input.excludeFromContext === true;
      const id = `bash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const sessionId = current.sessionId ?? undefined;
      const runCwd = runtime?.services?.cwd ?? cwd;

      // Pi's `user_bash` hook runs *before* execution: an extension may replace
      // the executor or the result (plan step 7, D7). A thrown hook means the
      // extension already reported the error; terminal Pi does not fall back.
      let outcome: BashRunOutcome = {};
      const port = deps.createBashPort?.(current) ?? null;
      if (port) {
        try {
          outcome = await port.run(command, { excludeFromContext, cwd: runCwd });
        } catch {
          return { cancelled: true, intercepted: true };
        }
      }

      const message = {
        id,
        role: "bashExecution",
        command,
        output: "",
        cancelled: false,
        truncated: false,
        timestamp: Date.now(),
        ...(excludeFromContext ? { excludeFromContext: true } : {}),
      };
      const finish = (result: BashResultLike): { result: BashResultLike } => {
        // An intercepted result never reached the session: record it so the
        // turn's context and the resumed transcript both contain the command.
        if (outcome.result) {
          current.recordBashResult?.(command, result, { excludeFromContext });
        }
        deps.emit(
          "message_end",
          {
            message: {
              ...message,
              output: result.output,
              exitCode: result.exitCode,
              cancelled: result.cancelled === true,
              truncated: result.truncated === true,
              ...(result.fullOutputPath ? { fullOutputPath: result.fullOutputPath } : {}),
            },
          },
          sessionId,
        );
        emitState();
        return { result };
      };
      const failAfterAck = (error: unknown): void => {
        deps.emit("message_end", { message: { ...message, cancelled: true } }, sessionId);
        deps.emit(
          "session_error",
          { message: error instanceof Error ? error.message : String(error) },
          sessionId,
        );
        emitState();
      };

      deps.emit("message_start", { message }, sessionId);

      if (input.ack === "started") {
        // The renderer clears the composer on submit; a long shell command must
        // not hold the host request (and its 30 s timeout) open. The final
        // `message_end`/state still arrive as events.
        if (outcome.result) {
          finish(outcome.result);
          return { started: true, id };
        }
        let execution: Promise<BashResultLike>;
        try {
          execution = runBash(command, undefined, {
            excludeFromContext,
            id,
            ...(outcome.operations === undefined ? {} : { operations: outcome.operations }),
          });
        } catch (error) {
          failAfterAck(error);
          return { started: true, id };
        }
        void execution.then(finish, failAfterAck);
        // `executeBash` runs synchronously up to its first await, so the state
        // frame already reports `bashRunning` and Esc can target the shell.
        emitState();
        return { started: true, id };
      }

      try {
        const result: BashResultLike =
          outcome.result ??
          (await runBash(command, undefined, {
            excludeFromContext,
            id,
            ...(outcome.operations === undefined ? {} : { operations: outcome.operations }),
          }));
        return finish(result);
      } catch (error) {
        deps.emit("message_end", { message: { ...message, cancelled: true } }, sessionId);
        emitState();
        throw error;
      }
    },
    "bash.abort": () => {
      ensure().abortBash?.();
      emitState();
      return { aborted: true };
    },

    "model.list": () => {
      const current = ensure();
      return { scoped: current.scopedModels ?? [], current: snapshot().model };
    },

    // Re-reads `enabledModels` from the settings file and applies it to this
    // session. Used after another host writes the scope (the Settings view), on
    // focus, and by every other open tab after a star toggle.
    "model.scope.apply": async () => {
      const current = ensure();
      requireModelScope(current);
      const state = await reconcileModelScope({ reload: true });
      if (!state) {
        throw new SessionCoreError("no session is open; call session.create first", "no_session");
      }
      emitState();
      return {
        enabledModels: state.enabledModels,
        scoped: state.scoped,
        source: state.source,
        diagnostics: state.diagnostics,
      };
    },

    // One star toggle: reload, resolve, rewrite from the persisted base, then
    // compare-and-write the chosen document. A concurrent terminal edit makes
    // the CAS (or the pre-write re-read) retry once instead of losing a model.
    "model.scope.toggle": async (params) => {
      const current = ensure();
      const scope = requireModelScope(current);
      const input = asRecord(params);
      const provider = requireString(input.provider, "provider").trim();
      const id = requireString(input.id, "id").trim();
      if (provider.length === 0 || id.length === 0 || provider.includes("/")) {
        throw new SessionCoreError("provider/id must name exactly one model", "bad_request");
      }
      const ref = `${provider}/${id}`;
      if (ref.length > SCOPE_PATTERN_MAX_LENGTH) {
        throw new SessionCoreError("the model reference is too long", "bad_request");
      }
      const explicit =
        input.scope === "project" || input.scope === "global" ? input.scope : undefined;
      const requested = input.enabled === true;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const port = resolveSettingsPort();
          if (!port) {
            throw new SessionCoreError(
              "settings are not available; the model scope was not changed",
              "unsupported",
            );
          }
          await port.reload(cwd);
          const scopes = readSettingsScopes(settingsManager);
          const patterns = effectiveModelScope();
          const target = explicit ?? scopeWriteTarget(scopes);
          const expected = asRecord(scopes[target]).enabledModels;

          const result = await scope.toggle({
            patterns,
            runtime: current.modelRuntime,
            provider,
            id,
            enabled: requested,
          });

          // The resolver can take a moment. Re-read before writing: a terminal
          // edit during that window must be merged by a retry, not overwritten.
          await port.reload(cwd);
          const fresh = readSettingsScopes(settingsManager);
          const freshTarget = explicit ?? scopeWriteTarget(fresh);
          const freshExpected = asRecord(fresh[freshTarget]).enabledModels;
          if (freshTarget !== target || !isDeepStrictEqual(freshExpected, expected)) {
            if (attempt === 0) continue;
            throw scopeConflict();
          }

          await persistModelScope(result.patterns, expected, target);
          const state = await reconcileModelScope({ reload: true });
          const snapshot = state ?? {
            enabledModels: result.patterns ?? [],
            scoped: result.patterns === undefined ? [] : result.scopedModels,
            source: target,
            diagnostics: result.diagnostics,
          };
          emitState();
          return {
            enabledModels: snapshot.enabledModels,
            scoped: snapshot.scoped,
            scope: target,
            diagnostics: snapshot.diagnostics,
          };
        } catch (error) {
          if (error instanceof SettingsError && error.code === "conflict") {
            if (attempt === 0) continue;
            throw scopeConflict();
          }
          throw error;
        }
      }
      throw scopeConflict();
    },

    "model.set": async (params) => {
      const current = ensure();
      const input = asRecord(params);
      if (!input.model)
        throw new SessionCoreError("model.set requires a model object", "bad_request");
      if (!current.setModel)
        throw new SessionCoreError("model changes are not supported", "unsupported");

      const persist = input.persist === true;
      const scope = input.scope === "project" || input.scope === "global" ? input.scope : undefined;
      if (persist && scope) {
        const model = asRecord(input.model);
        const provider =
          typeof model.provider === "string"
            ? model.provider
            : typeof model.providerId === "string"
              ? model.providerId
              : "";
        const id =
          typeof model.id === "string"
            ? model.id
            : typeof model.modelId === "string"
              ? model.modelId
              : "";
        if (provider.length === 0 || id.length === 0) {
          throw new SessionCoreError(
            "model.set requires a provider and id to persist the selection",
            "bad_request",
          );
        }
        const port = resolveSettingsPort();
        if (!port) {
          throw new SessionCoreError(
            "settings are not available; the model was not persisted",
            "unsupported",
          );
        }

        // Apply first so an auth/catalog failure never changes settings. The
        // SDK's own persist path writes global; this path writes our target.
        await current.setModel(input.model, { persist: false });
        await appendScopeRef(scope, `${provider}/${id}`);
        await port.writeMany(cwd, scope, {
          defaultProvider: provider,
          defaultModel: id,
        });
        await reconcileModelScope({ reload: true });
        emitState();
        return snapshot();
      }

      await current.setModel(input.model, { persist });
      if (persist) await reconcileModelScope({ reload: true });
      emitState();
      return snapshot();
    },

    "thinking.levels": () => ({
      levels: snapshot().thinkingLevels,
      current: snapshot().thinkingLevel,
    }),

    "thinking.set": async (params) => {
      const current = ensure();
      const input = asRecord(params);
      const level = requireString(input.level, "level");
      const persist = input.persist === true;
      const scope = input.scope === "project" || input.scope === "global" ? input.scope : undefined;
      if (persist && scope) {
        const port = resolveSettingsPort();
        if (!port) {
          throw new SessionCoreError(
            "settings are not available; the thinking level was not persisted",
            "unsupported",
          );
        }
        current.setThinkingLevel?.(level, { persist: false });
        await port.writeMany(cwd, scope, { defaultThinkingLevel: level });
      } else {
        current.setThinkingLevel?.(level, { persist });
      }
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
      promptOrigins.reset();
      unsubscribe?.();
      unsubscribe = null;
      unsubscribeErrors?.();
      unsubscribeErrors = null;
      unsubscribeModelChanges?.();
      unsubscribeModelChanges = null;
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
  const keyOf = (entry: unknown): { id: string | null; key: string | null } => {
    const record = asRecord(entry);
    const inner =
      record.model && typeof record.model === "object" ? asRecord(record.model) : record;
    const id = typeof inner.id === "string" ? inner.id : null;
    const provider = typeof inner.provider === "string" ? inner.provider : null;
    if (!id) return { id: null, key: null };
    return { id, key: `${provider ?? ""}/${id}` };
  };
  // Exact `provider/id` first, so a bare id can never steal another provider's model.
  const exact = catalog.find((entry) => keyOf(entry).key === wanted);
  if (exact) {
    await session.setModel(exact, { persist: false });
    return true;
  }
  // Bare ids only resolve when unambiguous in this catalog.
  const bare = catalog.filter((entry) => keyOf(entry).id === wanted);
  if (bare.length !== 1 || !bare[0]) return false;
  await session.setModel(bare[0], { persist: false });
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
