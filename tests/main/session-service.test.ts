import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostMethod, HostRole } from "../../src/shared/host-protocol";
import type { TabRecord } from "../../src/shared/session-ipc";
import {
  CONTROL_HOST_ID,
  createSessionService,
  type SessionService,
  type SupervisorHostLike,
  type SupervisorLike,
} from "../../src/main/session-service";

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
  readonly requests: Array<{ method: string; params?: unknown }> = [];
  shutdownCount = 0;
  private statusValue = "ready";
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  status(): string {
    return this.statusValue;
  }

  setStatus(status: string): void {
    this.statusValue = status;
  }

  request(method: HostMethod, params?: unknown): Promise<unknown> {
    this.requests.push(params === undefined ? { method } : { method, params });
    return Promise.resolve(this.reply(method));
  }

  reply(method: string): unknown {
    if (method === "session.create" || method === "session.resume") {
      return {
        sessionId: "session-1",
        sessionFile: "/profile/sessions/s1.jsonl",
        streaming: false,
        model: { id: "test-model" },
      };
    }
    if (method === "state.get") {
      return {
        sessionId: "session-1",
        sessionFile: "/profile/sessions/s1.jsonl",
        streaming: false,
        model: { id: "test-model" },
        messageCount: 3,
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
  } {
    return {
      role: this.sessionId === CONTROL_HOST_ID ? "control" : "session",
      cwd: `C:\\work\\${this.sessionId}`,
      sessionId: this.sessionId,
      startedAt: 5,
      pids: { pid: 900 },
    };
  }

  logs(): string[] {
    return [`log line for ${this.sessionId}`];
  }

  /** Pushes a protocol event (the supervisor forwards the named event and `event`). */
  emit(event: string, payload?: unknown): void {
    const entry = payload === undefined ? { event } : { event, payload };
    for (const listener of this.listeners.get("event") ?? []) listener(entry);
  }

  emitLifecycle(event: string, payload?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

function createHarness(
  options: {
    maxTabs?: number;
    failCreate?: Error;
    /** Awaited inside the fake `supervisor.start`, to hold a spawn in flight. */
    onStart?: (spec: SpawnSpec) => Promise<void> | void;
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
      const host = new FakeHost(spec.sessionId);
      if (options.failCreate) {
        host.request = (method: HostMethod, params?: unknown) => {
          host.requests.push(params === undefined ? { method } : { method, params });
          return method === "session.create" || method === "session.resume"
            ? Promise.reject(options.failCreate)
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
    now: () => 1_000,
    newId: () => `tab-${++counter}`,
    ...(options.maxTabs === undefined ? {} : { maxTabs: options.maxTabs }),
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

  it("routes a request addressed to the control host without creating a tab", async () => {
    const { service, specs, hosts } = createHarness();
    const result = await service.request(CONTROL_HOST_ID, "providers.list");

    const control = hosts.get(CONTROL_HOST_ID)!;
    expect(control.requests).toEqual([{ method: "providers.list" }]);
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

  it("refuses to exceed the tab cap", async () => {
    const { service } = createHarness({ maxTabs: 1 });
    await service.createTab({ cwd: "C:\\work\\one" });
    await expect(service.createTab({ cwd: "C:\\work\\two" })).rejects.toThrow(/limit reached/i);
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

    host.emitLifecycle("resumed", { sessionFile: "/profile/sessions/s1.jsonl" });
    await vi.runOnlyPendingTimersAsync();

    expect(service.tabs()[0]!.status).toBe("idle");
    expect(
      eventsOf(pushes)
        .at(-1)!
        .events.map((entry) => entry.event),
    ).toEqual(["session.recovered"]);
    expect(host.requests.map((request) => request.method)).toContain("state.get");
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

  it("describes each tab and the control host for Diagnostics", async () => {
    const { service } = createHarness();
    await service.controlHost();
    await service.createTab({ cwd: "C:\\work\\app" });

    const rows = service.diagnosticsHosts();
    const control = rows.find((row) => row.tabId === CONTROL_HOST_ID);
    const tab = rows.find((row) => row.tabId === "tab-1");

    expect(control).toMatchObject({ role: "control", pid: 900, startedAt: 5 });
    expect(control?.logLines[0]).toContain("control");
    expect(tab).toMatchObject({
      role: "session",
      // The host process is ready; the tab's own status is tracked separately.
      status: "ready",
      sessionFile: "/profile/sessions/s1.jsonl",
      logLines: ["log line for tab-1"],
    });
  });

  it("reports used/limit for hosts and tabs (plan step 24 backpressure)", async () => {
    const { service } = createHarness({ maxTabs: 2 });
    await service.controlHost();
    await service.createTab({ cwd: "C:\\work\\app" });

    const caps = service.capacity();
    expect(caps.tabs).toEqual({ used: 1, limit: 2, atCapacity: false });
    // The control host plus the one session host.
    expect(caps.hosts.used).toBe(2);
    expect(caps.hosts.limit).toBe(8);
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

describe("persistence and restore", () => {
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
