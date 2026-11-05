import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { normalize, delimiter } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  HostTimeoutError,
  MAX_HOST_LOG_LINES,
  OFFICE_BRIDGE_PORT,
  createHostSupervisor,
  type HostSpawner,
  type SpawnedHostProcess,
} from "../../src/main/host-supervisor";
import { createMemoryFsPort } from "../../src/main/fs-port";
import {
  HOST_PROTOCOL_VERSION,
  encodeFrame,
  type HostRequestFrame,
  type HostResponseFrame,
} from "../../src/shared/host-protocol";
import { hostProcessCeiling } from "../../src/shared/performance";

/**
 * Supervisor tests against a scripted fake host process: correlation, timeouts,
 * crash recovery, port assignment, the host cap and clean shutdown.
 */

const HOST_PATH = normalize("C:/app/out/host/index.mjs");
const NODE_PATH = normalize("C:/app/runtime/node/node.exe");
const NODE_BIN_DIR = normalize("C:/app/runtime/node");

interface FakeBehaviour {
  /** Methods that never get an answer (timeout tests). */
  silent?: readonly string[];
  /** Answer for a method; `undefined` falls back to the default answer. */
  answer?: (request: HostRequestFrame) => unknown;
  /**
   * Keeps the process alive after `kill()` until the test calls `finishExit()`.
   * Models a host that is slow to release a port.
   */
  ignoreKill?: boolean;
}

class FakeHost implements SpawnedHostProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: HostRequestFrame[] = [];
  readonly pid: number;
  killed = false;
  /** Every `kill()` call, so an escalation can be told from the first signal. */
  readonly killCalls: Array<string | number | undefined> = [];
  private readonly emitter = new EventEmitter();
  private readonly behaviour: FakeBehaviour;
  /** Set by `ignoreKill`: the process stays alive until `finishExit()`. */
  private pendingExit = false;

  constructor(pid: number, behaviour: FakeBehaviour = {}) {
    this.pid = pid;
    this.behaviour = behaviour;
    this.stdin.on("data", (chunk: Buffer) => this.onInput(chunk.toString()));
  }

  on(event: "exit" | "error", listener: (...args: unknown[]) => void): SpawnedHostProcess {
    this.emitter.on(event, listener);
    return this;
  }

  kill(signal?: string | number): boolean {
    this.killCalls.push(signal);
    this.killed = true;
    if (this.behaviour.ignoreKill) {
      // A process that does not die on SIGTERM: the supervisor's bounded wait is
      // what keeps `stop()` from hanging forever.
      this.pendingExit = true;
      return true;
    }
    this.emitter.emit("exit", 0, "SIGTERM");
    return true;
  }

  /** Emits the exit frame a `kill` refused to emit (`ignoreKill`). */
  finishExit(): void {
    if (!this.pendingExit) return;
    this.pendingExit = false;
    this.emitter.emit("exit", 0, "SIGTERM");
  }

  /** Simulates an unexpected process death (e.g. the SDK calling exit). */
  crash(code = 3, signal = ""): void {
    this.emitter.emit("exit", code, signal);
  }

  emitEvent(event: string, payload?: unknown): void {
    this.stdout.write(encodeFrame({ event, payload }));
  }

  private onInput(chunk: string): void {
    for (const line of chunk.split("\n")) {
      if (line.trim().length === 0) continue;
      const request = JSON.parse(line) as HostRequestFrame;
      this.requests.push(request);
      if (this.behaviour.silent?.includes(request.method)) continue;
      const custom = this.behaviour.answer?.(request);
      const result = custom !== undefined ? custom : defaultAnswer(request);
      this.respond({ id: request.id, ok: true, result });
    }
  }

  private respond(frame: HostResponseFrame): void {
    this.stdout.write(encodeFrame(frame));
  }
}

function defaultAnswer(request: HostRequestFrame): unknown {
  switch (request.method) {
    case "host.hello":
      return {
        protocolVersion: HOST_PROTOCOL_VERSION,
        nodeVersion: "v24.21.0",
        piVersion: "0.85.1",
        sessionId: (request.params as { sessionId?: string } | undefined)?.sessionId ?? "fake",
        cwd: normalize("C:/work"),
        bridgePort: 38618,
        pids: { pid: 1234, ppid: 1 },
        startedAt: 1,
        buildId: "build-1",
      };
    case "host.ping":
      return { pong: true };
    case "host.shutdown":
      return { ok: true };
    default:
      return { echoed: request.method };
  }
}

