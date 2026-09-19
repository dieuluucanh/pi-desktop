import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { basename, join } from "node:path";
import {
  BLOB_DIR_ENV,
  HOST_PROTOCOL_VERSION,
  HOST_ROLE_ENV,
  JsonlFrameDecoder,
  encodeFrame,
  isEventFrame,
  isResponseFrame,
  type HostMethod,
  type HostRequestFrame,
  type HostRole,
} from "../shared/host-protocol";
import { createNodeFsPort, type FsPort } from "./fs-port";
import { SESSION_ID_ENV, SERVICE_ENV, SERVICE_FLAG } from "../host/index";

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
}

export interface HostSupervisor {
  start(spec: HostSpawnSpec): Promise<HostHandle>;
  get(sessionId: string): HostHandle | undefined;
  list(): HostHandle[];
  stop(sessionId: string): Promise<void>;
  stopAll(): Promise<void>;
  /** Ports currently owned by hosts. */
  allocatedPorts(): number[];
}

export const OFFICE_BRIDGE_PORT = 38617;
export const FIRST_GENERAL_PORT = 38618;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_HOSTS = 8;
export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000;
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
    private intentionalStop = false;
    private logBuffer: string[] = [];
    private readyResolve: ((info: HostInfo) => void) | null = null;
    private readyReject: ((error: Error) => void) | null = null;
    private readonly readyPromise: Promise<HostInfo>;

    constructor(spec: HostSpawnSpec, port: number) {
      this.spec = spec;
      this.sessionId = spec.sessionId;
      this.port = port;
      this.officeHost = spec.officeHost ?? false;
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
      const env: Record<string, string | undefined> = {
        ...(options.env ?? process.env),
        [SESSION_ID_ENV]: this.sessionId,
        [HOST_ROLE_ENV]: this.spec.role ?? "session",
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
      env.PI_DESKTOP_NODE = options.nodePath;
      env.PI_DESKTOP_HOST_ENTRY = options.hostPath;

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
      this.state = "ready";
      this.emitter.emit("status", "ready");
      this.readyResolve?.(info);
      this.scheduleIdleCheck();
      return info;
    }

    rememberSessionFile(sessionFile: string): void {
      this.spec = { ...this.spec, sessionFile };
    }

    private scheduleIdleCheck(): void {
      const idleTimeoutMs = options.idleTimeoutMs;
      if (!idleTimeoutMs || this.officeHost) return;
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        const listeners = this.emitter.listenerCount("event");
        if (listeners === 0) {
          this.appendLog("info", `recycling idle host after ${idleTimeoutMs} ms`);
          void this.shutdown();
        }
      }, idleTimeoutMs);
      if (typeof this.idleTimer === "object" && this.idleTimer && "unref" in this.idleTimer)
        this.idleTimer.unref();
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

      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
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

  return {
    async start(spec: HostSpawnSpec): Promise<HostHandle> {
      if (hosts.size >= maxHosts) {
        throw new Error(`host limit reached (${maxHosts}); close a session tab first`);
      }
      const port = allocatePort(spec.officeHost ?? false);
      const host = new SupervisorHost(spec, port);
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
    async stop(sessionId) {
      const host = hosts.get(sessionId);
      if (!host) return;
      await host.shutdown();
      hosts.delete(sessionId);
      ports.delete(host.port);
      host.disposeHere();
    },
    async stopAll() {
      await Promise.all([...hosts.keys()].map((sessionId) => this.stop(sessionId)));
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
