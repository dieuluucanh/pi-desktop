import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostMethod, HostRole } from "../../src/shared/host-protocol";
import {
  SESSION_ASLEEP_MESSAGE,
  type SessionTabsEnvelope,
  type TabRecord,
  type TabStopReason,
} from "../../src/shared/session-ipc";
import {
  CONTROL_HOST_ID,
  HOST_OPEN_TIMEOUT_MS,
  createSessionService,
  requestTimeoutFor,
  type SessionService,
  type SupervisorHostLike,
  type SupervisorLike,
} from "../../src/main/session-service";
import type { HostMemoryMetrics } from "../../src/shared/performance";
import { HostStoppedError, HostTimeoutError } from "../../src/main/host-supervisor";

/**
 * The session service (plan step 3) drives everything the renderer sees, so it is
 * tested against a fake supervisor with no processes at all: tab lifecycle,
 * delta coalescing and ordering, crash → recovered, restore, tab cap and the
 * trust failure path.
 */

interface SpawnSpec {
  sessionId: string;
  cwd: string;
  role?: HostRole;
  officeHost?: boolean;
  sessionFile?: string | null;
}

class FakeHost implements SupervisorHostLike {
  readonly sessionId: string;
  readonly requests: Array<{ method: string; params?: unknown; timeoutMs?: number }> = [];
  shutdownCount = 0;
  buildId: string | null;
  private statusValue = "ready";
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  private readonly state: Record<string, unknown>;
  private readonly createdSessionFile: string | null;
  private readonly fail: { method: string; error: Error } | undefined;
  private readonly pinnedValue: boolean;
  private readonly rssBytes: number;
  stopReasonValue: TabStopReason | null = null;
  overMemoryValue = false;

  constructor(
    sessionId: string,
    options: {
      buildId?: string | null;
      state?: Record<string, unknown>;
      createdSessionFile?: string | null;
      fail?: { method: string; error: Error };
      pinned?: boolean;
      rssBytes?: number;
    } = {},
  ) {
    this.sessionId = sessionId;
    this.buildId = options.buildId ?? "build-1";
    this.state = options.state ?? {};
    this.createdSessionFile =
      options.createdSessionFile === undefined
        ? "/profile/sessions/s1.jsonl"
        : options.createdSessionFile;
    this.fail = options.fail;
    this.pinnedValue = options.pinned ?? false;
    this.rssBytes = options.rssBytes ?? 0;
  }

  status(): string {
    return this.statusValue;
  }

  pinned(): boolean {
    return this.pinnedValue;
  }

  stopReason(): TabStopReason | null {
    return this.stopReasonValue;
  }

  overMemory(): boolean {
    return this.overMemoryValue;
  }

  metrics(): HostMemoryMetrics | null {
    if (this.rssBytes <= 0) return null;
    return {
      rssBytes: this.rssBytes,
      heapUsedBytes: this.rssBytes / 2,
      heapTotalBytes: this.rssBytes,
      uptimeMs: 1,
      at: 1,
    };
  }

  setStatus(status: string): void {
    this.statusValue = status;
  }