function harness(
  options: {
    behaviours?: FakeBehaviour[];
    sessionFile?: string | null;
    maxHosts?: number;
    npmCliPath?: string;
    env?: Record<string, string | undefined>;
    safeMode?: boolean;
    telemetryEnabled?: boolean | (() => boolean);
    hostBuildId?: () => string | null;
    /** Enable `host.metrics` polling; disabled by default so request order is stable. */
    memoryPollMs?: number;
    maxRssBytes?: number;
    idleTimeoutMs?: number;
    maxRestarts?: number;
    isPinned?: (sessionId: string) => boolean;
    isBridgeOwner?: (sessionId: string) => boolean;
  } = {},
) {
  const spawned: FakeHost[] = [];
  const spawnCalls: Array<{
    command: string;
    args: readonly string[];
    env: Record<string, string | undefined>;
  }> = [];
  const spawner: HostSpawner = (command, args, spawnOptions) => {
    spawnCalls.push({ command, args, env: spawnOptions.env });
    const child = new FakeHost(1000 + spawned.length, options.behaviours?.[spawned.length] ?? {});
    spawned.push(child);
    return child;
  };
  const fs = createMemoryFsPort();

  const supervisor = createHostSupervisor({
    nodePath: NODE_PATH,
    hostPath: HOST_PATH,
    binDir: normalize("C:/app/resources/runtime/bin"),
    nodeBinDir: NODE_BIN_DIR,
    logDir: normalize("C:/user-data/logs"),
    blobDir: normalize("C:/user-data/blob-cache"),
    profileDir: normalize("C:/Users/Test/.pi/agent"),
    env: options.env ?? { PATH: normalize("C:/Windows/System32") },
    ...(options.npmCliPath ? { npmCliPath: options.npmCliPath } : {}),
    spawner,
    fs,
    requestTimeoutMs: 1_000,
    maxHosts: options.maxHosts ?? hostProcessCeiling(),
    idleTimeoutMs: options.idleTimeoutMs ?? 0,
    ...(options.maxRestarts === undefined ? {} : { maxRestarts: options.maxRestarts }),
    memoryPollMs: options.memoryPollMs ?? 0,
    ...(options.maxRssBytes ? { maxRssBytes: options.maxRssBytes } : {}),
    safeMode: options.safeMode ?? false,
    telemetryEnabled: options.telemetryEnabled ?? false,
    ...(options.hostBuildId ? { hostBuildId: options.hostBuildId } : {}),
    ...(options.isPinned ? { isPinned: options.isPinned } : {}),
    ...(options.isBridgeOwner ? { isBridgeOwner: options.isBridgeOwner } : {}),
  });

  return { supervisor, spawned, spawnCalls, fs };
}

