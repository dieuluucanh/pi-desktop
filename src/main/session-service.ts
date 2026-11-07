import type { HostMethod, HostRole } from "../shared/host-protocol";
import { DEFAULT_REQUEST_TIMEOUT_MS, HostStoppedError, HostTimeoutError } from "./host-supervisor";
import type { CommandCompleteResult } from "../shared/commands";
import {
  appendIncident,
  createIncident,
  DEFAULT_INCIDENT_LIMIT,
  type DiagnosticsExtensionError,
  type DiagnosticsHostInfo,
  type Incident,
  type IncidentKind,
} from "../shared/diagnostics";
import type { TrustAnswer } from "../shared/projects";
import {
  COALESCE_BYTES,
  COALESCE_MS,
  DEFAULT_LIVE_HOSTS,
  type HostMemoryMetrics,
  type SessionCapacity,
} from "../shared/performance";
import { sanitizeWebUrl, webTabTitle } from "../shared/web-tabs";
import {
  isWorkspacePathWithin,
  isWorkspaceRelativePath,
  workspaceBasename,
} from "../shared/workspace";
import { sameFolder } from "../shared/rail-scope";
import { MAX_GRID_PANES } from "../shared/session-grid";
import { moveTabWithinPinGroup, partitionPinnedTabs } from "../shared/tab-order";
import { PI_OFFICE_BRIDGE } from "../shared/office";
import {
  CONTROL_TAB_ID,
  SESSION_ASLEEP_MESSAGE,
  isEditorTab,
  isHostBackedTab,
  isSessionBusyState,
  sanitizeTabs,
  sessionTitle,
  type CreateTabInput,
  type RetargetEditorTabsInput,
  type SessionEventEnvelope,
  type SessionEventEntry,
  type SessionStateEnvelope,
  type SessionTabsEnvelope,
  type TabKind,
  type TabRecord,
  type TabStatus,
  type TabStopReason,
} from "../shared/session-ipc";
import { collapseDuplicateSessionTabs, findTabBySessionFile } from "../shared/session-file";

/**
 * Methods whose answer scans the whole profile get more than the supervisor's
 * 30 s default. `session.list` reads every session JSONL once (and the control
 * host then caches it), so a several-hundred-megabyte profile can legitimately
 * take longer than an ordinary request.
 */
export const HOST_OPEN_TIMEOUT_MS = 90_000;

const REQUEST_TIMEOUT_OVERRIDES: Readonly<Partial<Record<HostMethod, number>>> = {
  "session.list": 120_000,
  "messages.get": 60_000,
  "tree.get": 60_000,
  // Opening a session loads its whole JSONL (multi-megabyte in a long-lived
  // profile) and boots the extension stack. 30 s was enough to time out a
  // healthy host and then look like "the session stopped responding"
  // (2026-11-06 hang plan).
  "session.create": HOST_OPEN_TIMEOUT_MS,
  "session.resume": HOST_OPEN_TIMEOUT_MS,
  "session.open": HOST_OPEN_TIMEOUT_MS,
};

export function requestTimeoutFor(
  method: HostMethod,
  fallbackMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): number {
  return REQUEST_TIMEOUT_OVERRIDES[method] ?? fallbackMs;
}

/**
 * The session service (plan step 3): the app's only way to reach a Pi host.
 *
 * One **control host** serves app-wide state (settings today; providers,
 * packages and file listings from step 4) and one **session host per tab** owns
 * exactly one Pi session (plan D-A3/D4). The renderer addresses a *tab*; this
 * service owns the tab table, spawns hosts lazily, coalesces the event storm into
 * ordered batches, and keeps the persisted tab list in step with what is running.
 *
 * It is Electron-free on purpose (architecture rule 1): the supervisor, the app
 * store, the clock and the id generator are injected, so the whole thing is unit
 * testable against a fake supervisor with no processes.
 */

/** Host id of the single control host. */
export const CONTROL_HOST_ID = CONTROL_TAB_ID;
export const DEFAULT_COALESCE_MS = COALESCE_MS;
export const DEFAULT_COALESCE_BYTES = COALESCE_BYTES;
/**
 * A tab used this recently is not a parking candidate even when it is idle:
 * the user is probably still at its keyboard, and a prompt can arrive in the
 * probe->stop window. All-busy overflow is preferred to a surprising sleep.
 */
const PARK_MIN_IDLE_MS = 5_000;

/**
 * Measured shape of delta batching (plan step 24): how many renderer pushes a
 * burst of streaming deltas actually produced, and why each batch flushed. The
 * Diagnostics view and the perf tests read it instead of inferring from logs.
 */
export interface CoalesceStats {
  /** Batches pushed to the renderer. */
  batches: number;
  /** Frame entries carried by those batches. */
  events: number;
  /** `message_update` entries among them (the storm the window exists for). */
  deltas: number;
  /** Batches flushed because the byte budget was hit. */
  bytesFlushes: number;
  /** Batches flushed by the window timer (the common case). */
  timerFlushes: number;
  /** The largest serialized batch observed. */
  maxBatchBytes: number;
}

/** The host identity a supervisor reports after its handshake (structural). */
export interface HostInfoLike {
  role?: HostRole;
  cwd?: string;
  sessionId?: string | null;
  startedAt?: number;
  pids?: { pid?: number };
  /** Build fingerprint reported by `host.hello` (2026-10-24 stale-host plan). */
  buildId?: string | null;
  /** Optional host features (git-checkpoint plan step 24); absent = unknown. */
  capabilities?: {
    checkpointsExtension?: boolean;
    checkpointExtensionSource?: "profile" | "package" | "bundled" | null;
  };
}

