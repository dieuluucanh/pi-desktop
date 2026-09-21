import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { basename, join } from "node:path";
import {
  BACKUP_DIR_ENV,
  BLOB_DIR_ENV,
  HOST_PROTOCOL_VERSION,
  HOST_ROLE_ENV,
  JsonlFrameDecoder,
  NODE_BIN_ENV,
  NPM_CLI_ENV,
  SAFE_MODE_ENV,
  TELEMETRY_ENV,
  encodeFrame,
  isEventFrame,
  isResponseFrame,
  type HostMethod,
  type HostRequestFrame,
  type HostRole,
} from "../shared/host-protocol";
import { createNodeFsPort, type FsPort } from "./fs-port";
import { SESSION_ID_ENV, SERVICE_ENV, SERVICE_FLAG } from "../host/index";
import {
  HOST_RSS_RESTART_BYTES,
  IDLE_HOST_TIMEOUT_MS,
  MAX_HOSTS,
  capacity,
  capacityMessage,
  shouldRestartForMemory,
  type Capacity,
  type HostMemoryMetrics,
} from "../shared/performance";

/**
 * Supervises Pi host processes (plan step 4): one per session tab, spawned with
 * the bundled Node runtime, speaking JSONL over stdio.
 *
 * Responsibilities: request/response correlation with timeouts, per-host logs,
 * crash detection with backoff + `session.resume`, idle recycling, a host cap
 * and port allocation (38617 is reserved for the Office host, plan D10).
 *
 * The spawn function and the filesystem port are injectable, so the whole thing
 * is unit testable without spawning real processes.
 */

/** Lifecycle listener for a spawned child (`exit`, `error`). */
export type HostLifecycleListener = (...args: unknown[]) => void;

/** Listener for a host event frame (`agent_start`, `message_update`, …). */
export type HostEventListener = (payload: unknown) => void;

export interface SpawnedHostProcess {
  pid: number | null;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream | null;
  killed?: boolean;
  on(event: "exit" | "error", listener: HostLifecycleListener): SpawnedHostProcess;
  kill(signal?: NodeJS.Signals): boolean;
}

export type HostSpawner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string | undefined>; windowsHide?: boolean },
) => SpawnedHostProcess;

export interface HostSpawnSpec {
  sessionId: string;
  cwd: string;
  /** Which core the child builds: app-wide control, or one Pi session (D-A3). */
  role?: HostRole;
  /** The Office tab owns port 38617; every other host gets 38618+. */
  officeHost?: boolean;
  /** Session JSONL to resume after a crash (plan step 5 fills this in). */
  sessionFile?: string | null;
  /** Extra arguments passed to the host (debugging). */
  args?: readonly string[];
}

export type HostStatus = "starting" | "ready" | "restarting" | "stopped" | "failed";

export interface HostInfo {
  protocolVersion: number;
  nodeVersion: string;
  piVersion: string | null;
  /** `control` hosts own no session; `session` hosts own exactly one (D-A3). */
  role?: HostRole;
  sessionId: string | null;
  cwd: string;
  bridgePort: number | null;
  pids: { pid: number; ppid: number };
  startedAt: number;
}

export interface HostEvent {
  event: string;
  sessionId?: string;
  payload?: unknown;
}