describe("host supervisor startup", () => {
  it("spawns with the bundled runtime, the shim PATH and the session env", async () => {
    const { supervisor, spawned, spawnCalls } = harness();

    const host = await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });

    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.requests.at(0)?.method).toBe("host.hello");
    expect(host.status()).toBe("ready");
    expect(await host.ready()).toMatchObject({
      protocolVersion: HOST_PROTOCOL_VERSION,
      piVersion: "0.85.1",
    });
    expect(host.port).toBe(38618);
    expect(supervisor.list()).toHaveLength(1);

    // The host learns where the bundled runtime is (plan step 14), and PATH
    // carries the shim dir then the real node dir, so `node` is an executable.
    expect(spawnCalls[0]?.env.PI_DESKTOP_NODE).toBe(NODE_PATH);
    expect(spawnCalls[0]?.env.PI_DESKTOP_HOST_MODE).toBe("service");
    expect(spawnCalls[0]?.env.PATH).toBe(
      [
        normalize("C:/app/resources/runtime/bin"),
        NODE_BIN_DIR,
        normalize("C:/Windows/System32"),
      ].join(delimiter),
    );
  });

  it("keeps one path-like env key and merges a base Path spelling on Windows", async () => {
    const { supervisor, spawnCalls } = harness({
      env: { Path: normalize("C:/Windows/System32") },
    });
    await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });

    const pathKeys = Object.keys(spawnCalls[0]?.env ?? {}).filter(
      (key) => key.toLowerCase() === "path",
    );
    expect(pathKeys).toHaveLength(1);
    expect(spawnCalls[0]?.env[pathKeys[0] ?? ""]).toContain(normalize("C:/Windows/System32"));
  });

  it("stamps the spawn with the host bundle fingerprint", async () => {
    const { supervisor, spawnCalls } = harness({ hostBuildId: () => "build-1" });
    const host = await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });

    expect(spawnCalls[0]?.env.PI_DESKTOP_HOST_BUILD).toBe("build-1");
    expect(host.info()?.buildId).toBe("build-1");

    const bare = harness();
    await bare.supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });
    expect(bare.spawnCalls[0]?.env).not.toHaveProperty("PI_DESKTOP_HOST_BUILD");
  });

  it("passes the bundled npm CLI to the host when the runtime resolved one", async () => {
    const npmCliPath = normalize("C:/app/runtime/node/npm-cli.js");
    const { supervisor, spawnCalls } = harness({ npmCliPath });
    await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work"), role: "control" });
    expect(spawnCalls[0]?.env.PI_DESKTOP_NPM_CLI).toBe(npmCliPath);
  });

  it("omits the npm CLI variable when the runtime has none", async () => {
    const { supervisor, spawnCalls } = harness();
    await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });
    expect(spawnCalls[0]?.env).not.toHaveProperty("PI_DESKTOP_NPM_CLI");
  });

  it("reserves port 38617 for the Office host and hands out 38618+ to everyone else", async () => {
    const { supervisor } = harness();

    const office = await supervisor.start({
      sessionId: "office",
      cwd: normalize("C:/work"),
      officeHost: true,
    });
    const first = await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });
    const second = await supervisor.start({ sessionId: "s2", cwd: normalize("C:/work") });

    expect(office.port).toBe(OFFICE_BRIDGE_PORT);
    expect(first.port).toBe(38618);
    expect(second.port).toBe(38619);
    expect(supervisor.allocatedPorts()).toEqual([OFFICE_BRIDGE_PORT, 38618, 38619]);
  });

  it("enforces the emergency host-process ceiling with a readable error", async () => {
    const { supervisor } = harness({ maxHosts: 1 });
    await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });

    await expect(supervisor.start({ sessionId: "s2", cwd: normalize("C:/work") })).rejects.toThrow(
      /memory-derived ceiling of 1 host processes/,
    );
  });

  it("stops a child whose handshake never completes", async () => {
    const { supervisor, spawned } = harness({ behaviours: [{ silent: ["host.hello"] }] });

    await expect(
      supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") }),
    ).rejects.toBeInstanceOf(HostTimeoutError);

    expect(spawned[0]?.killed).toBe(true);
    expect(supervisor.list()).toHaveLength(0);

    // The failed child must not block a later, healthy spawn for the same id.
    const host = await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });
    expect(host.status()).toBe("ready");
    expect(spawned).toHaveLength(2);
  });
});

describe("host supervisor requests", () => {
  it("correlates responses that arrive out of order", async () => {
    const { supervisor, spawned } = harness({
      behaviours: [
        {
          answer: (request) => (request.method === "prompt" ? "prompt-result" : undefined),
        },
      ],
    });
    const host = await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });
    const child = spawned.at(-1);
    if (!child) throw new Error("no child spawned");

    // Answer the second request first by hand, after letting the first through.
    const promptPromise = host.request("prompt", { text: "hi" });
    const statePromise = host.request("state.get");
    child.stdout.write(encodeFrame({ id: 99, ok: true, result: { ignored: true } }));

    await expect(promptPromise).resolves.toBe("prompt-result");
    await expect(statePromise).resolves.toEqual({ echoed: "state.get" });
  });

  it("rejects with a timeout instead of hanging forever", async () => {
    const { supervisor } = harness({ behaviours: [{ silent: ["compact"] }] });
    const host = await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });

    await expect(host.request("compact", {}, { timeoutMs: 20 })).rejects.toBeInstanceOf(
      HostTimeoutError,
    );
  });

  it("forwards host events to listeners", async () => {
    const { supervisor, spawned } = harness();
    const host = await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });
    const listener = vi.fn();
    host.on("message_update", listener);

    spawned[0]?.emitEvent("message_update", { text: "hello" });

    expect(listener).toHaveBeenCalledWith({ text: "hello" });
  });
});

