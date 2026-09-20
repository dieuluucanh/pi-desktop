import type { HostMethod, HostRole } from "../shared/host-protocol";
import type { TrustAnswer } from "../shared/projects";
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
export const DEFAULT_COALESCE_MS = 33;
export const DEFAULT_COALESCE_BYTES = 1024;
export const DEFAULT_MAX_TABS = 8;

/** The narrow supervisor surface this service drives. */
export interface SupervisorHostLike {
  readonly sessionId: string;
  status(): string;
  request(method: HostMethod, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
  on(event: string, listener: (payload: unknown) => void): () => void;
  /** Optional so simple test doubles stay simple; the real host implements it. */
  rememberSessionFile?(sessionFile: string): void;
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
  closeTab(tabId: string): Promise<SessionTabsEnvelope>;
  /** Closes every tab except `tabId` (the tab strip's "close others", step 11). */
  closeOthers(tabId: string): Promise<SessionTabsEnvelope>;
  /** Moves a tab to `toIndex`, persisted so the strip order survives a relaunch. */
  reorderTab(tabId: string, toIndex: number): Promise<SessionTabsEnvelope>;
  request(tabId: string, method: HostMethod, params?: unknown): Promise<unknown>;
  /** Re-spawns the last active tab in the background (plan step 24 pre-warm). */
  prewarmLast(): Promise<void>;
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

  const flushPending = (tabId: string): void => {
    const timer = timers.get(tabId);
    if (timer) {
      clearTimeout(timer);
      timers.delete(tabId);
    }
    const entries = pending.get(tabId);
    pending.delete(tabId);
    if (entries && entries.length > 0) pushEntries(tabId, entries);
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
      flushPending(tabId);
      return;
    }
    if (!timers.has(tabId)) {
      const timer = setTimeout(() => flushPending(tabId), coalesceMs);
      unrefTimer(timer);
      timers.set(tabId, timer);
    }
  };

  const emitState = (tabId: string, state: unknown): void => {
    deps.emit("state", { tabId, state } satisfies SessionStateEnvelope);
  };

  const applySnapshot = (tab: TabRecord, snapshot: unknown): void => {
    const record = asRecord(snapshot) as SnapshotLike;
    if (typeof record.sessionFile === "string") tab.sessionFile = record.sessionFile;
    if (typeof record.sessionName === "string" && record.sessionName.length > 0) {
      tab.title = record.sessionName;
    }
    const model = record.model;
    if (model && typeof model === "object" && typeof model.id === "string") tab.model = model.id;
    tab.status = record.streaming === true ? "running" : "idle";
    delete tab.error;
    emitState(tab.id, snapshot);
    publishTabs();
  };

  const refreshState = async (tab: TabRecord, host: SupervisorHostLike): Promise<void> => {
    try {
      const snapshot = await host.request("state.get");
      applySnapshot(tab, snapshot);
      rememberSession(host, tab);
    } catch {
      // A state refresh is best effort: the tab keeps the status it had.
    }
  };

  /**
   * Tells the supervisor which session file to resume after a crash. Without
   * this a restarted host would silently come back with an empty session, because
   * the spawn spec predates the session file.
   */
  const rememberSession = (host: SupervisorHostLike, tab: TabRecord): void => {
    if (tab.sessionFile) host.rememberSessionFile?.(tab.sessionFile);
  };

  const subscribe = (tab: TabRecord, host: SupervisorHostLike): void => {
    const off = [
      host.on("event", (payload) => {
        const entry = toEntry(payload);
        if (!entry) return;
        if (entry.event === "state") {
          flushPending(tab.id);
          emitState(tab.id, entry.payload);
          const state = asRecord(entry.payload);
          tab.status = state.streaming === true ? "running" : "idle";
          publishTabs();
          return;
        }
        if (entry.event === "message_update") {
          accumulate(tab.id, entry);
          return;
        }
        flushPending(tab.id);
        pushEntries(tab.id, [entry]);
      }),
      host.on("status", (status) => {
        const next = String(status);
        if (next === "ready") setStatus(tab, tab.status === "running" ? "running" : "idle");
        else if (next === "failed") setStatus(tab, "failed");
        else if (next === "stopped") setStatus(tab, "stopped");
      }),
      host.on("crashed", (payload) => {
        flushPending(tab.id);
        setStatus(tab, "crashed");
        pushEntries(tab.id, [{ event: "session.crashed", payload }]);
      }),
      host.on("resumed", (payload) => {
        flushPending(tab.id);
        setStatus(tab, "idle");
        pushEntries(tab.id, [{ event: "session.recovered", payload }]);
        void refreshState(tab, host);
      }),
    ];
    unsubscribes.set(tab.id, off);
  };