export interface HostHandle {
  readonly sessionId: string;
  readonly port: number;
  readonly officeHost: boolean;
  ready(): Promise<HostInfo>;
  status(): HostStatus;
  /** The host's identity once the handshake completed, else null (plan step 22). */
  info(): HostInfo | null;
  /**
   * The host's last self-reported memory sample, or null before the first poll
   * (plan step 24). The host reads its own RSS so no OS-specific process query
   * is needed.
   */
  metrics(): HostMemoryMetrics | null;
  /** The tail of the host's own log, oldest first — the Diagnostics view reads it. */
  logs(): string[];
  request(method: HostMethod, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
  on(event: string, listener: HostEventListener): () => void;
  restart(reason?: string): Promise<HostInfo>;
  /**
   * Records the session file so a later crash-restart resumes *this* session.
   * The spawn spec is created before the session exists, so without this a
   * recovered host would come back with an empty session (plan step 3).
   */
  rememberSessionFile(sessionFile: string): void;
  shutdown(): Promise<void>;
}

export interface HostSupervisorOptions {
  nodePath: string;
  hostPath: string;
  binDir: string;
  logDir: string;
  blobDir: string;
  /**
   * Where a host copies files before rewriting them (plan step 12). Optional so
   * a supervisor without a userData path still spawns hosts; settings writes
   * then simply skip the backup.
   */
  backupDir?: string;
  /**
   * Absolute path to the bundled npm CLI (`npm-cli.js`), passed to hosts as
   * `PI_DESKTOP_NPM_CLI` so package operations use the app's runtime and work
   * even when `npm` is absent from PATH (plan step 14).
   */
  npmCliPath?: string;
  /** Base environment (the process env of the app). */
  env?: Record<string, string | undefined>;
  profileDir: string;
  spawner?: HostSpawner;
  fs?: FsPort;
  now?: () => number;
  requestTimeoutMs?: number;
  maxHosts?: number;
  idleTimeoutMs?: number;
  maxRestarts?: number;
  /**
   * Recycle an idle host whose RSS reaches this (plan step 24). Defaults to
   * `HOST_RSS_RESTART_BYTES`; `0` disables the threshold.
   */
  maxRssBytes?: number;
  /** How often to poll `host.metrics`; `0` disables polling (tests). */
  memoryPollMs?: number;
  /**
   * Minimum time between memory-triggered restarts of the same host, so a host
   * whose RSS does not drop cannot restart in a loop (plan step 24).
   */
  memoryRestartCooldownMs?: number;
  /**
   * Safe mode (plan step 22): passed to every child as `PI_DESKTOP_SAFE_MODE` so
   * the host loads no third-party resources and refuses package changes.
   */
  safeMode?: boolean;
  /**
   * Pi's install telemetry (plan step 23). Evaluated at each spawn and passed as
   * `PI_TELEMETRY`, so it can follow a live preference change without restarting
   * the app. Defaults to **off**: a host that was not explicitly opted in sends
   * no install/attribution ping. A boolean or a getter are both accepted.
   */
  telemetryEnabled?: boolean | (() => boolean);
}

export interface HostSupervisor {
  start(spec: HostSpawnSpec): Promise<HostHandle>;
  get(sessionId: string): HostHandle | undefined;
  list(): HostHandle[];
  stop(sessionId: string): Promise<void>;
  stopAll(): Promise<void>;
  /** Ports currently owned by hosts. */
  allocatedPorts(): number[];
  /** Used/limit of the running host cap, for the UI's backpressure message. */
  capacity(): Capacity;
}

export const OFFICE_BRIDGE_PORT = 38617;
export const FIRST_GENERAL_PORT = 38618;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_HOSTS = MAX_HOSTS;
export const DEFAULT_IDLE_TIMEOUT_MS = IDLE_HOST_TIMEOUT_MS;
export const DEFAULT_METRICS_POLL_MS = 15_000;
export const DEFAULT_MEMORY_RESTART_COOLDOWN_MS = 5 * 60_000;
export const RESTART_BACKOFF_MS = [0, 500, 2_000] as const;

interface Pending {
  method: HostMethod;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Timeout on a host that never answers (e.g. a wedged SDK call). */
export class HostTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`host request "${method}" timed out after ${timeoutMs} ms`);
  }
}

/**
 * The host cap was hit. Carries a stable `code` so IPC can map it to the
 * backpressure sentence instead of matching prose (plan step 24).
 */
export class HostLimitError extends Error {
  readonly code = "host_limit";

  constructor(limit: number) {
    super(
      `host limit reached (${limit}); close a session tab first. ${capacityMessage("hosts", limit)}`,
    );
    this.name = "HostLimitError";
  }
}