describe("host supervisor recovery", () => {
  it("restarts a crashed process without resuming the session itself", async () => {
    const { supervisor, spawned } = harness({
      sessionFile: normalize("C:/profile/sessions/s1.jsonl"),
    });
    const host = await supervisor.start({
      sessionId: "s1",
      cwd: normalize("C:/work"),
      sessionFile: normalize("C:/profile/sessions/s1.jsonl"),
    });
    const crashed = vi.fn();
    const restarted = vi.fn();
    host.on("crashed", crashed);
    host.on("restarted", restarted);

    spawned[0]?.crash(3);

    await vi.waitFor(() => {
      expect(spawned.length).toBe(2);
    });
    await vi.waitFor(() => {
      expect(restarted).toHaveBeenCalledWith({ reason: "crash", sessionId: "s1" });
    });

    expect(crashed).toHaveBeenCalledWith(expect.objectContaining({ code: 3, sessionId: "s1" }));
    expect(host.status()).toBe("ready");
    // The session service owns `session.resume`; a process restart only handshakes.
    expect(spawned[1]?.requests.map((request) => request.method)).toEqual(["host.hello"]);
  });

  it("ignores a late exit from a superseded child", async () => {
    const { supervisor, spawned } = harness();
    const host = await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });
    const crashed = vi.fn();
    host.on("crashed", crashed);

    const old = spawned[0]!;
    // A crash schedules a replacement; the old child then emits a second exit
    // (for example a SIGTERM after the crash). It must not speak for the new one.
    old.crash(9);
    await vi.waitFor(() => expect(spawned.length).toBe(2));
    const fresh = spawned[1]!;
    old.crash(9);

    expect(spawned.length).toBe(2);
    expect(crashed).toHaveBeenCalledTimes(1);
    expect(host.status()).toBe("ready");
    expect(fresh.requests.map((request) => request.method)).toEqual(["host.hello"]);
  });

  it("gives up after the restart budget is exhausted", async () => {
    const { supervisor, spawned } = harness({ maxRestarts: 1 });
    const host = await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });

    // Crash each *new* child; a repeated exit from the same child is ignored.
    spawned[0]?.crash(9);
    await vi.waitFor(() => expect(spawned.length).toBe(2));
    spawned[1]?.crash(9);

    await vi.waitFor(() => expect(host.status()).toBe("failed"));
    expect(supervisor.get("s1")?.status()).toBe("failed");
  });

  it("marks a host failed when a frame exceeds the size limit", async () => {
    const { supervisor, spawned } = harness();
    const host = await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });

    spawned[0]?.stdout.write(`${"x".repeat(6 * 1024 * 1024)}\n`);

    await vi.waitFor(() => {
      expect(host.status()).toBe("failed");
    });
  });
});