/** The narrow supervisor surface this service drives. */
export interface SupervisorHostLike {
  readonly sessionId: string;
  status(): string;
  request(method: HostMethod, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
  on(event: string, listener: (payload: unknown) => void): () => void;
  /** Host identity once ready (plan step 22). Optional for test doubles. */
  info?(): HostInfoLike | null;
  /** Last self-reported RSS sample (plan step 24). Optional for test doubles. */
  metrics?(): HostMemoryMetrics | null;
  /** Whether the host is pinned by policy (bridge owner/active/control). */
  pinned?(): boolean;
  /** Whether the host is ready with no request in flight. */
  isIdle?(): boolean;
  /** Why the supervisor last stopped this host. Optional for test doubles. */
  stopReason?(): TabStopReason | null;
  /** True when a protected host is over the RSS budget. Optional for doubles. */
  overMemory?(): boolean;
  /** Crash auto-restarts in this process lifetime. Optional for doubles. */
  restartCount?(): number;
  /** The last restart reason (`crash`, `manual`, …). Optional for doubles. */
  lastRestartReason?(): string | null;
  /** The tail of the host's own log (plan step 22). Optional for test doubles. */
  logs?(): string[];
  /** Service-level context (a retry reason) in the per-tab host log. */
  note?(message: string): void;
  shutdown(reason?: TabStopReason): Promise<void>;
}

export interface SupervisorLike {
  start(spec: {
    sessionId: string;
    cwd: string;
    role?: HostRole;
    officeHost?: boolean;
    sessionFile?: string | null;
  }): Promise<SupervisorHostLike>;
  get(sessionId: string): SupervisorHostLike | undefined;
  list(): SupervisorHostLike[];
  stop(sessionId: string, reason?: TabStopReason): Promise<void>;
  stopAll(): Promise<void>;
  /** Used/limit of the memory-derived host-process ceiling. Optional for test doubles. */
  capacity?(): { used: number; limit: number; atCapacity: boolean };
}

export interface SessionStoreLike {
  read(): Promise<{ tabs: unknown; activeTabId?: unknown }>;
  update(patch: { tabs?: unknown; activeTabId?: unknown }): Promise<unknown>;
}

export type SessionEmitChannel = "event" | "state" | "tabs";

export interface SessionServiceDeps {
  supervisor: SupervisorLike;
  store: SessionStoreLike;
  /** Working directory of the control host (it only reads app-wide state). */
  controlCwd: string;
  /** Pushes to the renderer; the main process maps these to IPC channels. */
  emit(channel: SessionEmitChannel, payload: unknown): void;
  /**
   * Called with the full tab table after every publish (2026-11-05 terminal
   * plan). The terminal service uses it to close PTYs whose tab disappeared,
   * including close-others/close-project paths it does not own. A listener must
   * never break publishing.
   */
  onTabsChanged?: (tabs: readonly TabRecord[]) => void;
  /**
   * Fingerprint of the host bundle currently on disk (2026-10-24 stale-host
   * plan). Absent in tests and when the bundle cannot be read; the stale check
   * is then skipped.
   */
  hostBuildId?: () => string | null;
  now?: () => number;
  newId?: () => string;
  /** Delta batching window for `message_update` (plan step 3). */
  coalesceMs?: number;
  /** Flush a delta batch early once it grows past this many bytes. */
  coalesceBytes?: number;
  /**
   * Soft target for live host processes, derived from total RAM by main. This
   * is not a session limit: idle sessions are parked before a new host starts,
   * and a new session still opens when every live session is busy.
   */
  maxLiveHosts?: number;
  /**
   * Aggregate host RSS budget, derived from total RAM by main. When the last
   * `host.metrics()` samples add up past this, `makeRoom` and the periodic
   * reclaim park idle hosts even while the live count is under target. 0 or
   * absent disables the guard.
   */
  hostRssLimitBytes?: number;
  /**
   * Makes the Office bridge port free before a promoted host binds it
   * (2026-10-30 project-scoped rail plan). It terminates whatever listens on the
   * port — including a process this app does not own — so the takeover the user
   * asked for cannot fail with "port is already in use".
   *
   * Injected rather than imported so this module stays Electron-free and the
   * tests can script the outcome. Absent in tests and in callers that have no
   * Office integration: promotion then behaves as it did before.
   */
  releaseOfficePort?: (input: {
    port: number;
    ownPids: readonly number[];
  }) => Promise<{ ok: boolean; detail?: string }>;
  /** PIDs this app owns, passed to the reclaimer so it never kills itself. */
  ownPids?: () => readonly number[];
  /** The bridge port; defaults to `PI_OFFICE_BRIDGE.defaultPort` (38617). */
  officeBridgePort?: number;
}

export interface SessionService {
  /** Lazily starts (and returns) the control host. */
  controlHost(): Promise<SupervisorHostLike>;
  tabs(): TabRecord[];
  activeTabId(): string | null;
  /**
   * Declares which tabs the renderer currently shows (the grid's panes, or the
   * solo tab). Advisory and cheap: it parks nothing and spawns nothing, it only
   * tells the parking policy which hosts must stay warm.
   */
  setVisibleTabs(ids: readonly string[]): void;
  /** The tabs the renderer last reported as visible (bounded). */
  visibleTabIds(): string[];
  envelope(): SessionTabsEnvelope;
  restoreTabs(): Promise<SessionTabsEnvelope>;
  createTab(input: CreateTabInput): Promise<SessionTabsEnvelope>;
  activateTab(tabId: string): Promise<SessionTabsEnvelope>;
  /**
   * Makes sure a tab has a live host and an open session *without* touching the
   * selection (2026-11-06 tab-switch plan). Selection belongs to an explicit
   * gesture; a background wake must never move the user's tab.
   */
  ensureTab(tabId: string): Promise<SessionTabsEnvelope>;
  /**
   * Clears the active tab without closing one (2026-10-30 project-scoped rail
   * plan). Every tab and every host stays exactly as it was; only the selection
   * is dropped, so a project with no open session can show Welcome while the
   * rail keeps that project's scope.
   */
  deactivate(): Promise<SessionTabsEnvelope>;
  /**
   * Makes the tab table truthful about host/session readiness after a suspend,
   * a lost process, or a renderer that missed pushes. It never spawns; the next
   * interaction/wake does that.
   */
  reconcile(): Promise<SessionTabsEnvelope>;
  closeTab(tabId: string): Promise<SessionTabsEnvelope>;
  /** Closes every non-pinned tab of `kind` (session, office, web or editor). */
  closeAll(kind: TabKind): Promise<SessionTabsEnvelope>;
  /** Closes every other non-pinned tab of the same kind. */
  closeOthers(tabId: string): Promise<SessionTabsEnvelope>;
  /** Closes every tab in a project, including pinned tabs (project removal). */
  closeForProject(cwd: string): Promise<SessionTabsEnvelope>;
  /** Pins/unpins a tab and keeps the pinned group at the front. */
  setPinned(tabId: string, pinned: boolean): Promise<SessionTabsEnvelope>;
  /** Updates open editor tabs after a rename/move of their file or folder. */
  retargetEditorTabs(input: RetargetEditorTabsInput): Promise<SessionTabsEnvelope>;
  /** Moves a tab to `toIndex`, persisted so the strip order survives a relaunch. */
  reorderTab(tabId: string, toIndex: number): Promise<SessionTabsEnvelope>;
  /**
   * Makes `tabId` the single Office host (plan step 20): demotes every other
   * `office`-kind tab and restarts this one so its host binds port 38617. The
   * session is resumed from its JSONL, so promoting never loses history.
   */
  promoteToOfficeHost(tabId: string): Promise<SessionTabsEnvelope>;
  request(tabId: string, method: HostMethod, params?: unknown): Promise<unknown>;
  /**
   * Stops a tab's host without touching its session file and leaves the tab
   * `stopped`; the next activation resumes it. This is the Cancel action for an
   * open that is taking too long (2026-11-06 hang plan).
   */
  stopTab(tabId: string): Promise<SessionTabsEnvelope>;
  /**
   * Stops and re-spawns a tab's host, resuming its session from the JSONL
   * (plan step 22). This is the recovery action for a crashed or wedged host.
   */
  restartTab(tabId: string): Promise<SessionTabsEnvelope>;
  /** Failures seen this run, newest first (plan step 22 Diagnostics). */
  incidents(): Incident[];
  /** Which host is behind each tab, plus its log tail (plan step 22 Diagnostics). */
  diagnosticsHosts(): DiagnosticsHostInfo[];
  /** Used/target/ceiling of the live-host budget (plan step 24 backpressure). */
  capacity(): SessionCapacity;
  /**
   * Parks idle hosts until the live count and aggregate RSS are back under
   * pressure (or no parkable candidate remains). Called by main's memory timer;
   * never throws and never stops the active, Office, bridge-owner or busy host.
   */
  reclaimHosts(): Promise<SessionCapacity>;
  /** Measured delta-batching figures (plan step 24). */
  coalesceStats(): CoalesceStats;
  /** Bounded `extension_error` history across tabs (plan step 22 Diagnostics). */
  extensionErrors(): DiagnosticsExtensionError[];
  /**
   * Re-spawns the last active tab in the background (plan step 24 pre-warm).
   * Resolves to true only when a session host actually became ready, so the
   * startup measurement is never recorded for a no-op pre-warm.
   */
  prewarmLast(): Promise<boolean>;
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

/** The fields of a host state snapshot this service cares about. */
interface SnapshotLike {
  sessionId?: unknown;
  sessionFile?: unknown;
  sessionName?: unknown;
  streaming?: unknown;
  model?: { id?: unknown } | null;
}

class SessionServiceError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * The service-level errors a host emits when it was built before the method
 * existed (2026-10-24 stale-host plan). A `CommandError` such as "open a
 * session first" also carries `not_implemented`, so the message prefix is what
 * distinguishes a stale bundle from an unavailable session.
 */
const MISSING_COMMAND_COMPLETE_MESSAGES = [
  "method not implemented yet: commands.complete",
  "unknown method: commands.complete",
] as const;

function isMissingCommandComplete(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name !== "not_implemented" && error.name !== "unknown_method") return false;
  return MISSING_COMMAND_COMPLETE_MESSAGES.some((message) => error.message.startsWith(message));
}

/** Errors that prove the request never reached a live session (safe to repair). */
function isSessionLostError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return (
    error.name === "no_session" ||
    error.name === "host_not_running" ||
    error instanceof HostStoppedError ||
    error.name === "host_stopped" ||
    code === "no_session" ||
    code === "host_not_running" ||
    code === "host_stopped"
  );
}

/**
 * True when the *process* went away (or stopped answering) before the session
 * could open, so a fresh process is a legitimate retry. A refusal such as a
 * trust prompt or a malformed request is not: it needs the user, not a respawn.
 */
function isRecoverableOpenError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return (
    error instanceof HostTimeoutError ||
    error instanceof HostStoppedError ||
    error.name === "host_stopped" ||
    error.name === "host_not_running" ||
    code === "host_stopped" ||
    code === "host_not_running"
  );
}

/** True when the host is already gone, regardless of what it last reported. */
function isHostGoneError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return (
    error instanceof HostStoppedError || error.name === "host_stopped" || code === "host_stopped"
  );
}

/** A host response that carries a session snapshot (create/open/resume/fork/new). */
function isSessionSnapshot(value: unknown): boolean {
  const record = asRecord(value);
  return (
    typeof record.sessionId === "string" ||
    typeof record.sessionFile === "string" ||
    typeof record.streaming === "boolean"
  );
}

/** Methods that establish/replace a session and must reach the host unchanged. */
const SESSION_ESTABLISHING_METHODS: ReadonlySet<string> = new Set([
  "session.create",
  "session.open",
  "session.resume",
  "session.new",
  "session.switch",
  "session.clone",
  "session.fork",
]);

/**
 * Reads that must never be the reason a stopped host is spawned.
 *
 * The renderer sends `tui.resize` on every status change (the measured viewport
 * effect keys on the tab status), and `messages.get`/`shortcuts.list`/`oi.state`
 * are retried by view effects. Without this guard, an RSS/idle recycle is
 * immediately undone by a passive read: status `stopped` -> resize -> ensure ->
 * spawn -> the same large host -> recycle again (2026-11-06 Strata loop).
 * Only an explicit activation/ensure, a prompt or a lifecycle command may wake
 * a stopped tab.
 */
const PASSIVE_METHODS: ReadonlySet<string> = new Set([
  "messages.get",
  "entries.get",
  "tree.get",
  "stats.get",
  "commands.list",
  "commands.complete",
  "shortcuts.list",
  "files.list",
  "oi.state",
  "tui.state",
  "tui.resize",
  "model.available",
  "render.request",
  "render.markdown",
]);

/** Repair-and-retry is safe only for methods that cannot change user state. */
const READ_ONLY_RETRY_METHODS: ReadonlySet<string> = new Set([
  "state.get",
  "messages.get",
  "entries.get",
  "tree.get",
  "stats.get",
  "commands.list",
  "commands.complete",
  "shortcuts.list",
  "oi.state",
  "tui.state",
]);