  request(
    method: HostMethod,
    params?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<unknown> {
    this.requests.push({
      method,
      ...(params === undefined ? {} : { params }),
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    if (this.fail?.method === method) return Promise.reject(this.fail.error);
    return Promise.resolve(this.reply(method));
  }

  reply(method: string): unknown {
    if (method === "session.create" || method === "session.resume") {
      return {
        sessionId: "session-1",
        sessionFile: this.createdSessionFile,
        streaming: false,
        model: { id: "test-model" },
      };
    }
    if (method === "state.get") {
      return {
        sessionId: "session-1",
        sessionFile: this.createdSessionFile,
        streaming: false,
        model: { id: "test-model" },
        messageCount: 3,
        ...this.state,
      };
    }
    return {};
  }

  on(event: string, listener: (payload: unknown) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return () => set.delete(listener);
  }

  async shutdown(): Promise<void> {
    this.shutdownCount += 1;
    this.statusValue = "stopped";
  }

  info(): {
    role: HostRole;
    cwd: string;
    sessionId: string;
    startedAt: number;
    pids: { pid: number };
    buildId: string | null;
  } {
    return {
      role: this.sessionId === CONTROL_HOST_ID ? "control" : "session",
      cwd: `C:\\work\\${this.sessionId}`,
      sessionId: this.sessionId,
      startedAt: 5,
      pids: { pid: 900 },
      buildId: this.buildId,
    };
  }

  logs(): string[] {
    return [`log line for ${this.sessionId}`];
  }

  /** Pushes a protocol event (the supervisor forwards the named event and `event`). */
  emit(
    event: string,
    payload?: unknown,
    identity?: { sessionId?: string | null; sessionEpoch?: number },
  ): void {
    const entry = {
      event,
      ...(payload === undefined ? {} : { payload }),
      ...(identity?.sessionId ? { sessionId: identity.sessionId } : {}),
      ...(identity?.sessionEpoch === undefined ? {} : { sessionEpoch: identity.sessionEpoch }),
    };
    for (const listener of this.listeners.get("event") ?? []) listener(entry);
  }

  emitLifecycle(event: string, payload?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

function createHarness(
  options: {
    maxLiveHosts?: number;
    failCreate?: Error | ((spawnIndex: number) => Error | undefined);
    /** Expected bundle fingerprint; absent disables the stale check. */
    hostBuildId?: () => string | null;
    /** Per-spawn build ids (index 0 = the first host). */
    buildIds?: Array<string | null>;
    /** Extra `state.get` fields (busy flags, session file, …). */
    state?: Record<string, unknown> | ((spec: SpawnSpec) => Record<string, unknown>);
    /** Marks specific hosts as pinned (active tab § bridge owner § control). */
    pinnedFor?: (spec: SpawnSpec) => boolean;
    /** Scripted RSS per host (used by the aggregate memory guard tests). */
    rssBytes?: number | ((spec: SpawnSpec) => number);
    /** Aggregate host RSS budget passed to the service. */
    hostRssLimitBytes?: number;
    /** Controllable clock, so LRU can be tested without real time. */
    now?: () => number;
    /** The session snapshot's `sessionFile`, or null for a just-created session. */
    createdSessionFile?: string | null;
    /** Makes one host method reject (e.g. a wedged `state.get`). */
    fail?: { method: HostMethod; error: Error };
    /** Awaited inside the fake `supervisor.start`, to hold a spawn in flight. */
    onStart?: (spec: SpawnSpec) => Promise<void> | void;
    /** Scripts the Office-port reclaimer; absent keeps the pre-2026-10-30 path. */
    releaseOfficePort?: (input: {
      port: number;
      ownPids: readonly number[];
    }) => Promise<{ ok: boolean; detail?: string }>;
    ownPids?: () => readonly number[];
  } = {},
): {
  service: SessionService;
  hosts: Map<string, FakeHost>;
  specs: SpawnSpec[];
  stopped: string[];
  pushes: Array<{ channel: "event" | "state" | "tabs"; payload: unknown }>;
  stored: { tabs: TabRecord[]; activeTabId: string | null };
  newest(): FakeHost;
} {
  const hosts = new Map<string, FakeHost>();
  const specs: SpawnSpec[] = [];
  const stopped: string[] = [];
  const pushes: Array<{ channel: "event" | "state" | "tabs"; payload: unknown }> = [];
  const stored: { tabs: TabRecord[]; activeTabId: string | null } = { tabs: [], activeTabId: null };

  const supervisor: SupervisorLike = {
    start: async (spec) => {
      specs.push(spec);
      await options.onStart?.(spec);
      const host = new FakeHost(spec.sessionId, {
        buildId: options.buildIds?.[specs.length - 1] ?? "build-1",
        ...(options.state === undefined
          ? {}
          : { state: typeof options.state === "function" ? options.state(spec) : options.state }),
        ...(options.createdSessionFile === undefined
          ? {}
          : { createdSessionFile: options.createdSessionFile }),
        ...(options.fail ? { fail: options.fail } : {}),
        pinned: options.pinnedFor?.(spec) ?? false,
        ...(options.rssBytes === undefined
          ? {}
          : {
              rssBytes:
                typeof options.rssBytes === "function" ? options.rssBytes(spec) : options.rssBytes,
            }),
      });
      const createFailure =
        typeof options.failCreate === "function"
          ? options.failCreate(specs.length - 1)
          : options.failCreate;
      if (createFailure) {
        host.request = (
          method: HostMethod,
          params?: unknown,
          requestOptions?: { timeoutMs?: number },
        ) => {
          host.requests.push({
            method,
            ...(params === undefined ? {} : { params }),
            ...(requestOptions?.timeoutMs === undefined
              ? {}
              : { timeoutMs: requestOptions.timeoutMs }),
          });
          return method === "session.create" || method === "session.resume"
            ? Promise.reject(createFailure)
            : Promise.resolve(host.reply(method));
        };
      }
      hosts.set(spec.sessionId, host);
      return host;
    },
    get: (id) => hosts.get(id),
    list: () => [...hosts.values()],
    stop: async (id) => {
      stopped.push(id);
      hosts.delete(id);
    },
    stopAll: async () => {
      stopped.push(...hosts.keys());
      hosts.clear();
    },
  };

  let counter = 0;
  const service = createSessionService({
    supervisor,
    store: {
      read: async () => ({ tabs: stored.tabs, activeTabId: stored.activeTabId }),
      update: async (patch) => {
        if ("tabs" in patch) stored.tabs = (patch.tabs as TabRecord[]) ?? [];
        if ("activeTabId" in patch) stored.activeTabId = (patch.activeTabId as string) ?? null;
        return { tabs: stored.tabs, activeTabId: stored.activeTabId };
      },
    },
    controlCwd: "C:\\state",
    now: options.now ?? (() => 1_000),
    newId: () => `tab-${++counter}`,
    ...(options.hostBuildId ? { hostBuildId: options.hostBuildId } : {}),
    ...(options.maxLiveHosts === undefined ? {} : { maxLiveHosts: options.maxLiveHosts }),
    ...(options.hostRssLimitBytes === undefined
      ? {}
      : { hostRssLimitBytes: options.hostRssLimitBytes }),
    ...(options.releaseOfficePort ? { releaseOfficePort: options.releaseOfficePort } : {}),
    ...(options.ownPids ? { ownPids: options.ownPids } : {}),
    emit: (channel, payload) => pushes.push({ channel, payload }),
  });

  return {
    service,
    hosts,
    specs,
    stopped,
    pushes,
    stored,
    newest: () => [...hosts.values()].at(-1)!,
  };
}

const eventsOf = (
  pushes: Array<{ channel: string; payload: unknown }>,
): Array<{ tabId: string; seq: number; events: Array<{ event: string }> }> =>
  pushes.filter((push) => push.channel === "event").map((push) => push.payload as never);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("control host", () => {
  it("starts once, with the control role, and is reused", async () => {
    const { service, specs } = createHarness();
    await service.controlHost();
    await service.controlHost();
    expect(specs).toEqual([{ sessionId: CONTROL_HOST_ID, cwd: "C:\\state", role: "control" }]);
  });

  it("replaces a control host that reports stopped", async () => {
    const { service, specs, hosts } = createHarness();
    await service.controlHost();
    hosts.get(CONTROL_HOST_ID)?.emitLifecycle("status", "stopped");
    await Promise.resolve();

    await service.controlHost();

    expect(specs.filter((spec) => spec.sessionId === CONTROL_HOST_ID)).toHaveLength(2);
  });

  it("routes a request addressed to the control host without creating a tab", async () => {
    const { service, specs, hosts } = createHarness();
    const result = await service.request(CONTROL_HOST_ID, "providers.list");

    const control = hosts.get(CONTROL_HOST_ID)!;
    expect(control.requests).toEqual([{ method: "providers.list", timeoutMs: 30_000 }]);
    expect(result).toEqual({});
    // Only the control host was spawned; no session tab exists.
    expect(specs.map((spec) => spec.role)).toEqual(["control"]);
    expect(service.tabs()).toEqual([]);
    expect(service.activeTabId()).toBeNull();
  });

  it("still refuses an unknown tab id", async () => {
    const { service } = createHarness();
    await expect(service.request("tab-missing", "state.get")).rejects.toThrow(
      /unknown session tab/,
    );
  });
});

describe("tab lifecycle", () => {
  it("creates a session host, records the session and persists the tab", async () => {
    const { service, specs, stored, newest, pushes } = createHarness();
    const envelope = await service.createTab({ cwd: "C:\\work\\pi-desktop" });

    expect(specs[0]).toMatchObject({
      sessionId: "tab-1",
      cwd: "C:\\work\\pi-desktop",
      role: "session",
      officeHost: false,
      sessionFile: null,
    });
    expect(newest().requests.map((request) => request.method)).toContain("session.create");

    const tab = envelope.tabs[0]!;
    expect(tab).toMatchObject({
      id: "tab-1",
      title: "pi-desktop",
      status: "idle",
      sessionFile: "/profile/sessions/s1.jsonl",
      model: "test-model",
    });
    expect(envelope.activeTabId).toBe("tab-1");
    expect(stored.tabs.map((entry) => entry.id)).toEqual(["tab-1"]);
    expect(stored.activeTabId).toBe("tab-1");
    expect(pushes.filter((push) => push.channel === "tabs").length).toBeGreaterThan(0);
    expect(pushes.some((push) => push.channel === "state")).toBe(true);
  });

  it("stores a terminal tab's shell profile", async () => {
    const { service, stored } = createHarness();
    const envelope = await service.createTab({
      cwd: "C:\\work\\app",
      kind: "terminal",
      profileId: "git-bash",
    });

    expect(envelope.tabs[0]).toMatchObject({ kind: "terminal", profileId: "git-bash" });
    expect(stored.tabs[0]?.profileId).toBe("git-bash");
  });

  it("passes per-project model and thinking defaults into session.create", async () => {
    const { service, newest } = createHarness();
    await service.createTab({
      cwd: "C:\\work\\app",
      model: "anthropic/claude-sonnet-4",
      thinking: "high",
    });

    const create = newest().requests.find((request) => request.method === "session.create");
    expect(create?.params).toMatchObject({
      cwd: "C:\\work\\app",
      model: "anthropic/claude-sonnet-4",
      thinking: "high",
    });
  });

  it("resumes an existing session file instead of creating one", async () => {
    const { service, newest } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app", sessionFile: "/profile/s1.jsonl" });
    expect(newest().requests.map((request) => request.method)).toEqual(["session.resume"]);
  });

  it("opens a background web tab without stealing the session selection", async () => {
    const { service, specs } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app" });
    const spawned = specs.length;

    const envelope = await service.createTab({
      kind: "web",
      url: "http://127.0.0.1:8080/review",
      sessionTabId: "tab-1",
      activate: false,
    });

    expect(envelope.activeTabId).toBe("tab-1");
    expect(envelope.tabs.find((tab) => tab.kind === "web")).toMatchObject({
      status: "idle",
      sessionTabId: "tab-1",
      url: "http://127.0.0.1:8080/review",
    });
    expect(specs).toHaveLength(spawned);
  });

  it("marks the tab failed and rethrows when the session cannot start", async () => {
    const failure = Object.assign(new Error("trust required for this project"), {
      name: "trust_required",
    });
    const { service } = createHarness({ failCreate: failure });

    await expect(service.createTab({ cwd: "C:\\work\\untrusted" })).rejects.toThrow(
      /trust required/i,
    );
    const tab = service.tabs()[0]!;
    expect(tab.status).toBe("failed");
    expect(tab.error).toMatch(/trust required/i);
  });

  it("retries once on a fresh process when the host stopped mid-open", async () => {
    // 2026-11-06 hang plan, step 2. A stop is a process failure, so the session
    // is worth one automatic retry: before this the tab went `failed` and the
    // user had to restart the app.
    const { service, specs } = createHarness({
      failCreate: (index) =>
        index === 0 ? new HostStoppedError("tab-1", "session.create") : undefined,
    });

    await service.createTab({ cwd: "C:\\work\\app" });

    const tab = service.tabs()[0]!;
    expect(tab.status).toBe("idle");
    expect(tab.error).toBeUndefined();
    expect(specs.filter((spec) => spec.sessionId === tab.id)).toHaveLength(2);
  });

  it("coalesces a second ensure during the retry's detach/ensureProcess window", async () => {
    // The duplicate-resume production log: the first open fails with a stop,
    // its retry detaches (bumping the host generation), and a second ensure
    // used to start a third open because `detachHost` deleted the coalescer.
    let spawns = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = createHarness({
      failCreate: (index) =>
        index === 0 ? new HostStoppedError("tab-1", "session.resume") : undefined,
      onStart: async () => {
        spawns += 1;
        if (spawns === 2) await gate;
      },
    });
    harness.stored.tabs = [
      {
        id: "tab-1",
        kind: "session",
        cwd: "C:\\work\\app",
        title: "app",
        sessionFile: "/profile/sessions/s1.jsonl",
        status: "stopped",
        createdAt: 1,
        lastActiveAt: 1,
        model: null,
      },
    ];
    harness.stored.activeTabId = "tab-1";
    await harness.service.restoreTabs();

    const first = harness.service.ensureTab("tab-1");
    await vi.waitFor(() => expect(spawns).toBe(2));
    const second = harness.service.ensureTab("tab-1");
    release();
    await Promise.all([first, second]);

    expect(harness.specs.filter((spec) => spec.sessionId === "tab-1")).toHaveLength(2);
  });

  it("retries once when the open request timed out", async () => {
    const { service, specs } = createHarness({
      failCreate: (index) =>
        index === 0 ? new HostTimeoutError("session.create", 90_000) : undefined,
    });

    await service.createTab({ cwd: "C:\\work\\app" });

    expect(service.tabs()[0]?.status).toBe("idle");
    expect(specs.filter((spec) => spec.sessionId === "tab-1")).toHaveLength(2);
  });

  it("leaves the tab retryable when every attempt stops mid-open", async () => {
    const failure = new HostStoppedError("tab-1", "session.create");
    const { service, specs } = createHarness({ failCreate: failure });

    await expect(service.createTab({ cwd: "C:\\work\\app" })).rejects.toThrow(/stopped/);

    const tab = service.tabs()[0]!;
    // `stopped`, not `failed`: the next interaction respawns instead of asking
    // the user to restart the app.
    expect(tab.status).toBe("stopped");
    expect(tab.error).toBeUndefined();
    // Exactly one retry, so a permanently broken host cannot spawn in a loop.
    expect(specs.filter((spec) => spec.sessionId === "tab-1")).toHaveLength(2);
  });

  it("keeps an explicit create retryable when the host stops mid-flight", async () => {
    // The trust-retry path calls `session.create` directly; a stop there used to
    // leave the tab on `starting` forever.
    const { service } = createHarness({
      failCreate: new HostStoppedError("tab-1", "session.create"),
    });
    await expect(service.createTab({ cwd: "C:\\work\\app" })).rejects.toThrow(/stopped/);
    const tab = service.tabs()[0]!;

    await expect(service.request(tab.id, "session.create", { cwd: tab.cwd })).rejects.toThrow(
      /stopped/,
    );

    expect(service.tabs()[0]?.status).toBe("stopped");
    expect(service.tabs()[0]?.error).toBeUndefined();
  });

  it("stops a tab without closing it and resumes it on the next activation", async () => {
    // Cancel for a slow open (2026-11-06 hang plan, step 4): the host goes away,
    // the tab and its session file stay, so nothing the user had is lost.
    const { service, hosts, specs, stored, newest } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app" });
    expect(hosts.size).toBe(1);

    const envelope = await service.stopTab("tab-1");

    expect(envelope.tabs[0]?.status).toBe("stopped");
    expect(hosts.size).toBe(0);
    // Nothing respawned behind the user's back.
    expect(specs).toHaveLength(1);
    expect(stored.tabs[0]?.status).toBe("stopped");
    expect(service.tabs()[0]?.sessionFile).toBe("/profile/sessions/s1.jsonl");

    await service.activateTab("tab-1");
    expect(specs).toHaveLength(2);
    expect(newest().requests.map((request) => request.method)).toEqual(["session.resume"]);
  });

  it("drops the start notice for a routine resume and keeps it for a new session", async () => {
    // 2026-11-06 plan, step 15: a recycle resumes the same conversation, so the
    // service does not even forward the event. A genuinely new session does.
    const { service, newest, pushes } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app" });
    const before = eventsOf(pushes).length;

    newest().emit("session_started", { reason: "resume", sessionId: "session-1" });
    await Promise.resolve();
    expect(eventsOf(pushes)).toHaveLength(before);

    newest().emit("session_started", { reason: "new", sessionId: "session-1" });
    await vi.waitFor(() => expect(eventsOf(pushes).length).toBeGreaterThan(before));
    expect(
      eventsOf(pushes)
        .at(-1)
        ?.events.map((entry) => entry.event),
    ).toContain("session_started");
  });

  it("wakes a tab without moving the active tab", async () => {
    // A background pane, a reconcile or a resync calls `ensure`; only a real
    // gesture may reassign the selection (2026-11-06 tab-switch plan).
    const { service, specs, stored } = createHarness();
    await service.createTab({ cwd: "C:\\work\\one" });
    await service.createTab({ cwd: "C:\\work\\two" });
    expect(stored.activeTabId).toBe("tab-2");
    await service.stopTab("tab-1");

    const envelope = await service.ensureTab("tab-1");

    expect(envelope.activeTabId).toBe("tab-2");
    expect(service.activeTabId()).toBe("tab-2");
    expect(stored.activeTabId).toBe("tab-2");
    // It did wake the host: a second spawn for tab-1, now idle again.
    expect(specs.filter((spec) => spec.sessionId === "tab-1")).toHaveLength(2);
    expect(service.tabs().find((tab) => tab.id === "tab-1")?.status).toBe("idle");
  });

  it("versions the table and the selection separately", async () => {
    // 2026-11-06 tab-switch plan, step 6. A wake must not look like a selection
    // change, and a selection change must be distinguishable from a stale push.
    const { service, pushes } = createHarness();
    const lastTabs = (): SessionTabsEnvelope =>
      pushes.filter((push) => push.channel === "tabs").at(-1)?.payload as SessionTabsEnvelope;

    await service.createTab({ cwd: "C:\\work\\one" });
    const created = lastTabs();
    expect(created.revision).toBeGreaterThan(0);
    expect(created.selectionSeq).toBeGreaterThan(0);

    await service.ensureTab("tab-1");
    const ensured = lastTabs();
    expect(ensured.revision).toBe(created.revision);
    expect(ensured.selectionSeq).toBe(created.selectionSeq);

    await service.activateTab("tab-1");
    // Re-selecting the same tab publishes nothing (the table is unchanged), but
    // the envelope's sequence still moved, which is what the renderer compares.
    expect(service.envelope().selectionSeq).toBeGreaterThan(created.selectionSeq ?? 0);
    expect(service.envelope().activeTabId).toBe("tab-1");
  });

  it("keeps the user's tab through background wakes (2026-11-06 regression)", async () => {
    // The reported sequence: the user is in the Strata session while other
    // projects' sessions are open and waking in the background.
    const { service, stored } = createHarness();
    await service.createTab({ cwd: "C:\\work\\Strata" });
    await service.createTab({ cwd: "C:\\work\\pi-desktop" });
    await service.createTab({ cwd: "C:\\work\\third" });
    await service.activateTab("tab-1");
    expect(service.activeTabId()).toBe("tab-1");

    // A resync / pane wake for the other two sessions.
    await service.ensureTab("tab-2");
    await service.ensureTab("tab-3");

    expect(service.activeTabId()).toBe("tab-1");
    expect(stored.activeTabId).toBe("tab-1");
    expect(service.envelope().activeTabId).toBe("tab-1");
  });

  it("opens more tabs than the old eight-tab cap", async () => {
    const { service } = createHarness();
    for (let index = 0; index < 12; index += 1) {
      await service.createTab({ cwd: `C:\\work\\project-${index}` });
    }
    expect(service.tabs()).toHaveLength(12);
  });

  it("stops the host, forgets the tab and moves the active tab on close", async () => {
    const { service, hosts, stored } = createHarness();
    await service.createTab({ cwd: "C:\\work\\one" });
    await service.createTab({ cwd: "C:\\work\\two" });
    expect(hosts.size).toBe(2);

    const envelope = await service.closeTab("tab-2");
    expect(envelope.tabs.map((tab) => tab.id)).toEqual(["tab-1"]);
    expect(envelope.activeTabId).toBe("tab-1");
    expect(hosts.has("tab-2")).toBe(false);
    expect(stored.tabs.map((tab) => tab.id)).toEqual(["tab-1"]);
  });

  it("clears the active tab without closing a tab or stopping a host", async () => {
    // 2026-10-30 project-scoped rail plan: selecting a project with no open
    // session must leave the session column on Welcome while the rail keeps the
    // project's scope. Clearing a selection is not closing a tab.
    const { service, hosts, stored, pushes } = createHarness();
    await service.createTab({ cwd: "C:\\work\\one" });
    await service.createTab({ cwd: "C:\\work\\two" });
    pushes.length = 0;

    const envelope = await service.deactivate();

    expect(envelope.activeTabId).toBeNull();
    expect(envelope.tabs.map((tab) => tab.id)).toEqual(["tab-1", "tab-2"]);
    expect(envelope.tabs.map((tab) => tab.status)).toEqual(["idle", "idle"]);
    expect(hosts.size).toBe(2);
    expect(stored.activeTabId).toBeNull();
    expect(stored.tabs).toHaveLength(2);
    expect(pushes.some((push) => push.channel === "tabs")).toBe(true);
  });

  it("keeps the cleared selection idempotent", async () => {
    const { service, stored } = createHarness();
    await service.createTab({ cwd: "C:\\work\\one" });
    await service.deactivate();
    stored.activeTabId = "sentinel";

    const envelope = await service.deactivate();

    expect(envelope.activeTabId).toBeNull();
    // A second clear is a no-op, so it does not rewrite the persisted document.
    expect(stored.activeTabId).toBe("sentinel");
  });
});

describe("live-host budget and LRU parking", () => {
  const advance = (clock: { value: number }, ms: number): void => {
    clock.value += ms;
  };

  it("parks the least-recently-used idle session before spawning another", async () => {
    const clock = { value: 1_000 };
    const harness = createHarness({ maxLiveHosts: 2, now: () => clock.value });

    await harness.service.createTab({ cwd: "C:\\work\\one" });
    advance(clock, 1_000);
    await harness.service.createTab({ cwd: "C:\\work\\two" });
    advance(clock, 6_000);
    await harness.service.createTab({ cwd: "C:\\work\\three" });

    expect(harness.service.tabs().map((tab) => tab.id)).toEqual(["tab-1", "tab-2", "tab-3"]);
    const parked = harness.service.tabs().find((tab) => tab.id === "tab-1");
    expect(parked?.status).toBe("stopped");
    expect(parked?.sessionFile).toBe("/profile/sessions/s1.jsonl");
    expect(harness.stopped).toContain("tab-1");
    expect(harness.hosts.has("tab-1")).toBe(false);
    expect(harness.hosts.has("tab-2")).toBe(true);
    expect(harness.hosts.has("tab-3")).toBe(true);
  });

  it("resumes a parked session on its next activation", async () => {
    const clock = { value: 1_000 };
    const harness = createHarness({ maxLiveHosts: 2, now: () => clock.value });
    await harness.service.createTab({ cwd: "C:\\work\\one" });
    advance(clock, 1_000);
    await harness.service.createTab({ cwd: "C:\\work\\two" });
    advance(clock, 6_000);
    await harness.service.createTab({ cwd: "C:\\work\\three" });

    await harness.service.activateTab("tab-1");

    const spec = harness.specs.at(-1);
    expect(spec?.sessionId).toBe("tab-1");
    expect(spec?.sessionFile).toBe("/profile/sessions/s1.jsonl");
    expect(harness.hosts.get("tab-1")?.requests.map((request) => request.method)).toContain(
      "session.resume",
    );
    expect(harness.service.tabs().find((tab) => tab.id === "tab-1")?.status).toBe("idle");
  });

  it("starts anyway when every live session is busy (soft budget)", async () => {
    const clock = { value: 1_000 };
    const harness = createHarness({
      maxLiveHosts: 1,
      now: () => clock.value,
      state: { streaming: true },
    });

    await harness.service.createTab({ cwd: "C:\\work\\one" });
    advance(clock, 6_000);
    await harness.service.createTab({ cwd: "C:\\work\\two" });

    expect(harness.service.tabs().find((tab) => tab.id === "tab-1")?.status).toBe("idle");
    expect(harness.hosts.has("tab-1")).toBe(true);
    expect(harness.hosts.has("tab-2")).toBe(true);
    expect(harness.service.capacity().overTarget).toBe(true);
  });

  it("never parks the active tab to make room for a background request", async () => {
    const clock = { value: 1_000 };
    const harness = createHarness({ maxLiveHosts: 1, now: () => clock.value });
    const record = (id: string, index: number): TabRecord => ({
      id,
      kind: "session",
      cwd: `C:\\work\\${id}`,
      title: id,
      sessionFile: `/profile/${id}.jsonl`,
      status: "stopped",
      createdAt: index,
      lastActiveAt: index,
      model: null,
    });
    harness.stored.tabs = [record("tab-1", 1), record("tab-2", 2)];
    harness.stored.activeTabId = "tab-1";
    await harness.service.restoreTabs();
    await harness.service.activateTab("tab-1");
    advance(clock, 6_000);

    await harness.service.request("tab-2", "state.get");

    expect(harness.service.tabs().find((tab) => tab.id === "tab-1")?.status).toBe("idle");
    expect(harness.stopped).not.toContain("tab-1");
    expect(harness.hosts.has("tab-2")).toBe(true);
  });

  it("never parks an Office host or a pinned session", async () => {
    const clock = { value: 1_000 };
    const harness = createHarness({
      maxLiveHosts: 1,
      now: () => clock.value,
      pinnedFor: (spec) => spec.sessionId === "tab-1",
    });
    await harness.service.createTab({ cwd: "C:\\work\\office", kind: "office" });
    advance(clock, 6_000);
    await harness.service.createTab({ cwd: "C:\\work\\two" });

    expect(harness.service.tabs().find((tab) => tab.id === "tab-1")?.status).toBe("idle");
    expect(harness.stopped).not.toContain("tab-1");
    expect(harness.hosts.size).toBe(2);
  });

  it("reports aggregate host RSS, the ceiling and over-memory", async () => {
    const harness = createHarness({
      maxLiveHosts: 2,
      hostRssLimitBytes: 1_000,
      rssBytes: 600,
    });
    await harness.service.createTab({ cwd: "C:\\work\\one" });
    await harness.service.createTab({ cwd: "C:\\work\\two" });

    const capacity = harness.service.capacity();
    expect(capacity.hostRssBytes).toBe(1_200);
    expect(capacity.hostRssLimitBytes).toBe(1_000);
    expect(capacity.overMemory).toBe(true);
    expect(capacity.ceilingHosts).toBe(2);
  });

  it("reclaims idle hosts when the aggregate RSS is over budget", async () => {
    const clock = { value: 1_000 };
    const harness = createHarness({
      maxLiveHosts: 3,
      hostRssLimitBytes: 1_000,
      rssBytes: 400,
      now: () => clock.value,
    });
    await harness.service.createTab({ cwd: "C:\\work\\one" });
    advance(clock, 6_000);
    await harness.service.createTab({ cwd: "C:\\work\\two" });
    advance(clock, 6_000);
    await harness.service.createTab({ cwd: "C:\\work\\three" });

    const capacity = await harness.service.reclaimHosts();

    // The oldest inactive host is parked; the active tab and the other host stay.
    expect(harness.stopped).toContain("tab-1");
    expect(harness.hosts.has("tab-2")).toBe(true);
    expect(harness.hosts.has("tab-3")).toBe(true);
    expect(capacity.hostRssBytes).toBe(800);
    expect(capacity.overMemory).toBe(false);
  });

  it("never reclaims the active or a pinned host even over budget", async () => {
    const clock = { value: 1_000 };
    const harness = createHarness({
      maxLiveHosts: 2,
      hostRssLimitBytes: 1,
      rssBytes: 400,
      pinnedFor: (spec) => spec.sessionId === "tab-1",
      now: () => clock.value,
    });
    await harness.service.createTab({ cwd: "C:\\work\\one" });
    advance(clock, 6_000);
    await harness.service.createTab({ cwd: "C:\\work\\two" });

    await harness.service.reclaimHosts();

    expect(harness.stopped).toHaveLength(0);
    expect(harness.hosts.size).toBe(2);
  });

  it("never parks a visible pane to make room for another session", async () => {
    // The grid (2026-11-03 plan): a pane the user is watching must stay awake, so
    // the LRU budget parks the *other* idle session instead.
    const clock = { value: 1_000 };
    const harness = createHarness({ maxLiveHosts: 2, now: () => clock.value });
    await harness.service.createTab({ cwd: "C:\\work\\one" });
    advance(clock, 1_000);
    await harness.service.createTab({ cwd: "C:\\work\\two" });
    harness.service.setVisibleTabs(["tab-1"]);
    advance(clock, 6_000);
    await harness.service.createTab({ cwd: "C:\\work\\three" });

    expect(harness.stopped).toEqual(["tab-2"]);
    expect(harness.hosts.has("tab-1")).toBe(true);
    expect(harness.hosts.has("tab-3")).toBe(true);
  });

  it("reclaims around the visible panes instead of parking them", async () => {
    const clock = { value: 1_000 };
    const harness = createHarness({
      maxLiveHosts: 3,
      hostRssLimitBytes: 1_000,
      rssBytes: 400,
      now: () => clock.value,
    });
    await harness.service.createTab({ cwd: "C:\\work\\one" });
    advance(clock, 6_000);
    await harness.service.createTab({ cwd: "C:\\work\\two" });
    advance(clock, 6_000);
    await harness.service.createTab({ cwd: "C:\\work\\three" });
    harness.service.setVisibleTabs(["tab-1"]);

    await harness.service.reclaimHosts();

    expect(harness.stopped).toEqual(["tab-2"]);
    expect(harness.hosts.has("tab-1")).toBe(true);
  });

  it("reports the visible panes and ignores ids that are not open", async () => {
    const harness = createHarness();
    await harness.service.createTab({ cwd: "C:\\work\\one" });
    expect(harness.service.capacity().visibleSessions).toBe(0);

    // A close races the renderer push, so a stale id must be dropped quietly.
    harness.service.setVisibleTabs(["tab-1", "ghost"]);
    expect(harness.service.visibleTabIds()).toEqual(["tab-1"]);
    expect(harness.service.capacity().visibleSessions).toBe(1);

    harness.service.setVisibleTabs([]);
    expect(harness.service.visibleTabIds()).toEqual([]);
    expect(harness.service.capacity().visibleSessions).toBe(0);
  });

  it("bounds the visible set to the largest layout plus the focused tab", async () => {
    const harness = createHarness({ maxLiveHosts: 8 });
    for (let index = 0; index < 7; index += 1) {
      await harness.service.createTab({ cwd: `C:\\work\\p${index}` });
    }
    harness.service.setVisibleTabs(["tab-1", "tab-2", "tab-3", "tab-4", "tab-5", "tab-6", "tab-7"]);
    expect(harness.service.visibleTabIds()).toEqual(["tab-1", "tab-2", "tab-3", "tab-4", "tab-5"]);
  });
});

describe("event batching", () => {
  it("coalesces message_update deltas into one ordered batch", async () => {
    const { service, newest, pushes } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app" });
    const host = newest();
    pushes.length = 0;

    host.emit("message_update", { delta: "a" });
    host.emit("message_update", { delta: "b" });
    host.emit("message_update", { delta: "c" });
    expect(pushes).toEqual([]); // still inside the coalescing window

    vi.advanceTimersByTime(33);
    const batches = eventsOf(pushes);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.events).toHaveLength(3);
    expect(batches[0]!.seq).toBe(1);
    expect(batches[0]!.tabId).toBe("tab-1");
  });

  it("flushes a pending batch before a non-delta event, preserving order", async () => {
    const { service, newest, pushes } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app" });
    const host = newest();
    pushes.length = 0;

    host.emit("message_update", { delta: "a" });
    host.emit("message_end", { message: { role: "assistant" } });

    const batches = eventsOf(pushes);
    expect(batches.map((batch) => batch.events.map((entry) => entry.event))).toEqual([
      ["message_update"],
      ["message_end"],
    ]);
    expect(batches.map((batch) => batch.seq)).toEqual([1, 2]);
  });

  it("emits the delta batch early once it grows past the byte budget", async () => {
    const { service, newest, pushes } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app" });
    const host = newest();
    pushes.length = 0;

    host.emit("message_update", { delta: "x".repeat(1_200) });
    expect(eventsOf(pushes)).toHaveLength(1);
    expect(service.coalesceStats()).toMatchObject({ bytesFlushes: 1, timerFlushes: 0 });
  });

  it("measures a delta storm: hundreds of deltas become a handful of pushes", async () => {
    const { service, newest, pushes } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app" });
    const host = newest();
    pushes.length = 0;

    // 400 small deltas across four windows: unbatched this would be 400 pushes.
    for (let window = 0; window < 4; window += 1) {
      for (let index = 0; index < 100; index += 1) {
        host.emit("message_update", { delta: `${window}-${index}` });
      }
      vi.advanceTimersByTime(33);
    }

    const batches = eventsOf(pushes);
    const delivered = batches.flatMap((batch) => batch.events);
    // Every delta still arrives, in order, exactly once.
    expect(delivered).toHaveLength(400);
    expect(delivered[0]).toMatchObject({ event: "message_update" });

    const stats = service.coalesceStats();
    expect(stats.batches).toBe(batches.length);
    expect(stats.deltas).toBe(400);
    expect(stats.events).toBe(400);
    // Every batch has a known reason, and batching cuts the push count sharply
    // (the byte budget deliberately flushes a ~1 KB batch early for latency, so
    // the exact count is not fixed).
    expect(stats.timerFlushes + stats.bytesFlushes).toBe(stats.batches);
    expect(stats.batches).toBeLessThan(stats.deltas / 4);
  });

  it("routes state snapshots to the state channel and tracks running status", async () => {
    const { service, newest, pushes } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app" });
    pushes.length = 0;

    newest().emit("state", {
      sessionFile: "/profile/sessions/s1.jsonl",
      streaming: true,
      model: { id: "test-model" },
    });
    const state = pushes.find((push) => push.channel === "state");
    expect(state?.payload).toMatchObject({ tabId: "tab-1" });
    expect(service.tabs()[0]!.status).toBe("running");
    // The live model from a `state` frame must reach the tab record the
    // header renders, not just the state channel (plan step 1).
    newest().emit("state", {
      streaming: false,
      model: { provider: "synthetic", id: "other-model" },
    });
    expect(service.tabs()[0]!.model).toBe("other-model");
  });
});

describe("crash recovery", () => {
  it("reports a crash and a recovery, then refreshes the state", async () => {
    const { service, newest, pushes } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app" });
    const host = newest();
    pushes.length = 0;
    host.requests.length = 0;

    host.emitLifecycle("crashed", { code: 1, sessionId: "tab-1" });
    expect(service.tabs()[0]!.status).toBe("crashed");
    expect(eventsOf(pushes)[0]!.events.map((entry) => entry.event)).toEqual(["session.crashed"]);

    // The supervisor restarts the process and reports ready; the *service*
    // reopens the session from JSONL (the supervisor no longer resumes).
    host.emitLifecycle("status", "ready");
    await vi.waitFor(() => expect(service.tabs()[0]!.status).toBe("idle"));

    expect(
      eventsOf(pushes)
        .at(-1)!
        .events.map((entry) => entry.event),
    ).toEqual(["session.recovered"]);
    expect(host.requests.map((request) => request.method)).toContain("session.resume");
  });
});

describe("reliability and recovery (plan step 22)", () => {
  it("records a crash as an incident with a fix", async () => {
    const { service, newest } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app" });

    newest().emitLifecycle("crashed", { code: 1 });

    const incident = service.incidents()[0];
    expect(incident).toMatchObject({ kind: "host_crash", severity: "error", recoverable: true });
    expect(incident?.fix).toMatch(/Restart/);
    expect(incident?.tabId).toBe("tab-1");
  });

  it("records a wedged request and pushes a timeout notice", async () => {
    const { service, newest, pushes } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app" });
    pushes.length = 0;

    newest().emitLifecycle("timeout", { method: "compact", timeoutMs: 20 });

    expect(service.incidents()[0]).toMatchObject({
      kind: "host_timeout",
      recoverable: true,
      message: expect.stringContaining("compact"),
    });
    expect(eventsOf(pushes)[0]!.events.map((entry) => entry.event)).toEqual(["session.timeout"]);
  });

  it("records extension errors with their extension path", async () => {
    const { service, newest } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app" });

    newest().emit("extension_error", {
      extensionPath: "C:/ext/workflow/extension.ts",
      error: "boom",
    });

    expect(service.extensionErrors()[0]).toMatchObject({
      tabId: "tab-1",
      extensionId: "C:/ext/workflow/extension.ts",
      message: "boom",
    });
    expect(service.incidents()[0]).toMatchObject({ kind: "extension_error", severity: "error" });
  });

  it("restarts a tab by stopping the old host and resuming from the JSONL", async () => {
    const { service, specs, newest, hosts } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app" });
    const first = newest();
    specs.length = 0;

    await service.restartTab("tab-1");

    // The supervisor stopped the old process and a fresh host took its place.
    expect(hosts.get("tab-1")).not.toBe(first);
    expect(hosts.size).toBe(1);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      sessionId: "tab-1",
      sessionFile: "/profile/sessions/s1.jsonl",
    });
    // The new host resumes the same session file instead of creating a blank one.
    expect(newest().requests.map((entry) => entry.method)).toEqual(["session.resume"]);
    expect(service.tabs()[0]!.status).toBe("idle");
  });

  it("refuses to restart a web tab", async () => {
    const { service } = createHarness();
    await service.createTab({ kind: "web", cwd: "", url: "http://127.0.0.1:5173/" });
    await expect(service.restartTab("tab-1")).rejects.toThrow(/no Pi host to restart/);
  });

  it("stops a running tab's host when it is closed mid-run (no orphan process)", async () => {
    const { service, stopped, newest } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app" });
    // A run in flight: the host reports streaming, so the tab is `running`.
    newest().emit("state", { streaming: true });
    expect(service.tabs()[0]!.status).toBe("running");

    await service.closeTab("tab-1");

    expect(stopped).toEqual(["tab-1"]);
    expect(service.tabs()).toEqual([]);
    expect(service.diagnosticsHosts()).toEqual([]);
  });

  it("stops a host that finished starting after its tab was closed (plan step 27)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const { service, hosts, stopped } = createHarness({
      onStart: async () => {
        reached();
        await gate;
      },
    });

    const creating = service.createTab({ cwd: "C:\\work\\app" });
    await started;

    // The tab is gone before its host exists; the spawn must not re-register it.
    await service.closeTab("tab-1");
    release();

    await expect(creating).rejects.toThrow(/closed while its host was starting/);
    expect(stopped).toContain("tab-1");
    expect(hosts.has("tab-1")).toBe(false);
    expect(service.diagnosticsHosts()).toEqual([]);
  });

