import type { HostMethod, HostRole } from "../shared/host-protocol";
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
  MAX_HOSTS,
  MAX_TABS,
  capacity,
  capacityMessage,
  type Capacity,
  type HostMemoryMetrics,
} from "../shared/performance";
import { sanitizeWebUrl, webTabTitle } from "../shared/web-tabs";
import {
  CONTROL_TAB_ID,
  sanitizeTabs,
  sessionTitle,
  type CreateTabInput,
  type SessionEventEnvelope,
  type SessionEventEntry,
  type SessionStateEnvelope,
  type SessionTabsEnvelope,
  type TabRecord,
  type TabStatus,
} from "../shared/session-ipc";

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
export const DEFAULT_MAX_TABS = MAX_TABS;

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
  /** The tail of the host's own log (plan step 22). Optional for test doubles. */
  logs?(): string[];
  shutdown(): Promise<void>;
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
  stop(sessionId: string): Promise<void>;
  stopAll(): Promise<void>;
  /** Used/limit of the host cap (plan step 24). Optional for test doubles. */
  capacity?(): Capacity;
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
  maxTabs?: number;
}

export interface SessionService {
  /** Lazily starts (and returns) the control host. */
  controlHost(): Promise<SupervisorHostLike>;
  tabs(): TabRecord[];
  activeTabId(): string | null;
  envelope(): SessionTabsEnvelope;
  restoreTabs(): Promise<SessionTabsEnvelope>;
  createTab(input: CreateTabInput): Promise<SessionTabsEnvelope>;
  activateTab(tabId: string): Promise<SessionTabsEnvelope>;
  /**
   * Makes the tab table truthful about host/session readiness after a suspend,
   * a lost process, or a renderer that missed pushes. It never spawns; the next
   * interaction/wake does that.
   */
  reconcile(): Promise<SessionTabsEnvelope>;
  closeTab(tabId: string): Promise<SessionTabsEnvelope>;
  /** Closes every tab except `tabId` (the tab strip's "close others", step 11). */
  closeOthers(tabId: string): Promise<SessionTabsEnvelope>;
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
   * Stops and re-spawns a tab's host, resuming its session from the JSONL
   * (plan step 22). This is the recovery action for a crashed or wedged host.
   */
  restartTab(tabId: string): Promise<SessionTabsEnvelope>;
  /** Failures seen this run, newest first (plan step 22 Diagnostics). */
  incidents(): Incident[];
  /** Which host is behind each tab, plus its log tail (plan step 22 Diagnostics). */
  diagnosticsHosts(): DiagnosticsHostInfo[];
  /** Used/limit of the running host and tab caps (plan step 24 backpressure). */
  capacity(): { hosts: Capacity; tabs: Capacity };
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
    code === "no_session" ||
    code === "host_not_running"
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
  return "payload" in record ? { event, payload: record.payload } : { event };
}

