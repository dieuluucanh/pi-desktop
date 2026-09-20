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

  /** Pushes a protocol event (the supervisor forwards the named event and `event`). */
  emit(event: string, payload?: unknown): void {
    const entry = payload === undefined ? { event } : { event, payload };
    for (const listener of this.listeners.get("event") ?? []) listener(entry);
  }

  emitLifecycle(event: string, payload?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

function createHarness(options: { maxTabs?: number; failCreate?: Error } = {}): {
  service: SessionService;
  hosts: Map<string, FakeHost>;
  specs: SpawnSpec[];
  pushes: Array<{ channel: "event" | "state" | "tabs"; payload: unknown }>;
  stored: { tabs: TabRecord[]; activeTabId: string | null };
  newest(): FakeHost;
} {
  const hosts = new Map<string, FakeHost>();
  const specs: SpawnSpec[] = [];
  const pushes: Array<{ channel: "event" | "state" | "tabs"; payload: unknown }> = [];
  const stored: { tabs: TabRecord[]; activeTabId: string | null } = { tabs: [], activeTabId: null };

  const supervisor: SupervisorLike = {
    start: async (spec) => {
      specs.push(spec);
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
      hosts.delete(id);
    },
    stopAll: async () => {
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

  return { service, hosts, specs, pushes, stored, newest: () => [...hosts.values()].at(-1)! };
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
    await service.prewarmLast();
    expect(specs.map((spec) => spec.sessionId)).toEqual(["tab-2"]);
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