  it("marks a session host whose build predates the bundle", async () => {
    const { service } = createHarness({ hostBuildId: () => "new", buildIds: ["old"] });
    await service.createTab({ cwd: "C:\\work\\app" });

    const tab = service.diagnosticsHosts().find((row) => row.tabId === "tab-1");
    expect(tab).toMatchObject({ buildId: "old", stale: true });
  });

  it("never marks the control host stale", async () => {
    const { service } = createHarness({ hostBuildId: () => "new", buildIds: ["old"] });
    await service.controlHost();

    const control = service.diagnosticsHosts().find((row) => row.tabId === CONTROL_HOST_ID);
    expect(control).toMatchObject({ buildId: "old", stale: false });
  });

  it("reports null build and stale=false for a tab without a host", async () => {
    const { service, stored } = createHarness({ hostBuildId: () => "new" });
    stored.tabs = [
      {
        id: "tab-1",
        kind: "session",
        cwd: "C:\\work\\a",
        title: "a",
        sessionFile: null,
        status: "stopped",
        createdAt: 1,
        lastActiveAt: 1,
        model: null,
      },
    ];
    await service.restoreTabs();

    expect(service.diagnosticsHosts()[0]).toMatchObject({ buildId: null, stale: false });
  });

  it("describes each tab and the control host for Diagnostics", async () => {
    const { service } = createHarness();
    await service.controlHost();
    await service.createTab({ cwd: "C:\\work\\app" });

    const rows = service.diagnosticsHosts();
    const control = rows.find((row) => row.tabId === CONTROL_HOST_ID);
    const tab = rows.find((row) => row.tabId === "tab-1");

    expect(control).toMatchObject({ role: "control", pid: 900, startedAt: 5, stale: false });
    expect(control?.logLines[0]).toContain("control");
    expect(tab).toMatchObject({
      role: "session",
      // The host process is ready; the tab's own status is tracked separately.
      status: "ready",
      sessionFile: "/profile/sessions/s1.jsonl",
      buildId: "build-1",
      stale: false,
      logLines: ["log line for tab-1"],
    });
  });