  const ensureHost = async (tab: TabRecord): Promise<SupervisorHostLike> => {
    const existing = hosts.get(tab.id);
    if (existing) return existing;
    setStatus(tab, "starting");

    const host = await deps.supervisor.start({
      sessionId: tab.id,
      cwd: tab.cwd,
      role: "session",
      officeHost: tab.kind === "office",
      sessionFile: tab.sessionFile,
    });
    hosts.set(tab.id, host);
    subscribe(tab, host);
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
      applySnapshot(tab, snapshot);
      rememberSession(host, tab);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(tab, "failed", message);
      throw error;
    }
    return host;
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

    async restoreTabs() {
      const state = await deps.store.read();
      tabs.clear();
      hosts.clear();
      for (const tab of sanitizeTabs(state.tabs).slice(0, maxTabs)) {
        // Nothing is running yet after a relaunch: a restored tab is "stopped"
        // until the user activates it (or `prewarmLast` does).
        tabs.set(tab.id, { ...tab, status: "stopped" });
      }
      const persistedActive = typeof state.activeTabId === "string" ? state.activeTabId : null;
      activeId = persistedActive && tabs.has(persistedActive) ? persistedActive : null;
      publishTabs();
      return envelope();
    },

    async createTab(input) {
      if (disposed) throw new SessionServiceError("session service is disposed", "disposed");
      if (typeof input.cwd !== "string" || input.cwd.length === 0) {
        throw new SessionServiceError("createTab requires a project folder", "bad_request");
      }
      if (tabs.size >= maxTabs) {
        throw new SessionServiceError(
          `session limit reached (${maxTabs}); close a tab first`,
          "too_many_tabs",
        );
      }
      const id = newId();
      const timestamp = now();
      const tab: TabRecord = {
        id,
        kind: input.kind ?? "session",
        cwd: input.cwd,
        title: sessionTitle(input.cwd),
        sessionFile: input.sessionFile ?? null,
        status: "starting",
        createdAt: timestamp,
        lastActiveAt: timestamp,
        model: null,
      };
      tabs.set(id, tab);
      activeId = id;
      if (input.model || input.thinking || input.trust) {
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
      await ensureHost(tab);
      await persist();
      return envelope();
    },

    async closeTab(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) return envelope();
      flushPending(tabId);
      timers.delete(tabId);
      pending.delete(tabId);
      for (const off of unsubscribes.get(tabId) ?? []) off();
      unsubscribes.delete(tabId);
      hosts.delete(tabId);
      createParams.delete(tabId);
      tabs.delete(tabId);
      try {
        await deps.supervisor.stop(tabId);
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

    async request(tabId, method, params) {
      // The control host is addressed like a tab so the renderer has one channel
      // for every host (plan D-A3); it simply has no per-session state.
      if (tabId === CONTROL_TAB_ID) {
        const host = await service.controlHost();
        return host.request(method, params);
      }
      const tab = requireTab(tabId);
      const host = await ensureHost(tab);
      return host.request(method, params);
    },

    async prewarmLast() {
      const tab = [...tabs.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
      if (!tab) return;
      try {
        await ensureHost(tab);
      } catch {
        // Pre-warming is an optimization; failing it must not disturb startup.
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
      for (const list of unsubscribes.values()) for (const off of list) off();
      unsubscribes.clear();
      for (const off of controlUnsubscribes.splice(0)) off();
      hosts.clear();
      control = null;
      await deps.supervisor.stopAll();
    },
  };

  return service;
}