export function createHostSupervisor(options: HostSupervisorOptions): HostSupervisor {
  const fs = options.fs ?? createNodeFsPort();
  const spawner = options.spawner ?? defaultSpawner;
  const now = options.now ?? ((): number => Date.now());
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxHosts = options.maxHosts ?? DEFAULT_MAX_HOSTS;
  const maxRestarts = options.maxRestarts ?? RESTART_BACKOFF_MS.length;
  const hosts = new Map<string, SupervisorHost>();
  const ports = new Set<number>();

  const allocatePort = (office: boolean): number => {
    if (office) {
      ports.add(OFFICE_BRIDGE_PORT);
      return OFFICE_BRIDGE_PORT;
    }
    let port = FIRST_GENERAL_PORT;
    while (ports.has(port)) port += 1;
    ports.add(port);
    return port;
  };

  class SupervisorHost implements HostHandle {
    readonly sessionId: string;
    readonly port: number;
    readonly officeHost: boolean;
    private spec: HostSpawnSpec;
    private child: SpawnedHostProcess | null = null;
    private state: HostStatus = "starting";
    private readonly emitter = new EventEmitter();
    private readonly pending = new Map<number, Pending>();
    private readonly decoder = new JsonlFrameDecoder();
    private nextId = 1;
    private restarts = 0;
    private restartTimer: ReturnType<typeof setTimeout> | null = null;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private memoryTimer: ReturnType<typeof setInterval> | null = null;
    private memoryInFlight = false;
    private lastMemory: HostMemoryMetrics | null = null;
    private memoryRestartBlockedUntil = 0;
    private lastActivityAt: number;
    private intentionalStop = false;
    private logBuffer: string[] = [];
    private lastInfo: HostInfo | null = null;
    private readyResolve: ((info: HostInfo) => void) | null = null;
    private readyReject: ((error: Error) => void) | null = null;
    private readonly readyPromise: Promise<HostInfo>;

    constructor(
      spec: HostSpawnSpec,
      port: number,
      private readonly onIdle?: () => void,
    ) {
      this.spec = spec;
      this.sessionId = spec.sessionId;
      this.port = port;
      this.officeHost = spec.officeHost ?? false;
      this.lastActivityAt = now();
      this.readyPromise = new Promise<HostInfo>((resolve, reject) => {
        this.readyResolve = resolve;
        this.readyReject = reject;
      });
    }

    ready(): Promise<HostInfo> {
      return this.readyPromise;
    }

    status(): HostStatus {
      return this.state;
    }

    info(): HostInfo | null {
      return this.lastInfo;
    }

    metrics(): HostMemoryMetrics | null {
      return this.lastMemory;
    }

    /** Any real traffic postpones idle recycling (plan step 24). */
    private touch(): void {
      this.lastActivityAt = now();
    }

    logs(): string[] {
      return [...this.logBuffer];
    }

    on(event: string, listener: HostEventListener): () => void {
      this.emitter.on(event, listener);
      return () => {
        this.emitter.off(event, listener);
      };
    }

    private handleFrames(): void {
      const stdout = this.child?.stdout;
      if (!stdout) return;
      stdout.on("data", (chunk: Buffer | string) => {
        const { frames, overflow } = this.decoder.push(chunk.toString());
        if (overflow) {
          this.appendLog("error", "frame exceeded the size limit; the host is misbehaving");
          this.state = "failed";
          this.emitter.emit("status", "failed");
        }
        for (const frame of frames) {
          if (isResponseFrame(frame)) {
            const pending = this.pending.get(frame.id);
            if (!pending) continue;
            this.pending.delete(frame.id);
            if (pending.timer) clearTimeout(pending.timer);
            if (frame.ok) pending.resolve(frame.result);
            else {
              const error = new Error(frame.error.message);
              error.name = frame.error.code ?? "host_error";
              pending.reject(error);
            }
            continue;
          }
          if (isEventFrame(frame)) {
            // An event means the session is doing work: never recycle it mid-flow.
            this.touch();
            const event: HostEvent = {
              event: frame.event,
              ...(frame.sessionId ? { sessionId: frame.sessionId } : {}),
              ...(frame.payload !== undefined ? { payload: frame.payload } : {}),
            };
            this.emitter.emit(frame.event, event.payload);
            this.emitter.emit("event", event);
          }
        }
      });
    }

    private appendLog(level: "info" | "error", message: string): void {
      const line = `${new Date(now()).toISOString()}  ${level.padEnd(5)}  ${message}\n`;
      this.logBuffer.push(line);
      void fs.writeTextFile(join(options.logDir, `${this.sessionId}.log`), this.logBuffer.join(""));
    }

    private captureStderr(): void {
      this.child?.stderr?.on("data", (chunk: Buffer | string) => {
        const text = chunk.toString().trim();
        if (text.length > 0) this.appendLog("error", text.replace(/\s+/g, " ").slice(0, 800));
      });
    }

    private spawnChild(): void {
      this.stopMetricsPolling();
      const telemetry =
        typeof options.telemetryEnabled === "function"
          ? options.telemetryEnabled()
          : options.telemetryEnabled === true;
      const env: Record<string, string | undefined> = {
        ...(options.env ?? process.env),
        [SESSION_ID_ENV]: this.sessionId,
        [HOST_ROLE_ENV]: this.spec.role ?? "session",
        [SAFE_MODE_ENV]: options.safeMode ? "1" : "0",
        [TELEMETRY_ENV]: telemetry ? "1" : "0",
        [BLOB_DIR_ENV]: options.blobDir,
        [SERVICE_ENV]: "service",
        PI_CODING_AGENT_DIR: options.profileDir,
        PI_OFFICE_BRIDGE_PORT: String(this.port),
      };
      const basePath = env.PATH ?? env.Path ?? "";
      env.PATH =
        basePath.length > 0
          ? `${options.binDir}${process.platform === "win32" ? ";" : ":"}${basePath}`
          : options.binDir;
      env[NODE_BIN_ENV] = options.nodePath;
      env.PI_DESKTOP_HOST_ENTRY = options.hostPath;
      if (options.npmCliPath) env[NPM_CLI_ENV] = options.npmCliPath;
      if (options.backupDir) env[BACKUP_DIR_ENV] = options.backupDir;

      const args = [
        options.hostPath,
        SERVICE_FLAG,
        "--session",
        this.sessionId,
        "--cwd",
        this.spec.cwd,
        "--port",
        String(this.port),
        ...(this.spec.args ?? []),
      ];
      const child = spawner(options.nodePath, args, { cwd: this.spec.cwd, env, windowsHide: true });
      this.child = child;

      this.appendLog(
        "info",
        `spawned ${basename(options.nodePath)} ${args.join(" ")} (pid ${child.pid ?? "?"})`,
      );

      child.on("exit", (code: unknown, signal: unknown) => {
        this.handleExit(Number(code ?? -1), String(signal ?? ""));
      });
      child.on("error", (error: unknown) => {
        this.appendLog(
          "error",
          `spawn error: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      this.handleFrames();
      this.captureStderr();
    }

    private handleExit(code: number, signal: string): void {
      const wasIntentional = this.intentionalStop;
      this.child = null;
      for (const [id, pending] of this.pending) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(
          new Error(
            `host exited (code ${code}${signal ? `, signal ${signal}` : ""}) during "${pending.method}"`,
          ),
        );
        this.pending.delete(id);
      }
      if (wasIntentional) {
        this.state = "stopped";
        this.emitter.emit("status", "stopped");
        return;
      }

      this.appendLog(
        "error",
        `host exited unexpectedly (code ${code}${signal ? `, signal ${signal}` : ""})`,
      );
      this.emitter.emit("crashed", { code, signal, sessionId: this.sessionId });

      if (this.restarts >= maxRestarts) {
        this.state = "failed";
        this.emitter.emit("status", "failed");
        this.readyReject?.(
          new Error(`host for ${this.sessionId} crashed ${this.restarts + 1} times; giving up`),
        );
        return;
      }

      const delay = RESTART_BACKOFF_MS[Math.min(this.restarts, RESTART_BACKOFF_MS.length - 1)] ?? 0;
      this.restarts += 1;
      this.state = "restarting";
      this.emitter.emit("status", "restarting");
      this.restartTimer = setTimeout(() => {
        void this.restart("crash");
      }, delay);
      if (
        typeof this.restartTimer === "object" &&
        this.restartTimer &&
        "unref" in this.restartTimer
      )
        this.restartTimer.unref();
    }

    /** Restarts the process and, when a session file is known, resumes it. */
    async restart(reason: string = "manual"): Promise<HostInfo> {
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }
      this.state = "restarting";
      this.emitter.emit("status", "restarting");
      this.spawnChild();
      const info = await this.handshake();
      this.appendLog("info", `host restarted (${reason}) pid ${info.pids.pid}`);
      if (this.spec.sessionFile) {
        try {
          await this.request("session.resume", { sessionFile: this.spec.sessionFile });
          this.appendLog("info", `resumed session ${this.spec.sessionFile}`);
          this.emitter.emit("resumed", { sessionFile: this.spec.sessionFile });
        } catch (error) {
          this.appendLog(
            "error",
            `could not resume ${this.spec.sessionFile}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return info;
    }

    /** Sends `host.hello` and resolves with the host's identity. */
    private async handshake(): Promise<HostInfo> {
      const info = (await this.request(
        "host.hello",
        {},
        { timeoutMs: requestTimeoutMs },
      )) as HostInfo;
      if (info.protocolVersion !== HOST_PROTOCOL_VERSION) {
        this.appendLog(
          "error",
          `protocol mismatch: host speaks v${info.protocolVersion}, app speaks v${HOST_PROTOCOL_VERSION}`,
        );
      }
      this.lastInfo = info;
      this.state = "ready";
      this.emitter.emit("status", "ready");
      this.readyResolve?.(info);
      this.scheduleIdleCheck();
      this.startMetricsPolling();
      return info;
    }

    rememberSessionFile(sessionFile: string): void {
      this.spec = { ...this.spec, sessionFile };
    }

    private scheduleIdleCheck(): void {
      const idleTimeoutMs = options.idleTimeoutMs;
      if (!idleTimeoutMs || idleTimeoutMs <= 0 || this.officeHost) return;
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        const since = now() - this.lastActivityAt;
        // Recycle only when nothing is in flight and the host has had no real
        // traffic for the whole window. The session service sees the `stopped`
        // status, drops its stale handle and re-spawns on the next activation.
        if (this.pending.size === 0 && since >= idleTimeoutMs) {
          this.appendLog("info", `recycling idle host after ${Math.round(since / 1000)} s`);
          this.onIdle?.();
          return;
        }
        this.scheduleIdleCheck();
      }, idleTimeoutMs);
      if (typeof this.idleTimer === "object" && this.idleTimer && "unref" in this.idleTimer)
        this.idleTimer.unref();
    }

    /** Polls `host.metrics` for the Diagnostics RSS readout and the restart cap. */
    private startMetricsPolling(): void {
      const intervalMs = options.memoryPollMs ?? DEFAULT_METRICS_POLL_MS;
      if (!intervalMs || intervalMs <= 0) return;
      if (this.memoryTimer) clearInterval(this.memoryTimer);
      void this.pollMetrics();
      this.memoryTimer = setInterval(() => void this.pollMetrics(), intervalMs);
      if (typeof this.memoryTimer === "object" && this.memoryTimer && "unref" in this.memoryTimer)
        this.memoryTimer.unref();
    }

    private stopMetricsPolling(): void {
      if (this.memoryTimer) clearInterval(this.memoryTimer);
      this.memoryTimer = null;
      this.memoryInFlight = false;
    }

    private async pollMetrics(): Promise<void> {
      if (this.memoryInFlight || this.state !== "ready" || !this.child) return;
      this.memoryInFlight = true;
      try {
        const sample = (await this.request("host.metrics", {}, { timeoutMs: 5_000 })) as
          HostMemoryMetrics | undefined;
        if (!sample || typeof sample.rssBytes !== "number" || !Number.isFinite(sample.rssBytes)) {
          return;
        }
        this.lastMemory = sample;
        const threshold = options.maxRssBytes ?? HOST_RSS_RESTART_BYTES;
        // `pending` is empty here (the metrics response was just consumed), so a
        // host with an in-flight user request is never restarted under the user.
        if (threshold > 0 && shouldRestartForMemory(sample, threshold) && this.pending.size === 0) {
          if (now() < this.memoryRestartBlockedUntil) return;
          const cooldown = options.memoryRestartCooldownMs ?? DEFAULT_MEMORY_RESTART_COOLDOWN_MS;
          this.memoryRestartBlockedUntil = now() + cooldown;
          const mb = (bytes: number): number => Math.round(bytes / (1024 * 1024));
          this.appendLog(
            "info",
            `recycling host: RSS ${mb(sample.rssBytes)} MB is over the ${mb(threshold)} MB threshold`,
          );
          void this.restart("memory");
        }
      } catch {
        // A metrics poll is best effort; a failure is not a host failure.
      } finally {
        this.memoryInFlight = false;
      }
    }

    async start(): Promise<HostInfo> {
      this.spawnChild();
      return this.handshake();
    }

    request(
      method: HostMethod,
      params?: unknown,
      requestOptions: { timeoutMs?: number } = {},
    ): Promise<unknown> {
      const child = this.child;
      if (!child) return Promise.reject(new Error(`host for ${this.sessionId} is not running`));
      const id = this.nextId++;
      const timeoutMs = requestOptions.timeoutMs ?? requestTimeoutMs;
      const frame: HostRequestFrame = { id, method, ...(params === undefined ? {} : { params }) };
      // A metrics poll must not count as activity, or an idle host would never
      // be recycled (plan step 24).
      if (method !== "host.metrics") this.touch();

      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          // Surface the wedge as an event, not just a rejected request: the
          // renderer shows a "host stopped responding" incident and can restart
          // the tab (plan step 22).
          this.appendLog("error", `request "${method}" timed out after ${timeoutMs} ms`);
          this.emitter.emit("timeout", {
            method,
            timeoutMs,
            sessionId: this.sessionId,
          });
          reject(new HostTimeoutError(method, timeoutMs));
        }, timeoutMs);
        if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
        this.pending.set(id, { method, resolve, reject, timer });
        child.stdin.write(encodeFrame(frame));
      });
    }

    async shutdown(): Promise<void> {
      this.intentionalStop = true;
      if (this.idleTimer) clearTimeout(this.idleTimer);
      if (this.restartTimer) clearTimeout(this.restartTimer);
      const child = this.child;
      if (!child) {
        this.state = "stopped";
        return;
      }
      try {
        await this.request("host.shutdown", {}, { timeoutMs: 2_000 });
      } catch {
        // Fall through to a hard kill.
      }
      child.kill("SIGTERM");
      this.state = "stopped";
      this.emitter.emit("status", "stopped");
    }

    disposeHere(): void {
      this.emitter.removeAllListeners();
    }
  }

  const stopHost = async (sessionId: string): Promise<void> => {
    const host = hosts.get(sessionId);
    if (!host) return;
    await host.shutdown();
    hosts.delete(sessionId);
    ports.delete(host.port);
    host.disposeHere();
  };

  return {
    async start(spec: HostSpawnSpec): Promise<HostHandle> {
      if (hosts.size >= maxHosts) throw new HostLimitError(maxHosts);
      const port = allocatePort(spec.officeHost ?? false);
      const host = new SupervisorHost(spec, port, () => void stopHost(spec.sessionId));
      hosts.set(spec.sessionId, host);
      try {
        await host.start();
      } catch (error) {
        hosts.delete(spec.sessionId);
        ports.delete(port);
        throw error;
      }
      return host;
    },
    get: (sessionId) => hosts.get(sessionId),
    list: () => [...hosts.values()],
    allocatedPorts: () => [...ports],
    capacity: () => capacity(hosts.size, maxHosts),
    stop: stopHost,
    async stopAll() {
      await Promise.all([...hosts.keys()].map((sessionId) => stopHost(sessionId)));
    },
  };
}

const defaultSpawner: HostSpawner = (command, args, spawnOptions) =>
  // SAFETY: child_process.spawn returns a ChildProcess, which satisfies
  // SpawnedHostProcess structurally (pid/stdin/stdout/stderr/on/kill). The
  // interface exists so tests can substitute a fake host process.
  nodeSpawn(command, [...args], {
    cwd: spawnOptions.cwd,
    env: spawnOptions.env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: spawnOptions.windowsHide ?? true,
  }) as unknown as SpawnedHostProcess;