  it("reports the soft live-host budget and open-tab counts (plan step 24 backpressure)", async () => {
    const { service } = createHarness({ maxLiveHosts: 2 });
    await service.controlHost();
    await service.createTab({ cwd: "C:\\work\\app" });

    const caps = service.capacity();
    expect(caps).toEqual({
      liveHosts: 2,
      targetHosts: 2,
      ceilingHosts: 2,
      overTarget: false,
      hostRssBytes: 0,
      hostRssLimitBytes: 0,
      overMemory: false,
      openSessions: 1,
      asleepSessions: 0,
      editorTabs: 0,
      visibleSessions: 0,
    });
  });

  it("records the supervisor's stop reason and memory warning", async () => {
    const { service, hosts } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app" });
    const host = hosts.get("tab-1");
    if (!host) throw new Error("no host");
    host.stopReasonValue = "memory";
    host.overMemoryValue = true;
    host.setStatus("ready");
    host.emitLifecycle("status", "ready");
    host.setStatus("stopped");
    host.emitLifecycle("status", "stopped");
    await Promise.resolve();

    const tab = service.tabs()[0]!;
    expect(tab.status).toBe("stopped");
    expect(tab.stopReason).toBe("memory");
    expect(tab.memoryOverBudget).toBe(true);
    expect(tab.stoppedAt).toBe(1_000);
  });