export function createSessionService(deps: SessionServiceDeps): SessionService {
  const now = deps.now ?? ((): number => Date.now());
  const newId = deps.newId ?? ((): string => `tab-${Math.random().toString(36).slice(2, 10)}`);
  const coalesceMs = deps.coalesceMs ?? DEFAULT_COALESCE_MS;
  const coalesceBytes = deps.coalesceBytes ?? DEFAULT_COALESCE_BYTES;
  const maxTabs = deps.maxTabs ?? DEFAULT_MAX_TABS;

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
   */
  const opening = new Map<string, Promise<SupervisorHostLike>>();
  /** Tabs whose host has confirmed `session.create`/`resume` / a state frame. */
  const sessionReady = new Set<string>();
  /**
   * Per-tab generation, bumped by every detach. A late spawn/open compares it
   * and stops the process it just started instead of publishing a stale host.
   */
  const generations = new Map<string, number>();
  /** Tabs recovering from an unexpected crash (drives the recovered notice). */
  const recovering = new Set<string>();
  /**
   * In-flight stop+respawn of a stale host, per tab (2026-10-24 stale-host
   * plan). Two completion requests from the same keystroke burst must share one
   * recycle, or they would stop each other's freshly spawned host.
   */
  const recycling = new Map<string, Promise<SupervisorHostLike>>();
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

  let activeId: string | null = null;
  let control: SupervisorHostLike | null = null;
  let disposed = false;

  const envelope = (): SessionTabsEnvelope => ({
    tabs: [...tabs.values()].map((tab) => ({ ...tab })),
    activeTabId: activeId,
  });

  const publishTabs = (): void => {
    deps.emit("tabs", envelope());
  };

  const persist = async (): Promise<void> => {
    await deps.store.update({ tabs: [...tabs.values()], activeTabId: activeId });
  };

  const requireTab = (tabId: string): TabRecord => {
    const tab = tabs.get(tabId);
    if (!tab) throw new SessionServiceError(`unknown session tab: ${tabId}`, "unknown_tab");
    return tab;
  };

  const setStatus = (tab: TabRecord, status: TabStatus, error?: string): void => {
    tab.status = status;
    if (error === undefined) delete tab.error;
    else tab.error = error;
    publishTabs();
  };

  const unrefTimer = (timer: ReturnType<typeof setTimeout>): void => {
    if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
  };

  const pushEntries = (tabId: string, entries: SessionEventEntry[]): void => {
    if (entries.length === 0) return;
    const seq = (sequences.get(tabId) ?? 0) + 1;
    sequences.set(tabId, seq);
    deps.emit("event", { tabId, seq, events: entries } satisfies SessionEventEnvelope);
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
    deps.emit("state", { tabId, state } satisfies SessionStateEnvelope);
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
  const hostIsBusy = (snapshot: unknown): boolean => {
    const record = asRecord(snapshot);
    const nonEmpty = (value: unknown): boolean => Array.isArray(value) && value.length > 0;
    return (
      record.streaming === true ||
      record.compacting === true ||
      record.retrying === true ||
      (typeof record.pendingMessages === "number" && record.pendingMessages > 0) ||
      nonEmpty(record.steering) ||
      nonEmpty(record.followUp)
    );
  };

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
    recovering.delete(tabId);
  };

  /**
   * Stops a tab's host and drops everything tied to it, leaving it stopped.
   * The generation bump makes any in-flight spawn/open stop the process it just
   * created instead of publishing it over the replacement.
   */
  const detachHost = async (tabId: string): Promise<void> => {
    generations.set(tabId, (generations.get(tabId) ?? 0) + 1);
    // Do not let a new spawn reuse the old open promise; the generation guard is
    // what cancels the late completion.
    opening.delete(tabId);
    forgetHost(tabId);
    try {
      await deps.supervisor.stop(tabId);
    } catch {
      // A host that is already gone is exactly the state we want.
    }
    const tab = tabs.get(tabId);
    if (tab) {
      tab.status = "stopped";
      publishTabs();
    }
  };

  const subscribe = (tab: TabRecord, host: SupervisorHostLike): void => {
    const off = [
      host.on("event", (payload) => {
        const entry = toEntry(payload);
        if (!entry) return;
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
          // the next interaction spawns/resumes a fresh one.
          forgetHost(tab.id);
          setStatus(tab, "stopped");
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
    const generation = generations.get(tab.id) ?? 0;
    const host = await deps.supervisor.start({
      sessionId: tab.id,
      cwd: tab.cwd,
      role: "session",
      officeHost: tab.kind === "office",
      sessionFile: tab.sessionFile,
    });
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
    if (tab.kind === "web") {
      throw new SessionServiceError("a web tab has no Pi host", "web_tab");
    }
    const inFlight = starting.get(tab.id);
    if (inFlight) return inFlight;
    const existing = hosts.get(tab.id);
    if (existing && existing.status() === "ready") return existing;
    if (existing) await detachHost(tab.id);
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
      // A trust refusal leaves a live host so the renderer's prompt can retry
      // `session.create`; every other failure drops the process so the next
      // ensure starts cleanly rather than talking to a sessionless host.
      if (host.status() !== "ready") await detachHost(tab.id);
      const message = error instanceof Error ? error.message : String(error);
      setStatus(tab, "failed", message);
      throw error;
    }
  };

  /**
   * The interaction entry point: a live host with an open session. Coalesces
   * concurrent callers; repairs a sessionless/dead host with a fresh process
   * and one open. `ready` is never returned before this settles.
   */
  const ensureSession = async (tab: TabRecord): Promise<SupervisorHostLike> => {
    if (tab.kind === "web") {
      throw new SessionServiceError("a web tab has no Pi host", "web_tab");
    }
    const inFlight = opening.get(tab.id);
    if (inFlight) return inFlight;
    // Capture before `detachHost` clears it: a crash recovery gets one notice,
    // a normal open/wake does not.
    const wasRecovering = recovering.has(tab.id);
    const reason = wasRecovering ? "recover" : "spawn";
    const run = (async (): Promise<SupervisorHostLike> => {
      let host = await ensureProcess(tab);
      if (host.status() === "ready" && sessionReady.has(tab.id)) return host;
      if (host.status() === "ready") return openSession(tab, host, reason);
      // The supervisor is restarting, failed, or has no child: preempt its
      // backoff with a deterministic fresh process, then open once.
      await detachHost(tab.id);
      host = await ensureProcess(tab);
      return openSession(tab, host, reason);
    })();
    opening.set(tab.id, run);
    void run.then(
      () => {
        if (opening.get(tab.id) === run) opening.delete(tab.id);
      },
      () => {
        if (opening.get(tab.id) === run) opening.delete(tab.id);
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
      logLines: host.logs?.() ?? [],
    };
  };

  const service: SessionService = {
    async controlHost() {
      if (control) return control;
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
    envelope,

    incidents: () => [...incidents],
    extensionErrors: () => [...extensionErrors],
    capacity: () => ({
      hosts: deps.supervisor.capacity?.() ?? capacity(hosts.size + (control ? 1 : 0), MAX_HOSTS),
      tabs: capacity(tabs.size, maxTabs),
    }),
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
          logLines: [],
        });
      }
      return rows;
    },

    async restoreTabs() {
      const state = await deps.store.read();
      tabs.clear();
      hosts.clear();
      starting.clear();
      opening.clear();
      sessionReady.clear();
      generations.clear();
      recovering.clear();
      for (const tab of sanitizeTabs(state.tabs).slice(0, maxTabs)) {
        // Nothing is running yet after a relaunch: a restored tab is "stopped"
        // until the user activates it (or `prewarmLast` does). A web tab has no
        // host to stop, so it is idle from the start (plan step 21).
        tabs.set(tab.id, { ...tab, status: tab.kind === "web" ? "idle" : "stopped" });
      }
      const persistedActive = typeof state.activeTabId === "string" ? state.activeTabId : null;
      activeId = persistedActive && tabs.has(persistedActive) ? persistedActive : null;
      publishTabs();
      return envelope();
    },

    async createTab(input) {
      if (disposed) throw new SessionServiceError("session service is disposed", "disposed");
      const kind = input.kind ?? "session";
      // A web tab carries a URL and needs no project folder; every other kind
      // needs a session host and therefore a cwd.
      const webUrl = kind === "web" ? sanitizeWebUrl(input.url) : null;
      if (kind === "web") {
        if (!webUrl) throw new SessionServiceError("createTab requires a web URL", "bad_request");
      } else if (typeof input.cwd !== "string" || input.cwd.length === 0) {
        throw new SessionServiceError("createTab requires a project folder", "bad_request");
      }
      if (tabs.size >= maxTabs) {
        throw new SessionServiceError(
          `session limit reached (${maxTabs}); close a tab first. ${capacityMessage("tabs", maxTabs)}`,
          "too_many_tabs",
        );
      }
      const id = newId();
      const timestamp = now();
      const cwd = typeof input.cwd === "string" ? input.cwd : "";
      const tab: TabRecord = {
        id,
        kind,
        cwd,
        title: kind === "web" ? webTabTitle(webUrl) : sessionTitle(cwd),
        sessionFile: input.sessionFile ?? null,
        status: kind === "web" ? "idle" : "starting",
        createdAt: timestamp,
        lastActiveAt: timestamp,
        model: null,
        ...(kind === "web" ? { url: webUrl, sessionTabId: input.sessionTabId ?? null } : {}),
      };
      tabs.set(id, tab);
      activeId = id;
      if (kind !== "web" && (input.model || input.thinking || input.trust)) {
        createParams.set(id, {
          ...(input.model ? { model: input.model } : {}),
          ...(input.thinking ? { thinking: input.thinking } : {}),
          ...(input.trust ? { trust: input.trust } : {}),
        });
      }
      publishTabs();
      await persist();
      await service.activateTab(id);
      return envelope();
    },

    async activateTab(tabId) {
      const tab = requireTab(tabId);
      activeId = tabId;
      tab.lastActiveAt = now();
      publishTabs();
      // A web tab has no host to start (plan step 21); main's web-tab manager
      // reconciles the view from the tab table instead.
      if (tab.kind !== "web") await ensureSession(tab);
      await persist();
      return envelope();
    },

    async reconcile() {
      for (const tab of tabs.values()) {
        if (tab.kind === "web") continue;
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
      createParams.delete(tabId);
      tabs.delete(tabId);
      try {
        // A web tab has no supervisor host to stop (plan step 21).
        if (tab.kind !== "web") await deps.supervisor.stop(tabId);
      } catch {
        // A host that is already gone is not an error for the user.
      }
      if (activeId === tabId) {
        const next = [...tabs.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
        activeId = next ? next.id : null;
      }
      publishTabs();
      await persist();
      return envelope();
    },

    async closeOthers(tabId) {
      if (!tabs.has(tabId)) return envelope();
      for (const id of [...tabs.keys()]) {
        if (id !== tabId) await service.closeTab(id);
      }
      return envelope();
    },

    async reorderTab(tabId, toIndex) {
      const order = [...tabs.keys()];
      const from = order.indexOf(tabId);
      if (from === -1) return envelope();
      const target = Math.max(0, Math.min(order.length - 1, Math.floor(toIndex)));
      if (target === from) return envelope();
      order.splice(from, 1);
      order.splice(target, 0, tabId);
      // Rebuild the map in the new order: the tab table's insertion order *is*
      // the strip order, so this is the only place it is defined.
      const entries = order
        .map((id) => [id, tabs.get(id)] as const)
        .filter((entry): entry is readonly [string, TabRecord] => entry[1] !== undefined);
      tabs.clear();
      for (const [id, record] of entries) tabs.set(id, record);
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

      // One office host only: demote every other `office` tab and stop its host
      // so port 38617 is free for the promoted tab (plan step 20 acceptance).
      for (const [id, record] of [...tabs]) {
        if (id === tabId || record.kind !== "office") continue;
        recycling.delete(id);
        await detachHost(id);
        tabs.set(id, { ...record, kind: "session", status: "stopped" });
      }

      // Restart the promoted tab so its host is spawned with `officeHost: true`.
      recycling.delete(tabId);
      await detachHost(tabId);
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
        return host.request(method, params);
      }
      const tab = requireTab(tabId);
      // Explicit session lifecycle commands bypass auto-open: the caller owns
      // the operation (trust retry, /new, fork). Only the process is ensured.
      if (SESSION_ESTABLISHING_METHODS.has(method)) {
        const inFlight = opening.get(tab.id);
        if (inFlight) await inFlight.catch(() => undefined);
        const host = await ensureProcess(tab);
        const result = await host.request(method, params);
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
        return await host.request(method, params);
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
            if (READ_ONLY_RETRY_METHODS.has(method)) return await host.request(method, params);
          } catch {
            // Keep the original error: it names the operation that failed.
          }
          if (method === "prompt") {
            throw new SessionServiceError(
              "The session host restarted before it received your prompt. Your draft is intact — press Enter to try again.",
              "session_lost",
            );
          }
        }
        throw error;
      }
    },

    async restartTab(tabId) {
      const tab = requireTab(tabId);
      if (tab.kind === "web") {
        throw new SessionServiceError("a web tab has no Pi host to restart", "web_tab");
      }
      // Let an in-flight stale recycle settle first; otherwise it could spawn a
      // host after this detach and leave two processes for one tab.
      const inFlightRecycle = recycling.get(tabId);
      if (inFlightRecycle) await inFlightRecycle.catch(() => undefined);
      recycling.delete(tabId);
      // Detach the old host the same way `closeTab` does, then let `activateTab`
      // spawn a fresh one. The session file is untouched, so history returns.
      await detachHost(tabId);
      return service.activateTab(tabId);
    },

    async prewarmLast() {
      const tab = [...tabs.values()]
        .filter((entry) => entry.kind !== "web")
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
