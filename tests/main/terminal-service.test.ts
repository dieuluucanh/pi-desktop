import { describe, expect, it } from "vitest";
import {
  TerminalService,
  TerminalServiceError,
  type TerminalHostLike,
  type TerminalServiceOptions,
} from "../../src/main/terminal-service";
import {
  MAX_TERMINALS_PER_WINDOW,
  type TerminalAttachResult,
  type TerminalEventFrame,
  type TerminalInfo,
  type TerminalMethod,
  type TerminalSpawnSpec,
} from "../../src/shared/terminal-protocol";
import type { TerminalProfileSnapshot } from "../../src/shared/terminal-profiles";
import type { TabRecord } from "../../src/shared/session-ipc";

type Tab = Pick<TabRecord, "id" | "kind" | "cwd" | "lastCwd" | "profileId">;

class FakeHost implements TerminalHostLike {
  readonly requests: Array<{ method: TerminalMethod; params?: unknown }> = [];
  readonly live = new Map<string, TerminalInfo>();
  failNext: Error | null = null;
  disposed = 0;
  private nextId = 1;

  async request<T>(method: TerminalMethod, params?: unknown): Promise<T> {
    this.requests.push({ method, params: params as unknown });
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    switch (method) {
      case "terminal.open": {
        const spec = (params as { spec: TerminalSpawnSpec }).spec;
        const info: TerminalInfo = {
          id: `t-${this.nextId++}`,
          pid: 100 + this.nextId,
          title: "bash",
          cwd: spec.cwd,
          cols: spec.cols,
          rows: spec.rows,
        };
        this.live.set(info.id, info);
        return info as T;
      }
      case "terminal.attach": {
        const { terminalId } = params as { terminalId: string };
        if (!this.live.has(terminalId)) return null as T;
        return { data: "", bytes: 0, seq: 0 } satisfies TerminalAttachResult as T;
      }
      case "terminal.list":
        return [...this.live.values()] as T;
      case "terminal.close": {
        const { terminalId } = params as { terminalId: string };
        return { closed: this.live.delete(terminalId) } as T;
      }
      default:
        return {} as T;
    }
  }

  async dispose(): Promise<void> {
    this.disposed += 1;
  }
}

const BASH_SNAPSHOT: TerminalProfileSnapshot = {
  profiles: [
    {
      id: "posix-bash",
      label: "bash",
      kind: "posix",
      shellPath: "/bin/bash",
      args: ["-l"],
      isDefault: true,
    },
  ],
  defaultProfileId: "posix-bash",
  problems: [],
};