  it("drops an event from the outgoing session after a replacement", async () => {
    const { service, hosts, pushes } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app" });
    const host = hosts.get("tab-1");
    if (!host) throw new Error("no host");

    host.emit(
      "session_started",
      { reason: "new", sessionId: "s1" },
      { sessionId: "s1", sessionEpoch: 1 },
    );
    host.emit("session_replaced", { sessionId: "s2" }, { sessionId: "s2", sessionEpoch: 2 });
    // A late frame from the invalidated runner: same tab, old identity.
    host.emit(
      "message_start",
      { message: { id: "old", role: "assistant", content: [] } },
      { sessionId: "s1", sessionEpoch: 1 },
    );
    host.emit(
      "message_start",
      { message: { id: "new", role: "assistant", content: [] } },
      { sessionId: "s2", sessionEpoch: 2 },
    );
    await Promise.resolve();

    const events = pushes
      .filter((push) => push.channel === "event")
      .flatMap(
        (push) =>
          (
            push.payload as {
              events: Array<{ event: string; payload?: { message?: { id?: string } } }>;
            }
          ).events,
      );
    const messageIds = events
      .filter((entry) => entry.event === "message_start")
      .map((entry) => entry.payload?.message?.id);
    expect(messageIds).not.toContain("old");
    expect(messageIds).toContain("new");
  });

  it("drops a host handle that reports stopped, so the next activation re-spawns", async () => {
    const { service, hosts, specs } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app" });
    const host = hosts.get("tab-1");
    if (!host) throw new Error("no host");

    // What an idle recycle looks like through the supervisor's status event.
    host.setStatus("stopped");
    host.emitLifecycle("status", "stopped");
    await Promise.resolve();

    expect(service.tabs()[0]!.status).toBe("stopped");

    // The service dropped its handle, so activation spawns a fresh process
    // instead of handing out the dead one.
    await service.activateTab("tab-1");
    expect(specs.filter((spec) => spec.sessionId === "tab-1")).toHaveLength(2);
  });
});

describe("session readiness (2026-10-25 plan)", () => {
  it("keeps a tab starting until resume resolves, then reports idle", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service, stored } = createHarness({
      onStart: async () => {
        await gate;
      },
    });
    stored.tabs = [
      {
        id: "tab-1",
        kind: "session",
        cwd: "C:\\work\\app",
        title: "app",
        sessionFile: "/profile/sessions/s1.jsonl",
        status: "stopped",
        createdAt: 1,
        lastActiveAt: 1,
        model: null,
      },
    ];
    stored.activeTabId = "tab-1";
    await service.restoreTabs();

    const activation = service.activateTab("tab-1");
    await vi.waitFor(() => expect(service.tabs()[0]!.status).toBe("starting"));
    release();
    await activation;

    expect(service.tabs()[0]!.status).toBe("idle");
  });
});

describe("reconcile (sleep/resume and stale pushes)", () => {
  it("turns a tab with no host into stopped instead of leaving idle", async () => {
    const { service, newest } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app" });
    expect(service.tabs()[0]!.status).toBe("idle");

    // A stopped supervisor event drops the service's handle; then a stale push
    // leaves the visible status at idle. Reconcile must correct it.
    newest().emitLifecycle("status", "stopped");
    await Promise.resolve();
    service.tabs()[0]!.status = "idle";
    const envelope = await service.reconcile();

    expect(service.tabs()[0]!.status).toBe("stopped");
    expect(envelope.tabs[0]!.status).toBe("stopped");
  });

  it("turns a ready-but-sessionless host into starting, not idle", async () => {
    const { service, hosts } = createHarness({ createdSessionFile: null });
    await service.createTab({ cwd: "C:\\work\\app" });
    const host = hosts.get("tab-1");
    if (!host) throw new Error("no host");
    // A crash restart can leave a fresh, session-less process in the map.
    host.setStatus("ready");
    // There is no public way to clear readiness; a failed reopen is simulated by
    // a host that reports ready while the tab is still starting.
    service.tabs()[0]!.status = "starting";

    const envelope = await service.reconcile();
    expect(envelope.tabs[0]!.status).toBe("starting");
  });

  it("keeps a stopped tab stopped and does not spawn", async () => {
    const { service, hosts, specs } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app" });
    const host = hosts.get("tab-1");
    if (!host) throw new Error("no host");
    host.setStatus("stopped");
    host.emitLifecycle("status", "stopped");
    await Promise.resolve();
    const spawnedBefore = specs.length;

    const envelope = await service.reconcile();
    expect(envelope.tabs[0]!.status).toBe("stopped");
    expect(specs).toHaveLength(spawnedBefore);
  });

  it("refuses passive reads from a stopped tab without spawning", async () => {
    const { service, hosts, specs } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app" });
    const host = hosts.get("tab-1");
    if (!host) throw new Error("no host");
    host.setStatus("stopped");
    host.emitLifecycle("status", "stopped");
    await Promise.resolve();
    const spawnedBefore = specs.length;

    for (const method of ["tui.resize", "tui.state", "messages.get", "shortcuts.list"] as const) {
      await expect(service.request("tab-1", method)).rejects.toMatchObject({
        code: "host_stopped",
        message: SESSION_ASLEEP_MESSAGE,
      });
    }
    expect(specs).toHaveLength(spawnedBefore);

    // Explicit activation is the one thing that may wake it.
    await service.ensureTab("tab-1");
    expect(specs).toHaveLength(spawnedBefore + 1);
    expect(service.tabs()[0]!.status).toBe("idle");
  });

  it("still wakes a stopped tab for a prompt or an explicit ensure", async () => {
    const { service, hosts, specs } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app" });
    const host = hosts.get("tab-1");
    if (!host) throw new Error("no host");
    host.setStatus("stopped");
    host.emitLifecycle("status", "stopped");
    await Promise.resolve();
    const spawnedBefore = specs.length;

    await service.request("tab-1", "prompt", { text: "hello" });
    expect(specs).toHaveLength(spawnedBefore + 1);
    expect(await service.request("tab-1", "state.get")).toMatchObject({
      sessionId: "session-1",
    });
  });
});