describe("host supervisor shutdown", () => {
  it("asks the host to shut down, kills it and releases its port", async () => {
    const { supervisor, spawned } = harness();
    const host = await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });

    await supervisor.stop("s1");

    expect(spawned[0]?.requests.some((request) => request.method === "host.shutdown")).toBe(true);
    expect(spawned[0]?.killed).toBe(true);
    expect(host.status()).toBe("stopped");
    expect(supervisor.list()).toHaveLength(0);
    expect(supervisor.allocatedPorts()).toEqual([]);
  });

  it("stops every host", async () => {
    const { supervisor, spawned } = harness();
    await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });
    await supervisor.start({ sessionId: "s2", cwd: normalize("C:/work") });

    await supervisor.stopAll();

    expect(spawned.every((child) => child.killed)).toBe(true);
    expect(supervisor.list()).toHaveLength(0);
  });

  it("waits for the child to exit before reporting the port released", async () => {
    // 2026-10-30 project-scoped rail plan: promotion re-spawns on 38617 right
    // after this resolves, so a child that is still dying would hold the port.
    const { supervisor, spawned } = harness({
      // Exit only when the test says so: a child that ignores SIGTERM for a while.
      behaviours: [{ ignoreKill: true }],
    });
    const host = await supervisor.start({
      sessionId: "office",
      cwd: normalize("C:/work"),
      officeHost: true,
    });
    expect(host.port).toBe(38617);

    const stopping = supervisor.stop("office");
    let settled = false;
    void stopping.then(() => {
      settled = true;
    });

    // The shutdown request was answered and SIGTERM was sent...
    await vi.waitFor(() =>
      expect(spawned[0]?.requests.some((r) => r.method === "host.shutdown")).toBe(true),
    );
    await vi.waitFor(() => expect(spawned[0]?.killCalls.length).toBeGreaterThan(0));
    // ...but the supervisor must not pretend the host is gone yet.
    expect(settled).toBe(false);
    expect(supervisor.list()).toHaveLength(1);

    spawned[0]!.finishExit();
    await stopping;

    expect(settled).toBe(true);
    expect(host.status()).toBe("stopped");
    expect(supervisor.list()).toHaveLength(0);
    expect(supervisor.allocatedPorts()).toEqual([]);
  });

  it("refuses to restart a host that is already shutting down (plan step 27)", async () => {
    const { supervisor } = harness();
    const host = await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });

    await host.shutdown();

    await expect(host.restart("crash")).rejects.toThrow(/shutting down/);
  });

  it("stops the replacement when a restart handshake fails", async () => {
    const { supervisor, spawned } = harness({
      behaviours: [{}, { silent: ["host.hello"] }],
    });
    const host = await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });

    await expect(host.restart("test")).rejects.toBeInstanceOf(HostTimeoutError);

    expect(spawned[1]?.killed).toBe(true);
    expect(host.status()).toBe("failed");
  });

  it("does not restart a crashed host once it has been stopped (plan step 27)", async () => {
    const { supervisor, spawned } = harness();
    const host = await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });

    // The crash queues a restart after the backoff; the stop must win.
    spawned[0]?.crash(3);
    await host.shutdown();

    await vi.waitFor(() => expect(host.status()).toBe("stopped"));
    expect(spawned).toHaveLength(1);
  });

  it("writes a per-session log", async () => {
    const { supervisor, fs } = harness();
    await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });

    const logFile = [...fs.files.keys()].find((file) => file.endsWith("s1.log"));
    expect(logFile, "a log file per session").toBeDefined();
    expect(fs.files.get(logFile ?? "") ?? "").toContain("spawned");
  });

  it("bounds the in-memory and on-disk log", async () => {
    const { supervisor, spawned, fs } = harness();
    const host = await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });

    for (let index = 0; index < MAX_HOST_LOG_LINES + 250; index += 1) {
      spawned[0]?.stderr.write(`stderr line ${index}\n`);
    }

    const lines = host.logs();
    expect(lines.length).toBeLessThanOrEqual(MAX_HOST_LOG_LINES);
    expect(lines.at(-1)).toContain(`stderr line ${MAX_HOST_LOG_LINES + 249}`);

    const logFile = [...fs.files.keys()].find((file) => file.endsWith("s1.log"));
    expect((fs.files.get(logFile ?? "") ?? "").length).toBeLessThanOrEqual(64_000);
  });
});