/** Normalizes a supervisor event payload into a protocol entry. */
function toEntry(payload: unknown): SessionEventEntry | null {
  const record = asRecord(payload);
  const event = typeof record.event === "string" ? record.event : null;
  if (!event) return null;
  const sessionId = typeof record.sessionId === "string" ? record.sessionId : null;
  const sessionEpoch =
    typeof record.sessionEpoch === "number" && Number.isFinite(record.sessionEpoch)
      ? record.sessionEpoch
      : undefined;
  return {
    event,
    ...("payload" in record ? { payload: record.payload } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(sessionEpoch === undefined ? {} : { sessionEpoch }),
  };
}

export function createSessionService(deps: SessionServiceDeps): SessionService {
  const now = deps.now ?? ((): number => Date.now());
  const newId = deps.newId ?? ((): string => `tab-${Math.random().toString(36).slice(2, 10)}`);
  const coalesceMs = deps.coalesceMs ?? DEFAULT_COALESCE_MS;
  const coalesceBytes = deps.coalesceBytes ?? DEFAULT_COALESCE_BYTES;
  const maxLiveHosts = Math.max(1, deps.maxLiveHosts ?? DEFAULT_LIVE_HOSTS);
  const maxHostRssBytes = Math.max(0, deps.hostRssLimitBytes ?? 0);

  /** Sum of the last `host.metrics()` samples across live hosts. */
  const hostRssBytes = (): number =>
    deps.supervisor.list().reduce((sum, host) => sum + (host.metrics?.()?.rssBytes ?? 0), 0);

  const tabs = new Map<string, TabRecord>();
  const hosts = new Map<string, SupervisorHostLike>();
  /**
   * In-flight *process* starts, so two callers cannot spawn two children for
   * one tab. This is the old `spawning` coalescer and does not imply a session
   * is open (explicit `session.create` uses it directly).
   */
  const starting = new Map<string, Promise<SupervisorHostLike>>();
  /**
   * In-flight session opens/resumes, separate from process starts. A tab can
   * have a live host that is not session-ready (crash restart, failed resume,
   * trust retry); only this map coalesces the reopen.
   *
   * The generation is part of the entry because `detachHost` bumps it while an
   * open is still running. The entry must survive that bump: deleting it let a
   * second caller start a second open during the retry window, which is how a
   * tab produced two `session.resume` calls 6 ms apart and a spurious session
   * replacement (2026-11-06 Strata loop). A caller either joins the current
   * generation or waits for the stale run to settle before starting its own.
   */
  interface OpeningTransition {
    promise: Promise<SupervisorHostLike>;
    generation: number;
  }
  const opening = new Map<string, OpeningTransition>();
  /** Tabs whose host has confirmed `session.create`/`resume` / a state frame. */
  const sessionReady = new Set<string>();
  /**
   * The session identity currently allowed to write to a tab's transcript.
   * A reload can keep the same id, so the attachment epoch is the real fence;
   * an outgoing runner's late event must not land in the replacement session.
   */
  const sessionIdentities = new Map<string, { sessionId: string | null; epoch: number }>();
  /**
   * Per-tab generation, bumped by every detach. A late spawn/open compares it
   * and stops the process it just started instead of publishing a stale host.
   */
  const generations = new Map<string, number>();
  /** Bumped only by an explicit detach, so an open can tell cancel from repair. */
  const cancelEpochs = new Map<string, number>();
  /** Tabs recovering from an unexpected crash (drives the recovered notice). */
  const recovering = new Set<string>();
  /**
   * In-flight stop+respawn of a stale host, per tab (2026-10-24 stale-host
   * plan). Two completion requests from the same keystroke burst must share one
   * recycle, or they would stop each other's freshly spawned host.
   */
  const recycling = new Map<string, Promise<SupervisorHostLike>>();
  /** In-flight parking, per tab: a wake waits for the stop to settle first. */
  const parking = new Map<string, Promise<void>>();
  /** Serialized budget decisions, so two starts cannot park the same tab twice. */
  let slotQueue: Promise<void> = Promise.resolve();
  /** Per-tab `session.create` defaults (per-project model/thinking + trust, step 10). */
  const createParams = new Map<
    string,
    { model?: string; thinking?: string; trust?: TrustAnswer }
  >();
  const unsubscribes = new Map<string, Array<() => void>>();
  /** Subscriptions to the control host (provider login events, plan step 9). */
  const controlUnsubscribes: Array<() => void> = [];
  const pending = new Map<string, SessionEventEntry[]>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const sequences = new Map<string, number>();
  const coalesceStats: CoalesceStats = {
    batches: 0,
    events: 0,
    deltas: 0,
    bytesFlushes: 0,
    timerFlushes: 0,
    maxBatchBytes: 0,
  };
  /** Failures seen this run, newest first (plan step 22). */
  let incidents: Incident[] = [];
  /** Bounded `extension_error` history across every tab (plan step 22). */
  const extensionErrors: DiagnosticsExtensionError[] = [];
  let incidentCounter = 0;
  /** Per-tab start timestamps, used to name a restart loop instead of hiding it. */
  const startHistory = new Map<string, number[]>();
  /** Recycled/looped notices already recorded, so a loop does not flood the list. */
  const recordedRecycles = new Set<string>();
  const recordedLoops = new Set<string>();

  let activeId: string | null = null;
  /** Monotonic table version: bumped whenever a publish actually changes it. */
  let revision = 0;
  /**
   * Monotonic selection version. Only a selection change bumps it, and the
   * renderer compares it against its own gesture counter, so a push that merely
   * woke a host can never reassign the active tab (2026-11-06 tab-switch plan).
   */
  let selectionSeq = 0;
  /**
   * Tabs the renderer shows (2026-11-03 grid plan): the visible grid panes, or
   * the single solo tab. Bounded by the largest layout, because it comes from a
   * renderer push and is only ever a parking hint.
   */
  const visibleTabs = new Set<string>();
  let control: SupervisorHostLike | null = null;
  let disposed = false;

  const envelope = (): SessionTabsEnvelope => ({
    tabs: [...tabs.values()].map((tab) => ({ ...tab })),
    activeTabId: activeId,
    revision,
    selectionSeq,
  });

  /** The one writer of the selection, so every change carries a fresh sequence. */
  const selectTab = (id: string | null): void => {
    activeId = id;
    selectionSeq += 1;
  };

  /**
   * The last table handed to the renderer. A state frame that did not change a
   * rendered field (sessionFile/title/model/status) must not make the renderer
   * process the whole tab table; `applyTabs` also reuses unchanged records
   * (2026-11-03 plan step 10).
   */
  let lastPublishedTabs = "";

  const publishTabs = (force = false): void => {
    const next = envelope();
    // The signature covers the content only (never the counters), so an
    // unchanged table stays a no-op and a repeated publish cannot inflate the
    // revision. Serialising a handful of small records per state frame is cheap
    // and, unlike a field list, cannot forget a future TabRecord field.
    const signature = JSON.stringify({ tabs: next.tabs, activeTabId: next.activeTabId });
    if (!force && signature === lastPublishedTabs) return;
    lastPublishedTabs = signature;
    revision += 1;
    next.revision = revision;
    try {
      deps.onTabsChanged?.(next.tabs);
    } catch {
      // A tab-table observer must never break the table itself.
    }
    deps.emit("tabs", next);
  };

  const persist = async (): Promise<void> => {
    await deps.store.update({ tabs: [...tabs.values()], activeTabId: activeId });
  };

  const requireTab = (tabId: string): TabRecord => {
    const tab = tabs.get(tabId);
    if (!tab) throw new SessionServiceError(`unknown session tab: ${tabId}`, "unknown_tab");
    return tab;
  };

  const setStatus = (
    tab: TabRecord,
    status: TabStatus,
    error?: string,
    stop?: { reason: TabStopReason; at: number; memoryOverBudget?: boolean },
  ): void => {
    tab.status = status;
    if (error === undefined) delete tab.error;
    else tab.error = error;
    if (stop) {
      tab.stopReason = stop.reason;
      tab.stoppedAt = stop.at;
      if (stop.memoryOverBudget === true) tab.memoryOverBudget = true;
      else delete tab.memoryOverBudget;
    } else if (status === "idle" || status === "running") {
      delete tab.stopReason;
      delete tab.stoppedAt;
      delete tab.memoryOverBudget;
    }
    publishTabs();
  };

  const unrefTimer = (timer: ReturnType<typeof setTimeout>): void => {
    if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
  };

  const pushEntries = (tabId: string, entries: SessionEventEntry[]): void => {
    if (entries.length === 0) return;
    const seq = (sequences.get(tabId) ?? 0) + 1;
    sequences.set(tabId, seq);
    const identity = sessionIdentities.get(tabId);
    deps.emit("event", {
      tabId,
      seq,
      events: entries,
      ...(identity ? { sessionId: identity.sessionId, sessionEpoch: identity.epoch } : {}),
    } satisfies SessionEventEnvelope);
  };

  const flushPending = (
    tabId: string,
    reason: "timer" | "bytes" | "immediate" = "immediate",
  ): void => {
    const timer = timers.get(tabId);
    if (timer) {
      clearTimeout(timer);
      timers.delete(tabId);
    }
    const entries = pending.get(tabId);
    pending.delete(tabId);
    if (entries && entries.length > 0) {
      // Measurement (plan step 24): one push can carry hundreds of deltas.
      coalesceStats.batches += 1;
      coalesceStats.events += entries.length;
      for (const entry of entries) {
        if (entry.event === "message_update") coalesceStats.deltas += 1;
      }
      coalesceStats.maxBatchBytes = Math.max(
        coalesceStats.maxBatchBytes,
        JSON.stringify(entries).length,
      );
      if (reason === "bytes") coalesceStats.bytesFlushes += 1;
      else if (reason === "timer") coalesceStats.timerFlushes += 1;
      pushEntries(tabId, entries);
    }
  };

  /**
   * Streaming deltas are the one event type worth batching: a single assistant
   * turn can produce hundreds of `message_update` frames, and one IPC push per
   * frame costs more than the text.
   */
  const accumulate = (tabId: string, entry: SessionEventEntry): void => {
    const list = pending.get(tabId) ?? [];
    list.push(entry);
    pending.set(tabId, list);
    const bytes = JSON.stringify(list).length;
    if (bytes >= coalesceBytes) {
      flushPending(tabId, "bytes");
      return;
    }
    if (!timers.has(tabId)) {
      const timer = setTimeout(() => flushPending(tabId, "timer"), coalesceMs);
      unrefTimer(timer);
      timers.set(tabId, timer);
    }
  };

  const emitState = (tabId: string, state: unknown): void => {
    const identity = sessionIdentities.get(tabId);
    deps.emit("state", {
      tabId,
      state,
      ...(identity ? { sessionId: identity.sessionId, sessionEpoch: identity.epoch } : {}),
    } satisfies SessionStateEnvelope);
  };

  /** Records a failure for the Diagnostics view and returns it for a notice. */
  const recordIncident = (
    kind: IncidentKind,
    message: string,
    options: { tabId?: string; detail?: string } = {},
  ): Incident => {
    incidentCounter += 1;
    const incident = createIncident({
      kind,
      message,
      id: `inc-${incidentCounter}`,
      at: now(),
      ...(options.tabId ? { tabId: options.tabId } : {}),
      ...(options.detail ? { detail: options.detail } : {}),
    });
    incidents = appendIncident(incidents, incident, DEFAULT_INCIDENT_LIMIT);
    return incident;
  };

  const recordExtensionError = (tabId: string, payload: unknown): void => {
    const record = asRecord(payload);
    const error = record.error;
    const message =
      typeof error === "string"
        ? error
        : error &&
            typeof error === "object" &&
            typeof (error as { message?: unknown }).message === "string"
          ? String((error as { message?: unknown }).message)
          : "an extension threw an error";
    const extensionId = typeof record.extensionPath === "string" ? record.extensionPath : null;
    const at = now();
    extensionErrors.unshift({ tabId, extensionId, message, at });
    if (extensionErrors.length > DEFAULT_INCIDENT_LIMIT) {
      extensionErrors.length = DEFAULT_INCIDENT_LIMIT;
    }
    recordIncident("extension_error", message, {
      tabId,
      ...(extensionId ? { detail: extensionId } : {}),
    });
  };

  /** Copies the fields the tab strip renders from any state snapshot. */
  const projectSnapshot = (tab: TabRecord, record: SnapshotLike): void => {
    if (typeof record.sessionFile === "string") tab.sessionFile = record.sessionFile;
    if (typeof record.sessionName === "string" && record.sessionName.length > 0) {
      tab.title = record.sessionName;
    }
    const model = record.model;
    if (model && typeof model === "object" && typeof model.id === "string") tab.model = model.id;
    tab.status = record.streaming === true ? "running" : "idle";
    // A live state frame means the session is open again; a previous stop reason
    // is no longer the tab's current fact (the memory warning is refreshed by
    // the host's ready/metrics path, not by this JSONL snapshot).
    delete tab.stopReason;
    delete tab.stoppedAt;
  };

  const applySnapshot = (tab: TabRecord, snapshot: unknown): void => {
    projectSnapshot(tab, asRecord(snapshot) as SnapshotLike);
    delete tab.error;
    emitState(tab.id, snapshot);
    publishTabs();
  };

  /** The bundle fingerprint currently on disk, or null when unreadable. */
  const currentHostBuildId = (): string | null => {
    if (!deps.hostBuildId) return null;
    try {
      return deps.hostBuildId();
    } catch {
      return null;
    }
  };

  /**
   * True when the live host was spawned from a different bundle than the one on
   * disk. A pre-change host reports no `buildId` and therefore counts as stale
   * as soon as a fingerprint is available; a host with no identity at all is
   * left alone rather than guessed about.
   */
  const hostIsStale = (host: SupervisorHostLike): boolean => {
    const expected = currentHostBuildId();
    if (!expected) return false;
    const info = host.info?.();
    if (!info) return false;
    return info.buildId !== expected;
  };

  /** Whether a `state.get` snapshot says the host must not be recycled. */
  const hostIsBusy = (snapshot: unknown): boolean => isSessionBusyState(snapshot);

  /** Forgets a tab's handle/subscriptions without stopping the supervisor process. */
  const forgetHost = (tabId: string): void => {
    flushPending(tabId);
    timers.delete(tabId);
    pending.delete(tabId);
    for (const off of unsubscribes.get(tabId) ?? []) off();
    unsubscribes.delete(tabId);
    hosts.delete(tabId);
    starting.delete(tabId);
    sessionReady.delete(tabId);
    sessionIdentities.delete(tabId);
    recovering.delete(tabId);
  };

  /**
   * Stops a tab's host and drops everything tied to it, leaving it stopped.
   * The generation bump makes any in-flight spawn/open stop the process it just
   * created instead of publishing it over the replacement.
   */
  const detachHost = async (
    tabId: string,
    options: { cancelled?: boolean; reason?: TabStopReason } = {},
  ): Promise<void> => {
    generations.set(tabId, (generations.get(tabId) ?? 0) + 1);
    // An explicit stop/close/park cancels the retry an in-flight open would
    // otherwise perform. A repair detach inside that same open passes
    // `cancelled: false`, so the retry it needs is not mistaken for a cancel.
    if (options.cancelled !== false) {
      cancelEpochs.set(tabId, (cancelEpochs.get(tabId) ?? 0) + 1);
    }
    // Keep `opening`: it is generation-scoped and the run's guard is what
    // cancels the late completion. Deleting it here opened a duplicate-open
    // window during the retry's own detach → ensureProcess → open sequence.
    forgetHost(tabId);
    try {
      await deps.supervisor.stop(tabId, options.reason ?? "manual");
    } catch {
      // A host that is already gone is exactly the state we want.
    }
    const tab = tabs.get(tabId);
    if (tab) {
      tab.status = "stopped";
      publishTabs();
    }
  };

  /**
   * Parks one tab's process after proving it is idle. The generation bump in
   * `detachHost` makes a late wake/open stop its own orphan rather than reviving
   * the old process for the new owner.
   */
  const parkTab = async (tabId: string): Promise<void> => {
    const existing = parking.get(tabId);
    if (existing) return existing;
    const run = (async (): Promise<void> => {
      const tab = tabs.get(tabId);
      if (!tab || !isHostBackedTab(tab.kind) || tab.kind === "office") return;
      if (tabId === activeId) return;
      // A pane the user is watching must never go to sleep under them.
      if (visibleTabs.has(tabId)) return;
      if (starting.has(tabId) || opening.has(tabId) || recycling.has(tabId)) return;
      if (pending.has(tabId) || timers.has(tabId)) return;
      if (now() - tab.lastActiveAt < PARK_MIN_IDLE_MS) return;
      const host = hosts.get(tabId);
      if (!host || host.status() !== "ready" || host.pinned?.()) return;
      if (host.isIdle?.() === false) return;
      let snapshot: unknown;
      try {
        snapshot = await host.request("state.get", undefined, { timeoutMs: 1_500 });
      } catch {
        return;
      }
      if (isSessionBusyState(snapshot)) return;
      // The probe yields; the user may have activated or written to the tab in
      // the meantime. Only the post-probe state decides whether it can sleep.
      if (tabId === activeId) return;
      if (visibleTabs.has(tabId)) return;
      if (starting.has(tabId) || opening.has(tabId) || recycling.has(tabId)) return;
      const record = asRecord(snapshot);
      if (typeof record.sessionFile === "string") tab.sessionFile = record.sessionFile;
      await detachHost(tabId, { reason: "park" });
      await persist();
    })().finally(() => {
      if (parking.get(tabId) === run) parking.delete(tabId);
    });
    parking.set(tabId, run);
    return run;
  };

  /**
   * Parks idle hosts until the live count is back under the soft target and the
   * aggregate host RSS is under its budget. It is deliberately best effort:
   * when every live session is busy the caller still starts its host, so a
   * session count can never block the user.
   */
  const makeRoom = async (exceptTabId: string): Promise<void> => {
    const overCount = (): boolean => deps.supervisor.list().length >= maxLiveHosts;
    const overRss = (): boolean => maxHostRssBytes > 0 && hostRssBytes() > maxHostRssBytes;
    if (!overCount() && !overRss()) return;
    for (const tab of idleCandidates(exceptTabId)) {
      if (!overCount() && !overRss()) break;
      await parkTab(tab.id);
    }
  };

  /**
   * LRU candidates for parking, oldest `lastActiveAt` first. Excludes the active
   * tab, every visible pane, Office hosts, pinned hosts (control/bridge/active),
   * in-flight work, pending event batches and tabs used within
   * `PARK_MIN_IDLE_MS`.
   */
  const idleCandidates = (exceptTabId: string | null): TabRecord[] => {
    return [...tabs.values()]
      .filter((tab) => tab.id !== exceptTabId && tab.id !== activeId)
      .filter((tab) => !visibleTabs.has(tab.id))
      .filter((tab) => isHostBackedTab(tab.kind) && tab.kind !== "office")
      .filter((tab) => hosts.has(tab.id))
      .filter((tab) => !starting.has(tab.id) && !opening.has(tab.id) && !recycling.has(tab.id))
      .filter((tab) => !pending.has(tab.id) && !timers.has(tab.id))
      .filter((tab) => now() - tab.lastActiveAt >= PARK_MIN_IDLE_MS)
      .filter((tab) => hosts.get(tab.id)?.pinned?.() !== true)
      .filter((tab) => hosts.get(tab.id)?.isIdle?.() !== false)
      .sort((left, right) => left.lastActiveAt - right.lastActiveAt);
  };

  /** Serializes budget decisions: two starts must never park the same tab twice. */
  const requestSlot = (exceptTabId: string): Promise<void> => {
    const run = slotQueue.then(() => makeRoom(exceptTabId)).catch(() => undefined);
    slotQueue = run;
    return run;
  };

  const subscribe = (tab: TabRecord, host: SupervisorHostLike): void => {
    const off = [
      host.on("event", (payload) => {
        const entry = toEntry(payload);
        if (!entry) return;
        const current = sessionIdentities.get(tab.id);
        const incomingId = entry.sessionId ?? null;
        const incomingEpoch = entry.sessionEpoch;
        const lifecycle =
          entry.event === "session_started" ||
          entry.event === "session_replaced" ||
          entry.event === "state";
        if (current) {
          // A lower attachment epoch is always stale, even for a lifecycle
          // event. A different id is stale only for content: a replacement or
          // state frame is the event that legitimately introduces the new id.
          if (incomingEpoch !== undefined && incomingEpoch < current.epoch) return;
          if (
            !lifecycle &&
            incomingId !== null &&
            current.sessionId !== null &&
            incomingId !== current.sessionId
          ) {
            return;
          }
        }
        if (lifecycle) {
          // Flush deltas against the *old* identity first, so the batch that
          // carries a replacement cannot also carry the old session's text.
          flushPending(tab.id);
          if (incomingId !== null || incomingEpoch !== undefined) {
            sessionIdentities.set(tab.id, {
              sessionId: incomingId ?? current?.sessionId ?? null,
              epoch: incomingEpoch ?? current?.epoch ?? 0,
            });
          }
        }
        if (entry.event === "state") {
          flushPending(tab.id);
          const snapshot = asRecord(entry.payload);
          // The host emits a state frame only after its session is attached, so a
          // real session id is a readiness signal (and closes the handshake
          // window where `ready` used to lie about the session).
          if (typeof snapshot.sessionId === "string" && snapshot.sessionId.length > 0) {
            sessionReady.add(tab.id);
          }
          emitState(tab.id, entry.payload);
          projectSnapshot(tab, snapshot as SnapshotLike);
          publishTabs();
          return;
        }
        if (entry.event === "message_update") {
          accumulate(tab.id, entry);
          return;
        }
        if (entry.event === "session_started") {
          // A host recycle resumes the same conversation. Announcing it is what
          // produced nine "Session started" rows in one session (2026-11-06
          // plan, step 15); only a real new/open/reload session is content.
          if (asRecord(entry.payload).reason === "resume") return;
        }
        if (entry.event === "extension_error") {
          recordExtensionError(tab.id, entry.payload);
        }
        flushPending(tab.id);
        pushEntries(tab.id, [entry]);
      }),
      host.on("status", (status) => {
        const next = String(status);
        if (next === "ready") {
          // A process handshake is not a session. If no spawn/open is in flight
          // this is a crash auto-restart: let the ensure path reopen from JSONL.
          // Never set `idle` here — that was the "ready but sessionless" window.
          if (!opening.has(tab.id) && !sessionReady.has(tab.id) && tabs.has(tab.id)) {
            void ensureSession(tab).catch(() => undefined);
          }
          // The host may have been over budget while protected; keep the warning
          // visible until it drops below the threshold or is restarted.
          if (host.overMemory?.() === true) tab.memoryOverBudget = true;
          else delete tab.memoryOverBudget;
        } else if (next === "restarting") {
          sessionReady.delete(tab.id);
          if (tabs.has(tab.id) && tab.status !== "failed") setStatus(tab, "starting");
        } else if (next === "failed") {
          sessionReady.delete(tab.id);
          setStatus(tab, "failed");
          if (
            !incidents.some(
              (incident) => incident.tabId === tab.id && incident.kind === "host_crash",
            )
          ) {
            recordIncident(
              "host_failed",
              `host for ${tab.id} was stopped after repeated failures`,
              {
                tabId: tab.id,
              },
            );
          }
        } else if (next === "stopped") {
          // A stopped host (idle/RSS recycle) must not stay in the handle map:
          // the next interaction spawns/resumes a fresh one. Capture why before
          // `forgetHost` drops the handle.
          const reason = host.stopReason?.() ?? "manual";
          const recycleKey = `${tab.id}\u0000${reason}`;
          if (!recordedRecycles.has(recycleKey)) {
            recordedRecycles.add(recycleKey);
            recordIncident("host_recycled", `host for ${tab.id} stopped (${reason})`, {
              tabId: tab.id,
              detail: reason,
            });
          }
          forgetHost(tab.id);
          setStatus(tab, "stopped", undefined, {
            reason,
            at: now(),
            ...(host.overMemory?.() === true ? { memoryOverBudget: true } : {}),
          });
        }
      }),
      host.on("crashed", (payload) => {
        flushPending(tab.id);
        sessionReady.delete(tab.id);
        recovering.add(tab.id);
        setStatus(tab, "crashed");
        recordIncident("host_crash", `host for ${tab.id} crashed`, { tabId: tab.id });
        pushEntries(tab.id, [{ event: "session.crashed", payload }]);
      }),
      host.on("timeout", (payload) => {
        flushPending(tab.id);
        const record = asRecord(payload);
        const method = typeof record.method === "string" ? record.method : "request";
        recordIncident("host_timeout", `host did not answer "${method}"`, { tabId: tab.id });
        pushEntries(tab.id, [{ event: "session.timeout", payload }]);
      }),
    ];
    unsubscribes.set(tab.id, off);
  };

  /**
   * Starts (or returns) a *process* for a tab. It deliberately does not open a
   * session: explicit `session.create`/`resume` requests must reach the host
   * unchanged (the trust retry and `/new` depend on it).
   */
  const startProcess = async (tab: TabRecord): Promise<SupervisorHostLike> => {
    setStatus(tab, "starting");
    const startedAt = now();
    const history = (startHistory.get(tab.id) ?? []).filter((at) => startedAt - at <= 120_000);
    history.push(startedAt);
    startHistory.set(tab.id, history);
    if (history.length >= 4 && !recordedLoops.has(tab.id)) {
      recordedLoops.add(tab.id);
      recordIncident("host_restart_loop", `host for ${tab.id} started 4 times in 2 minutes`, {
        tabId: tab.id,
        detail: "RSS or crash recycle loop; see the per-tab log",
      });
    }
    const generation = generations.get(tab.id) ?? 0;
    let host: SupervisorHostLike;
    try {
      host = await deps.supervisor.start({
        sessionId: tab.id,
        cwd: tab.cwd,
        role: "session",
        officeHost: tab.kind === "office",
        sessionFile: tab.sessionFile,
      });
    } catch (error) {
      // A failed spawn must never leave a phantom `starting` tab. Keep the tab
      // and its error so the user can read what happened and close/retry it; the
      // trust retry path is a session.open failure below, not a spawn failure.
      const message = error instanceof Error ? error.message : String(error);
      setStatus(tab, "failed", message);
      throw error;
    }
    // `closeTab`/`dispose`/a newer detach may have run while the spawn was in
    // flight. Never publish a host over the replacement; stop the orphan.
    if (disposed || !tabs.has(tab.id) || (generations.get(tab.id) ?? 0) !== generation) {
      await deps.supervisor.stop(tab.id).catch(() => undefined);
      throw new SessionServiceError("tab closed while its host was starting", "tab_closed");
    }
    hosts.set(tab.id, host);
    subscribe(tab, host);
    return host;
  };

  /** Process-start coalescer: one child per tab, never opens a session. */
  const ensureProcess = async (tab: TabRecord): Promise<SupervisorHostLike> => {
    if (!isHostBackedTab(tab.kind)) {
      throw new SessionServiceError(
        tab.kind === "editor" ? "an editor tab has no Pi host" : "a web tab has no Pi host",
        tab.kind === "editor" ? "editor_tab" : "web_tab",
      );
    }
    const inFlight = starting.get(tab.id);
    if (inFlight) return inFlight;
    // A wake must wait for an in-flight park to settle; otherwise it could spawn
    // a second process while the old one is still shutting down.
    const inPark = parking.get(tab.id);
    if (inPark) await inPark;
    const existing = hosts.get(tab.id);
    if (existing && existing.status() === "ready") return existing;
    if (existing) await detachHost(tab.id, { cancelled: false });
    const raced = starting.get(tab.id);
    if (raced) return raced;
    await requestSlot(tab.id);
    const startedWhileQueued = starting.get(tab.id);
    if (startedWhileQueued) return startedWhileQueued;
    const run = startProcess(tab);
    starting.set(tab.id, run);
    void run.then(
      () => starting.delete(tab.id),
      () => starting.delete(tab.id),
    );
    return run;
  };

  /**
   * Opens (or resumes) a tab's session on an already-live host. A successful
   * `session.create`/`resume` response is the only thing that makes a tab idle
   * besides a real `state` frame.
   */
  const openSession = async (
    tab: TabRecord,
    host: SupervisorHostLike,
    reason: "spawn" | "recover",
  ): Promise<SupervisorHostLike> => {
    const generation = generations.get(tab.id) ?? 0;
    setStatus(tab, "starting");
    try {
      const extra = createParams.get(tab.id);
      const snapshot = tab.sessionFile
        ? await host.request("session.resume", { sessionFile: tab.sessionFile })
        : await host.request("session.create", {
            cwd: tab.cwd,
            ...(extra?.model ? { model: extra.model } : {}),
            ...(extra?.thinking ? { thinking: extra.thinking } : {}),
            ...(extra?.trust ? { trust: extra.trust } : {}),
          });
      if (disposed || !tabs.has(tab.id) || (generations.get(tab.id) ?? 0) !== generation) {
        await deps.supervisor.stop(tab.id).catch(() => undefined);
        throw new SessionServiceError("tab closed while its session was opening", "tab_closed");
      }
      applySnapshot(tab, snapshot);
      sessionReady.add(tab.id);
      const wasRecovering = recovering.delete(tab.id);
      if (reason === "recover" || wasRecovering) {
        pushEntries(tab.id, [
          { event: "session.recovered", payload: { sessionFile: tab.sessionFile } },
        ]);
      }
      return host;
    } catch (error) {
      sessionReady.delete(tab.id);
      // A `tab_closed` failure has no tab record left to update: the generation
      // bump already stopped the process it just opened.
      if (error instanceof SessionServiceError && error.code === "tab_closed") throw error;
      const message = error instanceof Error ? error.message : String(error);
      // A trust refusal leaves a live host so the renderer's prompt can retry
      // `session.create`; every other failure drops the process so the next
      // ensure starts cleanly rather than talking to a sessionless host.
      if (host.status() !== "ready" || isHostGoneError(error)) {
        await detachHost(tab.id, { cancelled: false });
      }
      // A host that stopped or timed out is a lifetime failure, not a refused
      // session. Keep the tab retryable (`stopped`) so `ensureSession` can
      // respawn, and report `failed` only for a real refusal. This is what
      // turned a 30 s phantom wait into an error the user had to restart for.
      const recoverable = isRecoverableOpenError(error);
      setStatus(tab, recoverable ? "stopped" : "failed", recoverable ? undefined : message);
      throw error;
    }
  };

  /**
   * The interaction entry point: a live host with an open session. Coalesces
   * concurrent callers; repairs a sessionless/dead host with a fresh process
   * and one open. `ready` is never returned before this settles.
   */
  const ensureSession = async (tab: TabRecord): Promise<SupervisorHostLike> => {
    if (!isHostBackedTab(tab.kind)) {
      throw new SessionServiceError(
        tab.kind === "editor" ? "an editor tab has no Pi host" : "a web tab has no Pi host",
        tab.kind === "editor" ? "editor_tab" : "web_tab",
      );
    }
    const generationAtStart = generations.get(tab.id) ?? 0;
    const inFlight = opening.get(tab.id);
    if (inFlight) {
      if (inFlight.generation === generationAtStart) return inFlight.promise;
      // A detach superseded this run while it was opening. Let it finish its own
      // cleanup (it stops the host it started), then fall through to a new run
      // for the current generation. Never run both at once.
      await inFlight.promise.catch(() => undefined);
      const current = opening.get(tab.id);
      const currentGeneration = generations.get(tab.id) ?? 0;
      if (current && current.generation === currentGeneration) return current.promise;
    }
    // Capture before `detachHost` clears it: a crash recovery gets one notice,
    // a normal open/wake does not.
    const wasRecovering = recovering.has(tab.id);
    const reason = wasRecovering ? "recover" : "spawn";
    const run = (async (): Promise<SupervisorHostLike> => {
      // This run may repair a non-ready host itself. Its own detach bumps the
      // host generation, so track the generation this run currently owns and
      // use it to distinguish its repair from an external stop/close.
      const cancelEpochAtStart = cancelEpochs.get(tab.id) ?? 0;
      let host = await ensureProcess(tab);
      if (host.status() === "ready" && sessionReady.has(tab.id)) return host;
      if (host.status() !== "ready") {
        // The supervisor is restarting, failed, or has no child: preempt its
        // backoff with a deterministic fresh process, then open once.
        await detachHost(tab.id, { cancelled: false });
        host = await ensureProcess(tab);
      }
      try {
        return await openSession(tab, host, reason);
      } catch (error) {
        // The host stopped or timed out, so the process — not the session — was
        // the problem. Retry exactly once on a fresh process; a second failure
        // propagates and the tab keeps the reason. An external detach (Stop,
        // close, park) bumps the generation and cancels the retry.
        if (
          !isRecoverableOpenError(error) ||
          disposed ||
          !tabs.has(tab.id) ||
          cancelEpochAtStart !== (cancelEpochs.get(tab.id) ?? 0)
        ) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        host.note?.(`open failed (${message}); retrying on a fresh process`);
        await detachHost(tab.id, { cancelled: false });
        const retryHost = await ensureProcess(tab);
        return await openSession(tab, retryHost, reason);
      }
    })();
    const transition: OpeningTransition = { promise: run, generation: generationAtStart };
    opening.set(tab.id, transition);
    void run.then(
      () => {
        if (opening.get(tab.id) === transition) opening.delete(tab.id);
      },
      () => {
        if (opening.get(tab.id) === transition) opening.delete(tab.id);
      },
    );
    return run;
  };

  /**
   * Recycles a host that predates the bundle on disk, but only when `state.get`
   * proves it is idle and the session can be resumed. Concurrent requests share
   * one stop+respawn (2026-10-24 stale-host plan).
   */
  const recycleStaleHost = async (tab: TabRecord): Promise<SupervisorHostLike> => {
    const inFlight = recycling.get(tab.id);
    if (inFlight) return inFlight;
    const run = (async (): Promise<SupervisorHostLike> => {
      const host = await ensureSession(tab);
      if (!hostIsStale(host)) return host;
      let snapshot: unknown;
      try {
        // A short probe: a wedged host must not add the 30 s request timeout to
        // a keystroke. On failure, keep the old host and let the caller decide.
        snapshot = await host.request("state.get", undefined, { timeoutMs: 2_000 });
      } catch {
        return host;
      }
      const record = asRecord(snapshot);
      if (typeof record.sessionFile === "string") tab.sessionFile = record.sessionFile;
      if (hostIsBusy(record) || !tab.sessionFile) return host;
      await detachHost(tab.id);
      return ensureSession(tab);
    })();
    recycling.set(tab.id, run);
    try {
      return await run;
    } finally {
      recycling.delete(tab.id);
    }
  };

  /**
   * Control-host events are app-wide (provider login progress and prompts, plan
   * step 9), so they are forwarded under the control address rather than a tab.
   */
  const subscribeControl = (host: SupervisorHostLike): void => {
    controlUnsubscribes.push(
      host.on("event", (payload) => {
        const entry = toEntry(payload);
        if (!entry) return;
        pushEntries(CONTROL_TAB_ID, [entry]);
      }),
      host.on("crashed", (payload) => {
        control = null;
        pushEntries(CONTROL_TAB_ID, [{ event: "host.crashed", payload }]);
      }),
      host.on("status", (status) => {
        // The control host is pinned, so the idle reaper should never stop it;
        // this is the safety net that keeps `controlHost()` from returning a
        // dead handle if it ever does.
        if (String(status) === "stopped") control = null;
      }),
    );
  };

  /** One row per tab (plus the control host) for the Diagnostics view (step 22). */
  const describeHost = (tabId: string, host: SupervisorHostLike): DiagnosticsHostInfo => {
    const tab = tabs.get(tabId);
    const info = host.info?.() ?? null;
    const pads = info?.pids;
    const role: HostRole = info?.role === "control" ? "control" : "session";
    const buildId = info?.buildId ?? null;
    const stale = role === "session" && hostIsStale(host);
    return {
      tabId,
      role,
      status: host.status(),
      cwd: typeof info?.cwd === "string" ? info.cwd : (tab?.cwd ?? ""),
      sessionFile: tab?.sessionFile ?? null,
      officeHost: tab?.kind === "office",
      pid: typeof pads?.pid === "number" ? pads.pid : null,
      startedAt: typeof info?.startedAt === "number" ? info.startedAt : null,
      rssBytes: host.metrics?.()?.rssBytes ?? null,
      buildId,
      stale,
      stopReason: host.stopReason?.() ?? null,
      overMemory: host.overMemory?.() === true,
      restartCount: host.restartCount?.() ?? 0,
      lastRestartReason: host.lastRestartReason?.() ?? null,
      logLines: host.logs?.() ?? [],
    };
  };

  const service: SessionService = {
    async controlHost() {
      if (control) return control;
      await requestSlot(CONTROL_HOST_ID);
      const host = await deps.supervisor.start({
        sessionId: CONTROL_HOST_ID,
        cwd: deps.controlCwd,
        role: "control",
      });
      control = host;
      subscribeControl(host);
      return host;
    },

    tabs: () => [...tabs.values()],
    activeTabId: () => activeId,

    setVisibleTabs(ids) {
      // Advisory and idempotent: an unknown or already-closed id is dropped (a
      // close races this push), and the set is bounded because the renderer can
      // be restarted against a stale `prefs.grid`.
      const next = new Set<string>();
      for (const id of ids) {
        if (typeof id !== "string" || id.length === 0) continue;
        if (!tabs.has(id)) continue;
        next.add(id);
        if (next.size >= MAX_GRID_PANES + 1) break;
      }
      const unchanged =
        next.size === visibleTabs.size && [...next].every((id) => visibleTabs.has(id));
      if (unchanged) return;
      visibleTabs.clear();
      for (const id of next) visibleTabs.add(id);
    },

    visibleTabIds: () => [...visibleTabs],
    envelope,

    incidents: () => [...incidents],
    extensionErrors: () => [...extensionErrors],
    capacity: () => {
      const all = [...tabs.values()];
      const open = all.filter((tab) => isHostBackedTab(tab.kind));
      const hosts = deps.supervisor.list();
      const liveHosts = hosts.length;
      const hostRssBytes = hosts.reduce((sum, host) => sum + (host.metrics?.()?.rssBytes ?? 0), 0);
      const hostRssLimitBytes = Math.max(0, deps.hostRssLimitBytes ?? 0);
      return {
        liveHosts,
        targetHosts: maxLiveHosts,
        ceilingHosts: deps.supervisor.capacity?.().limit ?? maxLiveHosts,
        overTarget: liveHosts > maxLiveHosts,
        hostRssBytes,
        hostRssLimitBytes,
        overMemory: hostRssLimitBytes > 0 && hostRssBytes > hostRssLimitBytes,
        openSessions: open.length,
        asleepSessions: open.filter((tab) => tab.status === "stopped").length,
        editorTabs: all.filter(isEditorTab).length,
        visibleSessions: visibleTabs.size,
      };
    },
    reclaimHosts: async () => {
      // Serialize with spawns: a reclaim must never park a host that a queued
      // activation is about to reuse, and two reclaims must not park twice.
      const run = slotQueue
        .then(async () => {
          // Every visible pane is un-parkable, so the floor is the panes plus
          // the focused tab; a reclaimed app still keeps what the user sees.
          const targetLive = Math.max(2, visibleTabs.size + (activeId ? 1 : 0));
          for (const tab of idleCandidates(null)) {
            const live = deps.supervisor.list().length;
            const rss = hostRssBytes();
            const underCount = live <= targetLive;
            const underRss = maxHostRssBytes === 0 || rss <= maxHostRssBytes;
            if (underCount && underRss) break;
            await parkTab(tab.id);
          }
        })
        .catch(() => undefined);
      slotQueue = run;
      await run;
      return service.capacity();
    },
    coalesceStats: () => ({ ...coalesceStats }),
    diagnosticsHosts: () => {
      const rows: DiagnosticsHostInfo[] = [];
      if (control) rows.push(describeHost(CONTROL_HOST_ID, control));
      for (const tab of tabs.values()) {
        const host = hosts.get(tab.id);
        if (host) {
          rows.push(describeHost(tab.id, host));
          continue;
        }
        rows.push({
          tabId: tab.id,
          role: "session",
          status: tab.status,
          cwd: tab.cwd,
          sessionFile: tab.sessionFile,
          officeHost: tab.kind === "office",
          pid: null,
          startedAt: null,
          rssBytes: null,
          buildId: null,
          stale: false,
          stopReason: tab.stopReason ?? null,
          overMemory: tab.memoryOverBudget === true,
          restartCount: 0,
          lastRestartReason: null,
          logLines: [],
        });
      }
      return rows;
    },

    async restoreTabs() {
      const state = await deps.store.read();
      // Older builds minted a new tab for every resume of an already-open
      // session, so a profile can carry several records for one JSONL. Keep the
      // most recently active record (with any pin) and drop the rest: the
      // restored table must satisfy the one-manager-per-file invariant too.
      const collapsed = collapseDuplicateSessionTabs(sanitizeTabs(state.tabs));
      tabs.clear();
      hosts.clear();
      starting.clear();
      opening.clear();
      sessionReady.clear();
      sessionIdentities.clear();
      generations.clear();
      recovering.clear();
      for (const tab of collapsed.tabs) {
        // A tab is a resumable record, not a process. Nothing is running yet
        // after a relaunch, so a restored tab is idle/stopped until activated;
        // the full table is restored, however many tabs the user keeps.
        tabs.set(tab.id, {
          ...tab,
          status: isHostBackedTab(tab.kind) ? "stopped" : "idle",
          // A relaunch has no live host, so a saved memory warning is stale.
          memoryOverBudget: false,
        });
      }
      // Persisted order is authoritative, but an older profile may have a
      // pinned tab below an unpinned one. Stable-partition once on restore.
      const restored = partitionPinnedTabs([...tabs.values()]);
      tabs.clear();
      for (const tab of restored) tabs.set(tab.id, tab);
      const persistedActive = typeof state.activeTabId === "string" ? state.activeTabId : null;
      // A dropped duplicate's id must resolve to the record that replaced it
      // before the generic "named tab is gone" repair runs.
      const repairedActive =
        persistedActive !== null && collapsed.replacedTabIds.has(persistedActive)
          ? (collapsed.replacedTabIds.get(persistedActive) ?? persistedActive)
          : persistedActive;
      // The repair is for a *named* tab that no longer exists: fall back to the
      // most recently used session so the app opens where the user last worked
      // instead of on an empty shell. A deliberately cleared selection (`null`)
      // stays cleared.
      const mruSession = [...tabs.values()]
        .filter((tab) => isHostBackedTab(tab.kind))
        .sort((left, right) => right.lastActiveAt - left.lastActiveAt)[0];
      selectTab(
        repairedActive === null
          ? null
          : tabs.has(repairedActive)
            ? repairedActive
            : (mruSession?.id ?? null),
      );
      publishTabs();
      // Make the repair durable: otherwise the same duplicates come back on the
      // next launch. Only a table that actually changed is rewritten.
      if (collapsed.replacedTabIds.size > 0) await persist();
      return envelope();
    },

    async createTab(input) {
      if (disposed) throw new SessionServiceError("session service is disposed", "disposed");
      const kind = input.kind ?? "session";
      const isEditor = kind === "editor";
      // A web tab carries a URL and needs no project folder; every other kind
      // needs a cwd. An editor tab additionally needs a contained file path.
      const webUrl = kind === "web" ? sanitizeWebUrl(input.url) : null;
      if (kind === "web") {
        if (!webUrl) throw new SessionServiceError("createTab requires a web URL", "bad_request");
      } else if (typeof input.cwd !== "string" || input.cwd.length === 0) {
        throw new SessionServiceError("createTab requires a project folder", "bad_request");
      }
      const filePath = isEditor ? input.filePath : undefined;
      if (isEditor && (!filePath || !isWorkspaceRelativePath(filePath))) {
        throw new SessionServiceError("createTab requires a project-relative file", "bad_request");
      }
      const requestedFile =
        typeof input.sessionFile === "string" && input.sessionFile.length > 0
          ? input.sessionFile
          : null;
      // A session file is one conversation with one live manager: the SDK takes
      // no lock and every host appends from its own in-memory leaf, so a second
      // tab on one JSONL branches the transcript. The renderer checks first;
      // this is the invariant behind every caller. Reuse is reported so the UI
      // can take the "return to that tab" path instead of a new-tab path.
      if (isHostBackedTab(kind) && requestedFile !== null) {
        const existing = findTabBySessionFile(tabs.values(), requestedFile);
        if (existing) {
          if (input.activate !== false) await service.activateTab(existing.id);
          return { ...envelope(), reusedTabId: existing.id };
        }
      }
      const id = newId();
      const timestamp = now();
      const cwd = typeof input.cwd === "string" ? input.cwd : "";
      const tab: TabRecord = {
        id,
        kind,
        cwd,
        title: isEditor
          ? workspaceBasename(filePath!)
          : kind === "web"
            ? webTabTitle(webUrl)
            : sessionTitle(cwd),
        sessionFile: requestedFile,
        status: isHostBackedTab(kind) ? "starting" : "idle",
        createdAt: timestamp,
        lastActiveAt: timestamp,
        model: null,
        ...(kind === "web" ? { url: webUrl, sessionTabId: input.sessionTabId ?? null } : {}),
        ...(isEditor ? { filePath } : {}),
        ...(kind === "terminal" && input.profileId ? { profileId: input.profileId } : {}),
      };
      tabs.set(id, tab);
      const activate = input.activate !== false;
      if (activate) selectTab(id);
      if (isHostBackedTab(kind) && (input.model || input.thinking || input.trust)) {
        createParams.set(id, {
          ...(input.model ? { model: input.model } : {}),
          ...(input.thinking ? { thinking: input.thinking } : {}),
          ...(input.trust ? { trust: input.trust } : {}),
        });
      }
      publishTabs();
      await persist();
      // A background web tab (a review URL discovered in a tool result) must not
      // select itself or spawn anything. Only a user gesture activates.
      if (activate) await service.activateTab(id);
      return envelope();
    },

    async ensureTab(tabId) {
      const tab = requireTab(tabId);
      // A web or editor tab has no host to wake; the envelope still lets the
      // caller apply the latest table.
      if (isHostBackedTab(tab.kind)) await ensureSession(tab);
      return envelope();
    },

    async activateTab(tabId) {
      const tab = requireTab(tabId);
      selectTab(tabId);
      tab.lastActiveAt = now();
      publishTabs();
      // A web or editor tab has no host to start (plan step 7); main reconciles
      // the web view from the tab table and the editor from its own buffer.
      if (isHostBackedTab(tab.kind)) await ensureSession(tab);
      await persist();
      return envelope();
    },

    async deactivate() {
      // Clearing a *selection* is not closing a tab: every host keeps running and
      // every record is untouched, so switching back is instant. This is what
      // lets a project with no open session own the rail while the session column
      // shows Welcome (2026-10-30 project-scoped rail plan).
      if (activeId === null) return envelope();
      selectTab(null);
      publishTabs();
      await persist();
      return envelope();
    },

    async reconcile() {
      for (const tab of tabs.values()) {
        if (!isHostBackedTab(tab.kind)) continue;
        if (opening.has(tab.id) || starting.has(tab.id)) {
          tab.status = "starting";
          continue;
        }
        const host = hosts.get(tab.id);
        if (!host) {
          sessionReady.delete(tab.id);
          if (tab.status !== "stopped" && tab.status !== "failed") tab.status = "stopped";
          continue;
        }
        const status = host.status();
        if (status === "ready") {
          if (!sessionReady.has(tab.id)) {
            tab.status = "starting";
          } else if (
            tab.status === "stopped" ||
            tab.status === "failed" ||
            tab.status === "crashed"
          ) {
            // The host is alive and its session is open; a stale lifecycle word
            // from a missed push must not stay on screen.
            tab.status = "idle";
          }
        } else if (status === "restarting" || status === "starting") {
          sessionReady.delete(tab.id);
          tab.status = "starting";
        } else if (status === "stopped") {
          forgetHost(tab.id);
          tab.status = "stopped";
        } else if (status === "failed") {
          sessionReady.delete(tab.id);
          tab.status = "failed";
        }
      }
      publishTabs();
      return envelope();
    },

    async closeTab(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) return envelope();
      forgetHost(tabId);
      recycling.delete(tabId);
      parking.delete(tabId);
      sequences.delete(tabId);
      generations.delete(tabId);
      createParams.delete(tabId);
      tabs.delete(tabId);
      try {
        // A web or editor tab has no supervisor host to stop (plan step 7).
        if (isHostBackedTab(tab.kind)) await deps.supervisor.stop(tabId);
      } catch {
        // A host that is already gone is not an error for the user.
      }
      if (activeId === tabId) {
        const next = [...tabs.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
        selectTab(next ? next.id : null);
      }
      publishTabs();
      await persist();
      return envelope();
    },

    async closeOthers(tabId) {
      const target = tabs.get(tabId);
      if (!target) return envelope();
      for (const [id, record] of [...tabs]) {
        if (id !== tabId && record.kind === target.kind && record.pinned !== true) {
          await service.closeTab(id);
        }
      }
      return envelope();
    },

    async closeAll(kind) {
      for (const tab of [...tabs.values()]) {
        if (tab.kind === kind && tab.pinned !== true) await service.closeTab(tab.id);
      }
      return envelope();
    },

    async closeForProject(cwd) {
      for (const tab of [...tabs.values()]) {
        if (sameFolder(tab.cwd, cwd)) await service.closeTab(tab.id);
      }
      return envelope();
    },

    async setPinned(tabId, pinned) {
      const tab = requireTab(tabId);
      if (pinned) tab.pinned = true;
      else delete tab.pinned;
      const ordered = partitionPinnedTabs([...tabs.values()]);
      tabs.clear();
      for (const record of ordered) tabs.set(record.id, record);
      publishTabs();
      await persist();
      return envelope();
    },

    async retargetEditorTabs(input) {
      for (const tab of tabs.values()) {
        if (!isEditorTab(tab)) continue;
        if (!sameFolder(tab.cwd, input.fromProjectPath)) continue;
        if (!isWorkspacePathWithin(tab.filePath, input.fromPath, input.kind)) continue;
        const suffix = input.kind === "file" ? "" : tab.filePath.slice(input.fromPath.length);
        const nextPath = `${input.toPath}${suffix}`;
        tab.cwd = input.toProjectPath;
        tab.filePath = nextPath;
        tab.title = workspaceBasename(nextPath);
      }
      publishTabs();
      await persist();
      return envelope();
    },

    async reorderTab(tabId, toIndex) {
      const ordered = moveTabWithinPinGroup([...tabs.values()], tabId, toIndex);
      if (ordered.map((tab) => tab.id).join("\0") === [...tabs.keys()].join("\0")) {
        return envelope();
      }
      // Rebuild the map in the new order: the tab table's insertion order *is*
      // the strip order, so this is the only place it is defined.
      tabs.clear();
      for (const record of ordered) tabs.set(record.id, record);
      publishTabs();
      await persist();
      return envelope();
    },

    async promoteToOfficeHost(tabId) {
      const tab = requireTab(tabId);
      if (tab.kind === "web") {
        throw new SessionServiceError("a web tab cannot be the Office host", "bad_request");
      }
      // Already the office host and running: nothing to restart.
      if (tab.kind === "office" && hosts.has(tabId)) return envelope();

      // Remember the host we are about to displace, so a failed takeover can put
      // it back instead of leaving the app with no bridge at all.
      const previous = [...tabs.values()].find(
        (record) => record.id !== tabId && record.kind === "office",
      );

      // Snapshot the PIDs **before** anything is detached (2026-10-30
      // rail-headers plan). The reclaimer must never signal this app, and a host
      // that has just been detached has already left `hosts.list()` — sampling
      // later would make our own still-exiting process look like a stranger.
      const ownPids = deps.ownPids?.() ?? [];

      // One office host only: demote every other `office` tab and stop its host.
      // `detachHost` awaits the process exit (step 8), so the old bridge has
      // really let go of the port by the time we look at it.
      for (const [id, record] of [...tabs]) {
        if (id === tabId || record.kind !== "office") continue;
        recycling.delete(id);
        await detachHost(id);
        tabs.set(id, { ...record, kind: "session", status: "stopped" });
      }

      // Restart the promoted tab so its host is spawned with `officeHost: true`.
      recycling.delete(tabId);
      await detachHost(tabId, { reason: "restart" });

      // Free the bridge port *before* the new host binds it (2026-10-30 plan).
      // Stopping our own host is not enough: an earlier app run, terminal Pi, or
      // an unrelated squatter can still hold 38617, and the bridge extension
      // would report `EADDRINUSE` instead of listening. The reclaimer terminates
      // the owner (never this app's own processes) and verifies the port is free.
      const release = deps.releaseOfficePort;
      if (release) {
        const freed = await release({
          port: deps.officeBridgePort ?? PI_OFFICE_BRIDGE.defaultPort,
          ownPids,
        });
        if (!freed.ok) {
          // Roll back: re-promote the host we displaced so the user keeps the
          // bridge they had, and fail with the reason the port stayed busy.
          if (previous) {
            tabs.set(previous.id, { ...previous, kind: "office", status: "stopped" });
            publishTabs();
            await persist();
            await service.activateTab(previous.id).catch(() => undefined);
          }
          throw new SessionServiceError(
            freed.detail ??
              `Office bridge port ${deps.officeBridgePort ?? PI_OFFICE_BRIDGE.defaultPort} is in use, so this session cannot take the bridge.`,
            "office_port_busy",
          );
        }
      }

      tab.kind = "office";
      tab.status = "stopped";
      publishTabs();
      await persist();
      // `activateTab` re-spawns the host (resuming the session JSONL) and makes
      // the promoted tab active.
      return service.activateTab(tabId);
    },

    async request(tabId, method, params) {
      // The control host is addressed like a tab so the renderer has one channel
      // for every host (plan D-A3); it simply has no per-session state.
      if (tabId === CONTROL_TAB_ID) {
        const host = await service.controlHost();
        return host.request(method, params, { timeoutMs: requestTimeoutFor(method) });
      }
      const tab = requireTab(tabId);
      if (!isHostBackedTab(tab.kind)) {
        throw new SessionServiceError(
          tab.kind === "editor" ? "an editor tab has no Pi host" : "a web tab has no Pi host",
          tab.kind === "editor" ? "editor_tab" : "web_tab",
        );
      }
      if (PASSIVE_METHODS.has(method) && !sessionReady.has(tab.id)) {
        // An open already in flight may make this readable. Wait for that open
        // (never start another) and refuse if it did not establish a session.
        const inFlight = opening.get(tab.id);
        if (inFlight) await inFlight.promise.catch(() => undefined);
        if (!sessionReady.has(tab.id)) {
          throw new SessionServiceError(SESSION_ASLEEP_MESSAGE, "host_stopped");
        }
      }
      // LRU is about real use, not merely an open tab: every request that is
      // allowed to reach a host keeps the session warm. Internal `state.get`
      // probes call `host.request` directly, so they do not distort the ordering.
      // A passive read that was refused above deliberately does not bump this.
      tab.lastActiveAt = now();
      // Explicit session lifecycle commands bypass auto-open: the caller owns
      // the operation (trust retry, /new, fork). Only the process is ensured.
      if (SESSION_ESTABLISHING_METHODS.has(method)) {
        const inFlight = opening.get(tab.id);
        if (inFlight) await inFlight.promise.catch(() => undefined);
        const host = await ensureProcess(tab);
        let result: unknown;
        try {
          result = await host.request(method, params, { timeoutMs: requestTimeoutFor(method) });
        } catch (error) {
          // The caller owns the operation, so it is not replayed here — but a
          // host that died mid-open must not leave the tab on `starting`
          // forever. `stopped` is retryable: the next interaction respawns.
          if (isRecoverableOpenError(error)) await detachHost(tab.id);
          throw error;
        }
        if (isSessionSnapshot(result)) {
          applySnapshot(tab, result);
          sessionReady.add(tab.id);
          recovering.delete(tab.id);
        }
        return result;
      }
      let host = await ensureSession(tab);
      if (hostIsStale(host)) {
        try {
          host = await recycleStaleHost(tab);
        } catch {
          // Keep the old host: a completion must not lose its request because a
          // respawn failed, and the unsupported fallback below still applies.
        }
      }
      try {
        return await host.request(method, params, { timeoutMs: requestTimeoutFor(method) });
      } catch (error) {
        if (method === "commands.complete" && isMissingCommandComplete(error)) {
          return { items: null, unsupported: true } satisfies CommandCompleteResult;
        }
        if (isSessionLostError(error)) {
          // The host outlived/replaced its session between ensure and dispatch.
          // Reopen once; only a read-only call is safe to replay automatically.
          sessionReady.delete(tab.id);
          recovering.add(tab.id);
          try {
            host = await ensureSession(tab);
            if (READ_ONLY_RETRY_METHODS.has(method)) {
              return await host.request(method, params, { timeoutMs: requestTimeoutFor(method) });
            }
          } catch {
            // Keep the original error: it names the operation that failed.
          }
          if (method === "prompt") {
            throw new SessionServiceError(
              "The session host restarted before it received your prompt. Your text was put back in the composer — press Enter to try again.",
              "session_lost",
            );
          }
        }
        throw error;
      }
    },

    async stopTab(tabId) {
      const tab = requireTab(tabId);
      if (!isHostBackedTab(tab.kind)) {
        throw new SessionServiceError(
          tab.kind === "editor"
            ? "an editor tab has no Pi host to stop"
            : "a web tab has no Pi host to stop",
          tab.kind === "editor" ? "editor_tab" : "web_tab",
        );
      }
      // Deliberately does not wait for `opening`: Cancel has to answer now. The
      // generation bump inside `detachHost` makes the late open stop the process
      // it just started instead of publishing it over this stop.
      await detachHost(tabId, { reason: "manual" });
      await persist();
      return envelope();
    },

    async restartTab(tabId) {
      const tab = requireTab(tabId);
      if (!isHostBackedTab(tab.kind)) {
        throw new SessionServiceError(
          tab.kind === "editor"
            ? "an editor tab has no Pi host to restart"
            : "a web tab has no Pi host to restart",
          tab.kind === "editor" ? "editor_tab" : "web_tab",
        );
      }
      // Let an in-flight stale recycle settle first; otherwise it could spawn a
      // host after this detach and leave two processes for one tab.
      const inFlightRecycle = recycling.get(tabId);
      if (inFlightRecycle) await inFlightRecycle.catch(() => undefined);
      recycling.delete(tabId);
      // Detach the old host the same way `closeTab` does, then let `activateTab`
      // spawn a fresh one. The session file is untouched, so history returns.
      await detachHost(tabId, { reason: "restart" });
      return service.activateTab(tabId);
    },

    async prewarmLast() {
      const tab = [...tabs.values()]
        .filter((entry) => isHostBackedTab(entry.kind))
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
      if (!tab) return false;
      try {
        await ensureSession(tab);
        return true;
      } catch {
        // Pre-warming is an optimization; failing it must not disturb startup.
        return false;
      }
    },

    async flush() {
      for (const tabId of [...pending.keys()]) flushPending(tabId);
      await persist();
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      await service.flush();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const list of unsubscribes.values()) for (const off of list) off();
      unsubscribes.clear();
      for (const off of controlUnsubscribes.splice(0)) off();
      hosts.clear();
      // Any in-flight spawn sees `disposed` and stops its own host; dropping the
      // handles here keeps nothing pointing at a process during shutdown.
      starting.clear();
      opening.clear();
      sessionReady.clear();
      sessionIdentities.clear();
      generations.clear();
      recovering.clear();
      recycling.clear();
      createParams.clear();
      control = null;
      await deps.supervisor.stopAll();
    },
  };

  return service;
}