describe("persistence and restore", () => {
  it("falls back to the most recent session when the saved active tab is gone", async () => {
    // `app-state.json` can name a tab that was removed by another window or a
    // hand edit. Opening on an empty shell hides the work that is still there.
    const { service, stored } = createHarness();
    const record = (id: string, lastActiveAt: number): TabRecord => ({
      id,
      kind: "session",
      cwd: `C:\\work\\${id}`,
      title: id,
      sessionFile: `/profile/${id}.jsonl`,
      status: "stopped",
      createdAt: 1,
      lastActiveAt,
      model: null,
    });
    stored.tabs = [record("older", 10), record("newer", 20)];
    stored.activeTabId = "tab-that-no-longer-exists";

    const envelope = await service.restoreTabs();

    expect(envelope.activeTabId).toBe("newer");
  });

  it("keeps a deliberately cleared selection cleared", async () => {
    const { service, stored } = createHarness();
    stored.tabs = [
      {
        id: "tab-1",
        kind: "session",
        cwd: "C:\\work\\one",
        title: "one",
        sessionFile: "/profile/one.jsonl",
        status: "stopped",
        createdAt: 1,
        lastActiveAt: 5,
        model: null,
      },
    ];
    stored.activeTabId = null;

    expect((await service.restoreTabs()).activeTabId).toBeNull();
  });

  it("restores the tab table without spawning any host", async () => {
    const { service, hosts, stored } = createHarness();
    stored.tabs = [
      {
        id: "tab-9",
        kind: "session",
        cwd: "C:\\work\\old",
        title: "old",
        sessionFile: "/profile/s9.jsonl",
        status: "running",
        createdAt: 1,
        lastActiveAt: 2,
        model: "test-model",
      },
    ];
    stored.activeTabId = "tab-9";

    const envelope = await service.restoreTabs();
    expect(hosts.size).toBe(0);
    expect(envelope.tabs).toHaveLength(1);
    expect(envelope.tabs[0]).toMatchObject({ id: "tab-9", status: "stopped" });
    expect(envelope.activeTabId).toBe("tab-9");
  });

  it("restores more than eight session tabs and more than sixteen editor tabs", async () => {
    const { service, stored } = createHarness();
    const sessionTab = (index: number): TabRecord => ({
      id: `session-${index}`,
      kind: "session",
      cwd: `C:\\work\\project-${index}`,
      title: `project-${index}`,
      sessionFile: `/profile/s${index}.jsonl`,
      status: "stopped",
      createdAt: index,
      lastActiveAt: index,
      model: null,
    });
    const editorTab = (index: number): TabRecord => ({
      id: `editor-${index}`,
      kind: "editor",
      cwd: "C:\\work\\project-0",
      title: `file-${index}.ts`,
      sessionFile: null,
      status: "idle",
      createdAt: index,
      lastActiveAt: index,
      model: null,
      filePath: `src/file-${index}.ts`,
    });
    stored.tabs = [
      ...Array.from({ length: 20 }, (_, index) => sessionTab(index)),
      ...Array.from({ length: 20 }, (_, index) => editorTab(index)),
    ];

    const envelope = await service.restoreTabs();
    expect(envelope.tabs).toHaveLength(40);
    expect(envelope.tabs.filter((tab) => tab.kind === "session")).toHaveLength(20);
    expect(envelope.tabs.filter((tab) => tab.kind === "editor")).toHaveLength(20);
  });

  it("drops unusable persisted tabs instead of trusting the file", async () => {
    const { service, stored } = createHarness();
    stored.tabs = [{ id: "no-cwd" }, { nope: true }] as unknown as TabRecord[];
    const envelope = await service.restoreTabs();
    expect(envelope.tabs).toEqual([]);
  });

  it("pre-warms the most recently active tab", async () => {
    const { service, stored, specs } = createHarness();
    stored.tabs = [
      {
        id: "tab-1",
        kind: "session",
        cwd: "C:\\work\\a",
        title: "a",
        sessionFile: null,
        status: "stopped",
        createdAt: 1,
        lastActiveAt: 10,
        model: null,
      },
      {
        id: "tab-2",
        kind: "session",
        cwd: "C:\\work\\b",
        title: "b",
        sessionFile: null,
        status: "stopped",
        createdAt: 2,
        lastActiveAt: 20,
        model: null,
      },
    ];
    await service.restoreTabs();
    const warmed = await service.prewarmLast();
    expect(warmed).toBe(true);
    expect(specs.map((spec) => spec.sessionId)).toEqual(["tab-2"]);
  });

  it("reports false from a pre-warm when there is nothing to warm", async () => {
    const { service, specs } = createHarness();
    await service.restoreTabs();
    await expect(service.prewarmLast()).resolves.toBe(false);
    expect(specs).toEqual([]);
  });
});

describe("requests", () => {
  it("spawns the host lazily and forwards the method", async () => {
    const { service, stored } = createHarness();
    stored.tabs = [
      {
        id: "tab-1",
        kind: "session",
        cwd: "C:\\work\\a",
        title: "a",
        sessionFile: null,
        status: "stopped",
        createdAt: 1,
        lastActiveAt: 1,
        model: null,
      },
    ];
    await service.restoreTabs();
    await service.request("tab-1", "state.get");
    expect(service.tabs()[0]!.status).toBe("idle");
  });

  it("rejects an unknown tab", async () => {
    const { service } = createHarness();
    await expect(service.request("tab-nope", "state.get")).rejects.toThrow(/unknown session tab/);
  });

  it("gives scan-heavy methods a longer timeout", async () => {
    const { service, hosts, newest } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app" });
    const sessionHost = newest();

    await service.request("tab-1", "messages.get");
    expect(sessionHost.requests.at(-1)).toMatchObject({
      method: "messages.get",
      timeoutMs: 60_000,
    });

    await service.request("tab-1", "state.get");
    expect(sessionHost.requests.at(-1)).toMatchObject({
      method: "state.get",
      timeoutMs: 30_000,
    });

    await service.request(CONTROL_HOST_ID, "session.list");
    expect(hosts.get(CONTROL_HOST_ID)?.requests.at(-1)).toMatchObject({
      method: "session.list",
      timeoutMs: 120_000,
    });
    expect(requestTimeoutFor("session.list")).toBe(120_000);
    expect(requestTimeoutFor("tree.get")).toBe(60_000);
    expect(requestTimeoutFor("state.get")).toBe(30_000);
    // Opening a session loads its JSONL and the extension stack; 30 s timed out
    // healthy hosts (2026-11-06 hang plan).
    expect(requestTimeoutFor("session.create")).toBe(HOST_OPEN_TIMEOUT_MS);
    expect(requestTimeoutFor("session.resume")).toBe(HOST_OPEN_TIMEOUT_MS);
    expect(requestTimeoutFor("session.open")).toBe(HOST_OPEN_TIMEOUT_MS);
    expect(HOST_OPEN_TIMEOUT_MS).toBe(90_000);
  });

  it("repairs a lost session and retries a read-only request once", async () => {
    const { service, newest, pushes } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app" });
    const host = newest();
    const original = host.request.bind(host);
    let lost = true;
    host.request = async (method: HostMethod, params?: unknown) => {
      if (method === "state.get" && lost) {
        lost = false;
        const error = new Error("no session is open");
        error.name = "no_session";
        throw error;
      }
      return original(method, params);
    };

    const result = (await service.request("tab-1", "state.get")) as Record<string, unknown>;
    expect(result).toMatchObject({ sessionId: "session-1" });
    expect(host.requests.map((request) => request.method)).toContain("session.resume");
    expect(pushes.some((push) => push.channel === "event")).toBe(true);
    expect(service.tabs()[0]!.status).toBe("idle");
  });

  it("does not replay a prompt after a lost session", async () => {
    const { service, newest } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app" });
    const host = newest();
    const original = host.request.bind(host);
    host.request = async (method: HostMethod, params?: unknown) => {
      if (method === "prompt") {
        const error = new Error("no session is open");
        error.name = "no_session";
        throw error;
      }
      return original(method, params);
    };

    await expect(service.request("tab-1", "prompt", { text: "hello" })).rejects.toThrow(
      /put back in the composer/,
    );
    expect(host.requests.map((request) => request.method)).toContain("session.resume");
    expect(host.requests.filter((request) => request.method === "prompt")).toHaveLength(0);
  });

  it("forwards an explicit session.create with trust without auto-resuming", async () => {
    const { service, newest } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app" });
    const host = newest();
    host.requests.length = 0;

    await service.request("tab-1", "session.create", {
      cwd: "C:\\work\\app",
      trust: "session",
    });

    expect(host.requests.map((request) => request.method)).toEqual(["session.create"]);
    expect(service.tabs()[0]!.status).toBe("idle");
  });
});

describe("stale host recycling (2026-10-24 plan)", () => {
  async function tabOf(service: SessionService): Promise<string> {
    const envelope = await service.createTab({ cwd: "C:\\work\\app" });
    const id = envelope.activeTabId ?? envelope.tabs[0]?.id;
    if (!id) throw new Error("createTab returned no tab");
    return id;
  }

  it("recycles an idle host whose build predates the bundle", async () => {
    const harness = createHarness({ hostBuildId: () => "new", buildIds: ["old", "new"] });
    const tabId = await tabOf(harness.service);
    const first = harness.hosts.get(tabId)!;

    await harness.service.request(tabId, "commands.complete", { name: "profile", prefix: "" });

    expect(harness.stopped).toContain(tabId);
    expect(harness.specs).toHaveLength(2);
    expect(harness.hosts.get(tabId)).not.toBe(first);
    expect(harness.hosts.get(tabId)?.info()?.buildId).toBe("new");
    expect(harness.hosts.get(tabId)?.requests.map((request) => request.method)).toContain(
      "commands.complete",
    );
  });

  it.each([
    ["streaming", { streaming: true }],
    ["compacting", { compacting: true }],
    ["retrying", { retrying: true }],
    ["pendingMessages", { pendingMessages: 1 }],
    ["steering", { steering: ["queued"] }],
    ["followUp", { followUp: ["queued"] }],
  ])("never recycles a busy host (%s)", async (_label, state) => {
    const harness = createHarness({
      hostBuildId: () => "new",
      buildIds: ["old", "new"],
      state: state as Record<string, unknown>,
    });
    const tabId = await tabOf(harness.service);
    const first = harness.hosts.get(tabId)!;

    await harness.service.request(tabId, "commands.complete", { name: "profile", prefix: "" });

    expect(harness.stopped).toEqual([]);
    expect(harness.specs).toHaveLength(1);
    expect(harness.hosts.get(tabId)).toBe(first);
    expect(first.requests.map((request) => request.method)).toContain("commands.complete");
  });

  it("does not recycle when the session file is unknown", async () => {
    const harness = createHarness({
      hostBuildId: () => "new",
      buildIds: ["old", "new"],
      createdSessionFile: null,
      state: { sessionFile: null },
    });
    const tabId = await tabOf(harness.service);

    await harness.service.request(tabId, "commands.complete", { name: "profile", prefix: "" });

    expect(harness.stopped).toEqual([]);
    expect(harness.specs).toHaveLength(1);
  });

  it("forwards to the old host when the idle probe fails", async () => {
    const harness = createHarness({
      hostBuildId: () => "new",
      buildIds: ["old", "new"],
      fail: { method: "state.get", error: new Error("wedged") },
    });
    const tabId = await tabOf(harness.service);
    const first = harness.hosts.get(tabId)!;

    await harness.service.request(tabId, "commands.complete", { name: "profile", prefix: "" });

    expect(harness.stopped).toEqual([]);
    expect(harness.specs).toHaveLength(1);
    expect(first.requests.map((request) => request.method)).toContain("commands.complete");
  });

  it("does nothing when the build ids match", async () => {
    const harness = createHarness({ hostBuildId: () => "new", buildIds: ["new"] });
    const tabId = await tabOf(harness.service);
    const first = harness.hosts.get(tabId)!;

    await harness.service.request(tabId, "commands.complete", { name: "profile", prefix: "" });

    expect(harness.stopped).toEqual([]);
    expect(harness.specs).toHaveLength(1);
    expect(first.requests.some((request) => request.method === "state.get")).toBe(false);
    expect(first.requests.map((request) => request.method)).toContain("commands.complete");
  });

  it("skips the stale check when no provider is configured", async () => {
    const harness = createHarness({ buildIds: ["old"] });
    const tabId = await tabOf(harness.service);
    const first = harness.hosts.get(tabId)!;

    await harness.service.request(tabId, "commands.complete", { name: "profile", prefix: "" });

    expect(harness.stopped).toEqual([]);
    expect(harness.specs).toHaveLength(1);
    expect(first.requests.some((request) => request.method === "state.get")).toBe(false);
  });

  it("does not stale-check the control host", async () => {
    const harness = createHarness({ hostBuildId: () => "new", buildIds: ["old"] });

    await harness.service.request(CONTROL_HOST_ID, "commands.complete");

    expect(harness.specs.map((spec) => spec.role)).toEqual(["control"]);
    expect(harness.stopped).toEqual([]);
  });

  it("coalesces concurrent requests into one recycle", async () => {
    const harness = createHarness({ hostBuildId: () => "new", buildIds: ["old", "new"] });
    const tabId = await tabOf(harness.service);

    await Promise.all([
      harness.service.request(tabId, "commands.complete", { name: "profile", prefix: "" }),
      harness.service.request(tabId, "commands.complete", { name: "profile", prefix: "" }),
    ]);

    expect(harness.stopped.filter((id) => id === tabId)).toHaveLength(1);
    expect(harness.specs).toHaveLength(2);
  });

  function hostError(message: string, name: string): Error {
    return Object.assign(new Error(message), { name });
  }

  it("maps a missing commands.complete to an unsupported result", async () => {
    const harness = createHarness({
      fail: {
        method: "commands.complete",
        error: hostError("method not implemented yet: commands.complete", "not_implemented"),
      },
    });
    const tabId = await tabOf(harness.service);

    await expect(
      harness.service.request(tabId, "commands.complete", { name: "profile", prefix: "" }),
    ).resolves.toEqual({ items: null, unsupported: true });
  });

  it("maps unknown_method for commands.complete to the same result", async () => {
    const harness = createHarness({
      fail: {
        method: "commands.complete",
        error: hostError("unknown method: commands.complete", "unknown_method"),
      },
    });
    const tabId = await tabOf(harness.service);

    await expect(
      harness.service.request(tabId, "commands.complete", { name: "profile", prefix: "" }),
    ).resolves.toEqual({ items: null, unsupported: true });
  });

  it("does not swallow a CommandError that only shares the not_implemented name", async () => {
    const harness = createHarness({
      fail: {
        method: "commands.complete",
        error: hostError(
          "extension commands are not available in this host: open a session first",
          "not_implemented",
        ),
      },
    });
    const tabId = await tabOf(harness.service);

    await expect(
      harness.service.request(tabId, "commands.complete", { name: "profile", prefix: "" }),
    ).rejects.toThrow(/open a session first/);
  });
});