describe("host supervisor reliability (plan step 22)", () => {
  it("reports the host identity and its log tail", async () => {
    const { supervisor } = harness({
      behaviours: [
        {
          answer: (request) =>
            request.method === "host.hello"
              ? {
                  protocolVersion: HOST_PROTOCOL_VERSION,
                  nodeVersion: "v24.21.0",
                  piVersion: "0.85.1",
                  role: "control",
                  sessionId: "s1",
                  cwd: normalize("C:/work"),
                  bridgePort: 38618,
                  pids: { pid: 4242, ppid: 1 },
                  startedAt: 7,
                }
              : undefined,
        },
      ],
    });
    const host = await supervisor.start({
      sessionId: "s1",
      cwd: normalize("C:/work"),
      role: "control",
    });

    expect(host.info()?.role).toBe("control");
    expect(host.info()?.cwd).toBe(normalize("C:/work"));
    expect(host.info()?.startedAt).toBe(7);
    expect(host.info()?.pids?.pid).toBe(4242);
    expect(host.logs().join("\n")).toContain("spawned");
    expect(host.logs()).not.toBe(host.logs());
  });

  it("emits a timeout event when a request wedges", async () => {
    const { supervisor } = harness({ behaviours: [{ silent: ["compact"] }] });
    const host = await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });
    const timeouts: unknown[] = [];
    host.on("timeout", (payload) => timeouts.push(payload));

    await expect(host.request("compact", {}, { timeoutMs: 20 })).rejects.toBeInstanceOf(
      HostTimeoutError,
    );

    expect(timeouts).toEqual([{ method: "compact", timeoutMs: 20, sessionId: "s1" }]);
    expect(host.logs().join("\n")).toContain("timed out");
  });

  it("tells every host whether safe mode is on", async () => {
    const off = harness({ safeMode: false });
    await off.supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });
    expect(off.spawnCalls[0]?.env.PI_DESKTOP_SAFE_MODE).toBe("0");

    const on = harness({ safeMode: true });
    await on.supervisor.start({ sessionId: "s2", cwd: normalize("C:/work") });
    expect(on.spawnCalls[0]?.env.PI_DESKTOP_SAFE_MODE).toBe("1");
  });

  it("forces Pi's install telemetry off unless the user opted in", async () => {
    const off = harness();
    await off.supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });
    expect(off.spawnCalls[0]?.env.PI_TELEMETRY).toBe("0");

    const on = harness({ telemetryEnabled: true });
    await on.supervisor.start({ sessionId: "s2", cwd: normalize("C:/work") });
    expect(on.spawnCalls[0]?.env.PI_TELEMETRY).toBe("1");
  });

  it("reads the telemetry preference at each spawn, so a change applies live", async () => {
    let enabled = false;
    const { supervisor, spawnCalls } = harness({ telemetryEnabled: () => enabled });
    await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });
    expect(spawnCalls[0]?.env.PI_TELEMETRY).toBe("0");

    enabled = true;
    await supervisor.start({ sessionId: "s2", cwd: normalize("C:/work") });
    expect(spawnCalls[1]?.env.PI_TELEMETRY).toBe("1");
  });
});