function createService(
  overrides: Partial<TerminalServiceOptions> = {},
  initialTabs: Tab[] = [
    { id: "tab-1", kind: "terminal", cwd: "/work/app", lastCwd: null, profileId: null },
  ],
) {
  const host = new FakeHost();
  let tabs = initialTabs;
  const events: TerminalEventFrame[] = [];
  const options: TerminalServiceOptions = {
    host,
    tabs: () => tabs,
    isProjectTrusted: () => true,
    preferences: () => ({ defaultProfile: "auto", shellPath: null }),
    detectProfiles: async () => BASH_SNAPSHOT,
    isDirectory: async () => true,
    emit: (frame) => events.push(frame),
    env: { PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1", HOME: "/home/me" },
    platform: "linux",
    profileDir: "/home/me/.pi/agent",
    termProgramVersion: "0.6.0",
    ...overrides,
  };
  const service = new TerminalService(options);
  return {
    service,
    host,
    events,
    setTabs: (next: Tab[]) => {
      tabs = next;
    },
  };
}

function openSpec(host: FakeHost, index = 0): TerminalSpawnSpec {
  const open = host.requests.filter((request) => request.method === "terminal.open")[index];
  return (open?.params as { spec: TerminalSpawnSpec }).spec;
}

function createInput(tabId = "tab-1", extra: Record<string, unknown> = {}) {
  return { tabId, cols: 80, rows: 24, ...extra };
}

describe("TerminalService.create", () => {
  it("resolves the profile, cwd and shell environment in main", async () => {
    const { service, host } = createService();
    const outcome = await service.create(createInput());
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.terminal).toMatchObject({ id: "t-1", cwd: "/work/app", cols: 80, rows: 24 });
    expect(outcome.replay).toEqual({ data: "", bytes: 0, seq: 0 });

    const spec = openSpec(host);
    expect(spec).toMatchObject({
      cwd: "/work/app",
      shell: "/bin/bash",
      args: ["-l"],
      cols: 80,
      rows: 24,
      name: "xterm-256color",
    });
    expect(spec.env).toMatchObject({
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "PiDesktop",
      TERM_PROGRAM_VERSION: "0.6.0",
      PI_CODING_AGENT_DIR: "/home/me/.pi/agent",
      PI_DESKTOP: "1",
      LANG: "en_US.UTF-8",
    });
    expect(spec.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it("is idempotent per tab: a second create reattaches instead of spawning", async () => {
    const { service, host } = createService();
    const first = await service.create(createInput());
    const second = await service.create(createInput());
    expect(first.kind).toBe("ok");
    expect(second.kind).toBe("ok");
    if (first.kind === "ok" && second.kind === "ok") {
      expect(second.terminal.id).toBe(first.terminal.id);
    }
    expect(host.requests.filter((request) => request.method === "terminal.open")).toHaveLength(1);
    expect(host.requests.filter((request) => request.method === "terminal.attach")).toHaveLength(2);
  });

  it("rejects an unknown tab and an invalid size", async () => {
    const { service } = createService();
    await expect(service.create(createInput("missing"))).resolves.toMatchObject({
      kind: "error",
      code: "not_found",
    });
    await expect(service.create({ tabId: "tab-1", cols: 0, rows: 24 })).resolves.toMatchObject({
      kind: "error",
      code: "bad_request",
    });
  });

  it("asks for trust, honours a session grant, and refuses never", async () => {
    const { service, host } = createService({ isProjectTrusted: async () => false });
    await expect(service.create(createInput())).resolves.toEqual({
      kind: "needs-trust",
      cwd: "/work/app",
    });
    expect(host.requests).toHaveLength(0);

    await expect(service.create(createInput("tab-1", { trust: "session" }))).resolves.toMatchObject(
      {
        kind: "ok",
      },
    );

    const other = createService({ isProjectTrusted: () => false });
    await expect(
      other.service.create(createInput("tab-1", { trust: "never" })),
    ).resolves.toMatchObject({ kind: "error", code: "closed" });
  });

  it("reports unavailable when no profile can be resolved", async () => {
    const { service } = createService({
      detectProfiles: async () => ({
        profiles: [],
        defaultProfileId: null,
        problems: [],
      }),
    });
    await expect(service.create(createInput())).resolves.toMatchObject({
      kind: "unavailable",
      profiles: [],
    });
  });

  it("maps a spawn failure to a typed outcome", async () => {
    const { service, host } = createService();
    host.failNext = new Error("ENOENT: shell missing");
    await expect(service.create(createInput())).resolves.toMatchObject({
      kind: "error",
      code: "spawn_failed",
    });
  });

  it("starts a lastCwd when it still exists and falls back when it does not", async () => {
    const ok = createService({ isDirectory: async () => true }, [
      {
        id: "tab-1",
        kind: "terminal",
        cwd: "/work/app",
        lastCwd: "/work/app/sub",
        profileId: null,
      },
    ]);
    await ok.service.create(createInput());
    expect(openSpec(ok.host).cwd).toBe("/work/app/sub");

    const stale = createService({ isDirectory: async (path) => path === "/work/app" }, [
      { id: "tab-1", kind: "terminal", cwd: "/work/app", lastCwd: "/gone", profileId: null },
    ]);
    await stale.service.create(createInput());
    expect(openSpec(stale.host).cwd).toBe("/work/app");
  });

  it("starts WSL in the Windows folder and maps the cwd with --cd", async () => {
    const { service, host } = createService(
      {
        detectProfiles: async () => ({
          profiles: [
            {
              id: "wsl-ubuntu",
              label: "WSL: Ubuntu",
              kind: "wsl",
              shellPath: "C:\\Windows\\System32\\wsl.exe",
              args: [],
              distro: "Ubuntu",
              isDefault: true,
            },
          ],
          defaultProfileId: "wsl-ubuntu",
          problems: [],
        }),
        isDirectory: async () => true,
      },
      [{ id: "tab-1", kind: "terminal", cwd: "C:\\work\\app", lastCwd: null, profileId: null }],
    );
    await service.create(createInput());
    expect(openSpec(host)).toMatchObject({
      cwd: "C:\\work\\app",
      shell: "C:\\Windows\\System32\\wsl.exe",
      args: ["-d", "Ubuntu", "--cd", "/mnt/c/work/app"],
    });
  });

  it("enforces the per-window limit", async () => {
    const tabs = Array.from({ length: MAX_TERMINALS_PER_WINDOW + 1 }, (_, index) => ({
      id: `tab-${index}`,
      kind: "terminal" as const,
      cwd: "/work/app",
      lastCwd: null,
      profileId: null,
    }));
    const { service } = createService({}, tabs);
    for (let index = 0; index < MAX_TERMINALS_PER_WINDOW; index += 1) {
      await expect(service.create(createInput(`tab-${index}`))).resolves.toMatchObject({
        kind: "ok",
      });
    }
    await expect(
      service.create(createInput(`tab-${MAX_TERMINALS_PER_WINDOW}`)),
    ).resolves.toMatchObject({
      kind: "error",
      code: "limit",
    });
  });
});

describe("TerminalService operations", () => {
  it("forwards write and resize and rejects an unknown terminal", async () => {
    const { service, host } = createService();
    const outcome = await service.create(createInput());
    if (outcome.kind !== "ok") throw new Error("expected a terminal");
    const id = outcome.terminal.id;

    await service.write(id, "ls\r");
    await service.resize(id, 120, 40);
    expect(host.requests).toEqual(
      expect.arrayContaining([
        { method: "terminal.write", params: { terminalId: id, data: "ls\r" } },
        { method: "terminal.resize", params: { terminalId: id, cols: 120, rows: 40 } },
      ]),
    );

    await expect(service.write("t-999", "x")).rejects.toBeInstanceOf(TerminalServiceError);
    await expect(service.resize(id, 0, 10)).rejects.toMatchObject({ code: "bad_request" });
  });

  it("forgets the terminal on close and ignores an unknown ack", async () => {
    const { service, host } = createService();
    const outcome = await service.create(createInput());
    if (outcome.kind !== "ok") throw new Error("expected a terminal");
    const id = outcome.terminal.id;

    service.ack(id, 10);
    service.ack("t-999", 10);
    expect(host.requests.filter((request) => request.method === "terminal.ack")).toHaveLength(1);

    await expect(service.close(id)).resolves.toBe(true);
    await expect(service.close(id)).resolves.toBe(false);
    expect(service.list()).toEqual([]);
  });

  it("closes a PTY when its tab disappears", async () => {
    const { service, host, setTabs } = createService();
    const outcome = await service.create(createInput());
    if (outcome.kind !== "ok") throw new Error("expected a terminal");
    const id = outcome.terminal.id;

    setTabs([]);
    service.syncTabs();
    expect(host.requests).toEqual(
      expect.arrayContaining([
        { method: "terminal.close", params: { terminalId: id, force: true } },
      ]),
    );
    expect(service.list()).toEqual([]);
  });

  it("fails every mapped terminal when the host exits, and restarts on the next create", async () => {
    const { service, host, events } = createService();
    const first = await service.create(createInput());
    if (first.kind !== "ok") throw new Error("expected a terminal");

    service.handleHostExit();
    expect(events).toEqual([
      {
        event: "terminal.error",
        payload: {
          terminalId: first.terminal.id,
          code: "closed",
          message: "the terminal host exited",
        },
      },
    ]);
    expect(service.list()).toEqual([]);

    const second = await service.create(createInput());
    expect(second.kind).toBe("ok");
    expect(host.requests.filter((request) => request.method === "terminal.open")).toHaveLength(2);
  });

  it("caches profiles by preference key and refreshes on force", async () => {
    let calls = 0;
    const { service } = createService({
      detectProfiles: async () => {
        calls += 1;
        return BASH_SNAPSHOT;
      },
    });
    await service.profiles();
    await service.profiles();
    expect(calls).toBe(1);
    await service.profiles(true);
    expect(calls).toBe(2);
  });

  it("disposes the host exactly once", async () => {
    const { service, host } = createService();
    await service.create(createInput());
    await service.dispose();
    expect(host.disposed).toBe(1);
    expect(service.list()).toEqual([]);
  });
});