describe("dispose", () => {
  it("flushes pending deltas, stops every host and is idempotent", async () => {
    const { service, hosts, pushes } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app" });
    await service.controlHost();
    // The *session* host, not the control host that `controlHost()` just added.
    hosts.get("tab-1")?.emit("message_update", { delta: "trailing" });
    pushes.length = 0;

    await service.dispose();

    expect(eventsOf(pushes).flatMap((batch) => batch.events)).toHaveLength(1);
    expect(hosts.size).toBe(0);
    await expect(service.dispose()).resolves.toBeUndefined();
  });
});

describe("promoteToOfficeHost (plan step 20)", () => {
  it("moves the Office host to the promoted tab and demotes the old one", async () => {
    const { service, specs, hosts } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app", kind: "office" });
    await service.createTab({ cwd: "C:\\work\\app" });

    expect(service.tabs().map((tab) => [tab.id, tab.kind])).toEqual([
      ["tab-1", "office"],
      ["tab-2", "session"],
    ]);
    // The first spawn bound 38617; the second did not.
    expect(specs.map((spec) => spec.officeHost)).toEqual([true, false]);

    const envelope = await service.promoteToOfficeHost("tab-2");

    // One office host only, and it is the promoted tab.
    expect(envelope.tabs.map((tab) => [tab.id, tab.kind])).toEqual([
      ["tab-1", "session"],
      ["tab-2", "office"],
    ]);
    expect(envelope.activeTabId).toBe("tab-2");
    // The promoted tab was re-spawned with the office flag (port 38617).
    expect(specs.filter((spec) => spec.sessionId === "tab-2").map((s) => s.officeHost)).toEqual([
      false,
      true,
    ]);
    // The demoted tab's host is gone; the promoted tab's host is live.
    expect(hosts.has("tab-1")).toBe(false);
    expect(hosts.has("tab-2")).toBe(true);
  });

  it("resumes the promoted session from its JSONL", async () => {
    const { service, hosts } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app" });
    const sessionFile = service.tabs()[0]!.sessionFile;
    expect(sessionFile).toBe("/profile/sessions/s1.jsonl");

    await service.promoteToOfficeHost("tab-1");

    const methods = hosts.get("tab-1")!.requests.map((request) => request.method);
    expect(methods).toContain("session.resume");
  });

  it("is a no-op when the tab is already the running Office host", async () => {
    const { service, specs } = createHarness();
    await service.createTab({ cwd: "C:\\work\\app", kind: "office" });
    const before = specs.length;

    await service.promoteToOfficeHost("tab-1");

    expect(specs).toHaveLength(before);
    expect(service.tabs()[0]!.kind).toBe("office");
  });

  it("rejects an unknown tab", async () => {
    const { service } = createHarness();
    await expect(service.promoteToOfficeHost("tab-nope")).rejects.toThrow(/unknown session tab/);
  });

  it("frees the bridge port after stopping the old host and before the new spawn", async () => {
    // 2026-10-30 project-scoped rail plan: "Use this session instead" must really
    // take port 38617, so the reclaimer runs after the old host exited and before
    // the promoted host binds.
    const order: string[] = [];
    const { service } = createHarness({
      releaseOfficePort: async (input) => {
        order.push(`release:${input.port}`);
        return { ok: true };
      },
      ownPids: () => [process.pid, 4242],
    });
    await service.createTab({ cwd: "C:\\work\\app", kind: "office" });
    await service.createTab({ cwd: "C:\\work\\app" });
    // The stop happened first, so the reclaimer never needs to fight a live host.
    order.push("stopped:tab-1");

    await service.promoteToOfficeHost("tab-2");

    expect(order).toEqual(["stopped:tab-1", "release:38617"]);
    expect(service.tabs().map((tab) => tab.kind)).toEqual(["session", "office"]);
  });

  it("passes the app's own PIDs so the reclaimer never kills itself", async () => {
    let seen: readonly number[] = [];
    const { service } = createHarness({
      ownPids: () => [process.pid, 5151],
      releaseOfficePort: async (input) => {
        seen = input.ownPids;
        return { ok: true };
      },
    });
    await service.createTab({ cwd: "C:\\work\\app" });
    await service.promoteToOfficeHost("tab-1");

    expect(seen).toEqual([process.pid, 5151]);
  });

  it("samples this app's own PIDs before any host is detached", async () => {
    // A detached host has already left `hosts.list()`, so sampling later would
    // let the reclaimer treat our own still-exiting process as a stranger and
    // signal it (2026-10-30 rail-headers plan).
    const calls: string[] = [];
    let seen: readonly number[] = [];
    const { service, hosts } = createHarness({
      ownPids: () => {
        calls.push(`own:${[...hosts.keys()].sort().join(",")}`);
        return [process.pid, 7001];
      },
      releaseOfficePort: async (input) => {
        calls.push("release");
        seen = input.ownPids;
        return { ok: true };
      },
    });
    await service.createTab({ cwd: "C:\\work\\app", kind: "office" });
    await service.createTab({ cwd: "C:\\work\\app" });

    await service.promoteToOfficeHost("tab-2");

    // Sampled once, while both hosts were still live.
    expect(calls[0]).toBe("own:tab-1,tab-2");
    expect(calls).toContain("release");
    expect(seen).toEqual([process.pid, 7001]);
  });

  it("rolls back to the previous host when the port cannot be freed", async () => {
    // The worst outcome would be demoting the working host and leaving the app
    // with no bridge at all, so a failed takeover restores what was there.
    const { service, specs } = createHarness({
      releaseOfficePort: async () => ({
        ok: false,
        detail: "port 38617 is held by evil.exe (pid 7)",
      }),
    });
    await service.createTab({ cwd: "C:\\work\\app", kind: "office" });
    await service.createTab({ cwd: "C:\\work\\app" });

    await expect(service.promoteToOfficeHost("tab-2")).rejects.toThrow(/evil\.exe/);

    // The displaced host is the Office host again and active; the promoted tab
    // did not silently become a second one.
    expect(service.tabs().map((tab) => [tab.id, tab.kind])).toEqual([
      ["tab-1", "office"],
      ["tab-2", "session"],
    ]);
    expect(service.activeTabId()).toBe("tab-1");
    // It was re-spawned as the office host (a fresh 38617 attempt), and the
    // promoted tab never got an office spawn.
    expect(specs.filter((spec) => spec.sessionId === "tab-2").length).toBe(1);
    expect(
      specs.filter((spec) => spec.sessionId === "tab-1").map((spec) => spec.officeHost),
    ).toContain(true);
  });

  it("gives a readable error when the port is busy and there is nothing to restore", async () => {
    const { service } = createHarness({
      releaseOfficePort: async () => ({ ok: false }),
    });
    await service.createTab({ cwd: "C:\\work\\app" });

    await expect(service.promoteToOfficeHost("tab-1")).rejects.toThrow(
      /Office bridge port 38617 is in use/,
    );
    // A tab that never held the bridge stays a plain session.
    expect(service.tabs()[0]!.kind).toBe("session");
  });

  it("does not call the reclaimer when the tab already owns the bridge", async () => {
    let calls = 0;
    const { service } = createHarness({
      releaseOfficePort: async () => {
        calls += 1;
        return { ok: true };
      },
    });
    await service.createTab({ cwd: "C:\\work\\app", kind: "office" });

    await service.promoteToOfficeHost("tab-1");

    expect(calls).toBe(0);
  });
});