describe("host supervisor resource guardrails (plan step 24)", () => {
  const metricsAnswer = (rss: number) => (request: HostRequestFrame) =>
    request.method === "host.metrics"
      ? {
          rssBytes: rss,
          heapUsedBytes: 1,
          heapTotalBytes: 2,
          uptimeMs: 3,
          at: 4,
        }
      : undefined;

  it("reports used/limit of the emergency host-process ceiling", async () => {
    const { supervisor } = harness({ maxHosts: 2 });
    expect(supervisor.capacity()).toEqual({ used: 0, limit: 2, atCapacity: false });
    await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });
    expect(supervisor.capacity()).toEqual({ used: 1, limit: 2, atCapacity: false });
    await supervisor.start({ sessionId: "s2", cwd: normalize("C:/work") });
    expect(supervisor.capacity().atCapacity).toBe(true);
  });

  it("exposes parkability probes without leaking the child process", async () => {
    let pinned = false;
    const { supervisor } = harness({ isPinned: () => pinned });
    const host = await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });

    expect(host.pinned()).toBe(false);
    expect(host.isIdle()).toBe(true);
    pinned = true;
    expect(host.pinned()).toBe(true);
  });

  it("does not idle-recycle a session that is still working", async () => {
    const { supervisor, spawned } = harness({
      idleTimeoutMs: 5,
      behaviours: [
        {
          answer: (request) => (request.method === "state.get" ? { streaming: true } : undefined),
        },
      ],
    });
    await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(supervisor.get("s1")?.status()).toBe("ready");
    expect(spawned[0]?.killed).toBe(false);
  });

  it("surfaces the host cap as a coded error, not a prose-only failure", async () => {
    const { supervisor } = harness({ maxHosts: 1 });
    await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });
    await expect(
      supervisor.start({ sessionId: "s2", cwd: normalize("C:/work") }),
    ).rejects.toMatchObject({ code: "host_limit" });
  });

  it("polls host.metrics and exposes the last RSS sample", async () => {
    const { supervisor } = harness({
      memoryPollMs: 5,
      behaviours: [{ answer: metricsAnswer(123_456_789) }],
    });
    const host = await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });

    await vi.waitFor(() => {
      expect(host.metrics()?.rssBytes).toBe(123_456_789);
    });
    // The poll is not user activity, so the host is still considered idle.
    expect(host.status()).toBe("ready");
  });

  it("recycles a host that is over the RSS threshold by stopping it", async () => {
    const { supervisor, spawned } = harness({
      memoryPollMs: 5,
      maxRssBytes: 1_000,
      behaviours: [{ answer: metricsAnswer(5_000) }],
    });
    const host = await supervisor.start({
      sessionId: "s1",
      cwd: normalize("C:/work"),
      sessionFile: normalize("C:/profile/sessions/s1.jsonl"),
    });

    await vi.waitFor(() => {
      expect(supervisor.get("s1")).toBeUndefined();
    });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.killed).toBe(true);
    expect(host.logs().join("\n")).toContain("over the 0 MB threshold");
    expect(host.status()).toBe("stopped");

    // A recycle never resumes by itself; re-starting the id is a fresh process
    // and `session-service` performs the resume.
    await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });
    expect(spawned).toHaveLength(2);
    expect(spawned[1]?.requests.map((request) => request.method)).toContain("host.hello");
    expect(spawned[1]?.requests.map((request) => request.method)).not.toContain("session.resume");
  });

  it("keeps a streaming host alive even when it is over the RSS threshold", async () => {
    const { supervisor, spawned } = harness({
      memoryPollMs: 5,
      maxRssBytes: 1_000,
      isPinned: () => true,
      behaviours: [
        {
          answer: (request) =>
            request.method === "host.metrics"
              ? {
                  rssBytes: 5_000,
                  heapUsedBytes: 1,
                  heapTotalBytes: 2,
                  uptimeMs: 3,
                  at: 4,
                }
              : request.method === "state.get"
                ? { streaming: true }
                : undefined,
        },
      ],
    });
    await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(supervisor.get("s1")?.status()).toBe("ready");
    expect(spawned[0]?.killed).toBe(false);
  });

  it("recycles a pinned active host when it is idle and over the RSS threshold", async () => {
    const { supervisor, spawned } = harness({
      memoryPollMs: 5,
      maxRssBytes: 1_000,
      isPinned: () => true,
      behaviours: [{ answer: metricsAnswer(5_000) }],
    });
    await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });

    await vi.waitFor(() => {
      expect(supervisor.get("s1")).toBeUndefined();
    });
    expect(spawned[0]?.killed).toBe(true);
  });

  it("never RSS-recycles the Office bridge owner even when it is over the threshold", async () => {
    const { supervisor, spawned } = harness({
      memoryPollMs: 5,
      maxRssBytes: 1_000,
      isBridgeOwner: () => true,
      behaviours: [{ answer: metricsAnswer(5_000) }],
    });
    await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(supervisor.get("s1")?.status()).toBe("ready");
    expect(spawned[0]?.killed).toBe(false);
  });

  it("never RSS-recycles the Office bridge owner", async () => {
    const { supervisor, spawned } = harness({
      memoryPollMs: 5,
      maxRssBytes: 1_000,
      behaviours: [{ answer: metricsAnswer(5_000) }],
    });
    await supervisor.start({
      sessionId: "office",
      cwd: normalize("C:/work"),
      officeHost: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(supervisor.get("office")?.status()).toBe("ready");
    expect(spawned[0]?.killed).toBe(false);
  });

  it("recycles an idle host and drops it from the supervisor so it can re-spawn", async () => {
    const { supervisor, spawned } = harness({ idleTimeoutMs: 5 });
    await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });

    await vi.waitFor(() => {
      expect(supervisor.get("s1")).toBeUndefined();
    });
    expect(spawned[0]?.killed).toBe(true);

    // Re-issuing the same id spawns a fresh process rather than returning a dead one.
    await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });
    expect(spawned).toHaveLength(2);
  });

  it("never recycles the Office host, which owns the bridge port", async () => {
    const { supervisor } = harness({ idleTimeoutMs: 5 });
    await supervisor.start({
      sessionId: "office",
      cwd: normalize("C:/work"),
      officeHost: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(supervisor.get("office")?.status()).toBe("ready");
  });

  it("does not recycle a pinned bridge owner, then recycles after unpin", async () => {
    let pinned = true;
    const { supervisor, spawned } = harness({
      idleTimeoutMs: 5,
      isPinned: () => pinned,
    });
    await supervisor.start({ sessionId: "s1", cwd: normalize("C:/work") });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(supervisor.get("s1")?.status()).toBe("ready");
    expect(spawned[0]?.killed).toBe(false);

    pinned = false;
    await vi.waitFor(() => {
      expect(supervisor.get("s1")).toBeUndefined();
    });
    expect(spawned[0]?.killed).toBe(true);
  });
});