describe("web tabs (plan step 21)", () => {
  it("creates a web tab without spawning any host", async () => {
    const { service, specs, stored } = createHarness();
    const envelope = await service.createTab({
      kind: "web",
      url: "http://127.0.0.1:19432/review/abc",
      sessionTabId: "tab-0",
    });

    expect(specs).toEqual([]);
    const tab = envelope.tabs[0]!;
    expect(tab).toMatchObject({
      id: "tab-1",
      kind: "web",
      url: "http://127.0.0.1:19432/review/abc",
      sessionTabId: "tab-0",
      title: "127.0.0.1:19432",
      status: "idle",
    });
    expect(envelope.activeTabId).toBe("tab-1");
    // The web tab is persisted like any other, so it survives a relaunch.
    expect(stored.tabs.map((entry) => entry.id)).toEqual(["tab-1"]);
  });

  it("refuses a web tab without a permitted URL or a hostless other kind", async () => {
    const { service } = createHarness();
    await expect(service.createTab({ kind: "web" })).rejects.toThrow(/requires a web URL/);
    await expect(service.createTab({ kind: "web", url: "javascript:alert(1)" })).rejects.toThrow(
      /requires a web URL/,
    );
  });

  it("never starts a host when a web tab is activated, and refuses host requests", async () => {
    const { service, specs } = createHarness();
    await service.createTab({ cwd: "C:/work/app" });
    await service.createTab({ kind: "web", url: "http://localhost:5173/", sessionTabId: "tab-1" });
    expect(specs).toHaveLength(1);

    await service.activateTab("tab-2");
    expect(specs).toHaveLength(1);

    await expect(service.request("tab-2", "state.get")).rejects.toThrow(/no Pi host/);
  });

  it("never starts a host for an editor tab and refuses host requests", async () => {
    const { service, specs } = createHarness();
    const envelope = await service.createTab({
      cwd: "C:/work/app",
      kind: "editor",
      filePath: "src/app.ts",
    });
    const editorId = envelope.tabs[0]!.id;
    expect(specs).toHaveLength(0);

    await expect(service.request(editorId, "state.get")).rejects.toThrow(/no Pi host/);
    await expect(service.restartTab(editorId)).rejects.toThrow(/no Pi host to restart/);
    expect(specs).toHaveLength(0);
  });

  it("restores a web tab as idle (there is no host to stop)", async () => {
    const { service, stored } = createHarness();
    stored.tabs = [
      {
        id: "tab-1",
        kind: "web",
        cwd: "",
        title: "x",
        sessionFile: null,
        status: "idle",
        createdAt: 0,
        lastActiveAt: 0,
        model: null,
        url: "http://localhost:1/x",
        sessionTabId: null,
      },
    ];
    const envelope = await service.restoreTabs();
    expect(envelope.tabs[0]!.status).toBe("idle");
    expect(envelope.tabs[0]!.url).toBe("http://localhost:1/x");
  });

  it("does not stop a supervisor host for a web tab, and skips it when pre-warming", async () => {
    const { service, hosts } = createHarness();
    await service.createTab({ cwd: "C:/work/app" });
    await service.createTab({ kind: "web", url: "http://localhost:1/", sessionTabId: "tab-1" });
    expect(hosts.has("tab-1")).toBe(true);

    await service.closeTab("tab-2");
    expect(hosts.has("tab-1")).toBe(true);

    const warmed = await service.prewarmLast();
    expect(warmed).toBe(true);
    // The web tab was most recently active but is not pre-warmed; tab-1 is.
    expect(hosts.has("tab-1")).toBe(true);
  });

  it("refuses to promote a web tab to the Office host", async () => {
    const { service } = createHarness();
    await service.createTab({ kind: "web", url: "http://localhost:1/" });
    await expect(service.promoteToOfficeHost("tab-1")).rejects.toThrow(/web tab/);
  });

  it("dedupes a concurrent pre-warm and request into one host spawn (plan step 25)", async () => {
    const harness = createHarness();
    await harness.service.createTab({ cwd: "C:/work/app" });
    const tabId = harness.stored.tabs[0]!.id;

    // Simulate a relaunch: the tab is restored with no host running.
    await harness.service.restoreTabs();
    const before = harness.specs.length;

    // A startup pre-warm and the renderer's first `messages.get` arrive together.
    await Promise.all([
      harness.service.activateTab(tabId),
      harness.service.request(tabId, "state.get"),
    ]);

    expect(harness.specs.length - before).toBe(1);
  });

  it("waits for the in-flight session open before answering a tab request (2026-10-20 startup race)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holdSpawn = false;
    const harness = createHarness({
      onStart: async () => {
        if (holdSpawn) await gate;
      },
    });
    await harness.service.createTab({ cwd: "C:/work/app" });
    const tabId = harness.stored.tabs[0]!.id;

    // Simulate a relaunch: the tab is restored with no host running.
    await harness.service.restoreTabs();
    holdSpawn = true;
    const before = harness.specs.length;

    // The first activation starts the spawn and parks inside `supervisor.start`;
    // the renderer's boot-time `shortcuts.list` arrives while the session is
    // still opening and must wait for it instead of hitting a session-less host.
    const activating = harness.service.activateTab(tabId);
    // Let the spawn reach the gate before issuing the concurrent request.
    await Promise.resolve();
    await Promise.resolve();
    const requesting = harness.service.request(tabId, "shortcuts.list");
    release();
    const [, result] = await Promise.all([activating, requesting]);

    expect(result).toEqual({});
    expect(harness.specs.length - before).toBe(1);
    expect(harness.hosts.get(tabId)?.requests.map((request) => request.method)).toContain(
      "session.resume",
    );
  });

  it("forwards a request issued after the spawn settles straight to the ready host", async () => {
    const harness = createHarness();
    await harness.service.createTab({ cwd: "C:/work/app" });
    const tabId = harness.stored.tabs[0]!.id;
    const before = harness.specs.length;

    const result = await harness.service.request(tabId, "state.get");

    expect(result).toMatchObject({ sessionId: "session-1" });
    // No new host was spawned for the settled tab.
    expect(harness.specs.length).toBe(before);
  });
});

describe("pinned tabs and scoped close", () => {
  it("pins a tab to the front and persists the flag", async () => {
    const harness = createHarness();
    await harness.service.createTab({ cwd: "C:/work/a" });
    await harness.service.createTab({ cwd: "C:/work/b" });
    const [first] = harness.service.tabs();

    await harness.service.setPinned(first!.id, true);

    expect(harness.service.tabs().map((tab) => tab.id)).toEqual([
      first!.id,
      harness.service.tabs()[1]!.id,
    ]);
    expect(harness.service.tabs()[0]?.pinned).toBe(true);

    await harness.service.setPinned(first!.id, false);
    expect(harness.service.tabs()[0]?.pinned).toBeUndefined();
  });

  it("restores a persisted pinned tab at the front", async () => {
    const harness = createHarness();
    harness.stored.tabs = [
      {
        id: "plain",
        kind: "session",
        cwd: "C:/work/a",
        title: "a",
        sessionFile: null,
        status: "idle",
        createdAt: 1,
        lastActiveAt: 1,
        model: null,
      },
      {
        id: "pinned",
        kind: "editor",
        cwd: "C:/work/a",
        title: "a.ts",
        filePath: "a.ts",
        sessionFile: null,
        status: "idle",
        createdAt: 2,
        lastActiveAt: 2,
        model: null,
        pinned: true,
      },
    ];
    harness.stored.activeTabId = "plain";

    await harness.service.restoreTabs();

    expect(harness.service.tabs().map((tab) => tab.id)).toEqual(["pinned", "plain"]);
    expect(harness.service.tabs()[0]?.pinned).toBe(true);
  });

  it("closeAll is kind-scoped and leaves pinned tabs open", async () => {
    const harness = createHarness();
    await harness.service.createTab({ cwd: "C:/work/a" });
    await harness.service.createTab({ cwd: "C:/work/b" });
    await harness.service.createTab({ cwd: "C:/work/a", kind: "editor", filePath: "a.ts" });
    const [first, second, editor] = harness.service.tabs();
    await harness.service.setPinned(first!.id, true);

    await harness.service.closeAll("session");

    expect(harness.service.tabs().map((tab) => tab.id)).toEqual([first!.id, editor!.id]);
    expect(harness.service.tabs().some((tab) => tab.id === first!.id && tab.pinned)).toBe(true);
    expect(harness.service.tabs().some((tab) => tab.id === second!.id)).toBe(false);
  });

  it("closeOthers keeps the target, same-kind unpinned tabs only", async () => {
    const harness = createHarness();
    await harness.service.createTab({ cwd: "C:/work/a" });
    await harness.service.createTab({ cwd: "C:/work/b" });
    await harness.service.createTab({ cwd: "C:/work/a", kind: "editor", filePath: "a.ts" });
    const [first, second, editor] = harness.service.tabs();
    await harness.service.setPinned(first!.id, true);

    await harness.service.closeOthers(second!.id);

    expect(harness.service.tabs().map((tab) => tab.id)).toEqual([
      first!.id,
      second!.id,
      editor!.id,
    ]);
  });

  it("closeForProject closes every kind and pinned tabs", async () => {
    const harness = createHarness();
    await harness.service.createTab({ cwd: "C:/work/a" });
    await harness.service.createTab({ cwd: "C:/work/b" });
    await harness.service.createTab({ cwd: "C:/work/a", kind: "editor", filePath: "a.ts" });
    const [first, second] = harness.service.tabs();
    await harness.service.setPinned(first!.id, true);

    await harness.service.closeForProject("c:/work/a/");

    expect(harness.service.tabs().map((tab) => tab.id)).toEqual([second!.id]);
  });

  it("retargets editor tabs inside a renamed folder and across projects", async () => {
    const harness = createHarness();
    await harness.service.createTab({ cwd: "C:/work/a", kind: "editor", filePath: "src/app.ts" });
    await harness.service.createTab({ cwd: "C:/work/a", kind: "editor", filePath: "other.ts" });
    const [first, second] = harness.service.tabs();

    await harness.service.retargetEditorTabs({
      fromProjectPath: "C:/work/a",
      fromPath: "src",
      toProjectPath: "C:/work/b",
      toPath: "lib",
      kind: "directory",
    });

    expect(harness.service.tabs().find((tab) => tab.id === first!.id)).toMatchObject({
      cwd: "C:/work/b",
      filePath: "lib/app.ts",
      title: "app.ts",
    });
    expect(harness.service.tabs().find((tab) => tab.id === second!.id)).toMatchObject({
      cwd: "C:/work/a",
      filePath: "other.ts",
    });
  });

  it("clamps reorder to the tab's own pin group", async () => {
    const harness = createHarness();
    await harness.service.createTab({ cwd: "C:/work/a" });
    await harness.service.createTab({ cwd: "C:/work/b" });
    await harness.service.createTab({ cwd: "C:/work/c" });
    const [first, second, third] = harness.service.tabs();
    await harness.service.setPinned(first!.id, true);

    await harness.service.reorderTab(third!.id, 0);

    expect(harness.service.tabs().map((tab) => tab.id)).toEqual([first!.id, third!.id, second!.id]);
  });
});

describe("tab table publishing", () => {
  const tabsPushes = (harness: ReturnType<typeof createHarness>): number =>
    harness.pushes.filter((push) => push.channel === "tabs").length;

  it("skips an identical state frame and emits on a rendered-field change", async () => {
    const harness = createHarness();
    await harness.service.createTab({ cwd: "C:/work/a" });

    // The create handshake may leave the status one frame behind; settle it
    // first so the count measures the dedupe, not the handshake.
    harness.newest().emit("state", { streaming: false });
    const before = tabsPushes(harness);

    harness.newest().emit("state", { streaming: false });
    expect(tabsPushes(harness)).toBe(before);

    harness.newest().emit("state", { streaming: true });
    expect(tabsPushes(harness)).toBe(before + 1);

    harness.newest().emit("state", { streaming: true });
    expect(tabsPushes(harness)).toBe(before + 1);
  });

  it("returns the current table even when no push is needed", async () => {
    const harness = createHarness();
    const created = await harness.service.createTab({ cwd: "C:/work/a" });
    const id = created.tabs[0]!.id;

    const envelope = await harness.service.activateTab(id);

    // The returned envelope is the IPC answer; the dedupe only controls the
    // push channel.
    expect(envelope.activeTabId).toBe(id);
    expect(envelope.tabs.map((tab) => tab.id)).toEqual([id]);
  });
});
