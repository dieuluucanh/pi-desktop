import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { basename, join } from "node:path";
import {
  BACKUP_DIR_ENV,
  BLOB_DIR_ENV,
  HOST_BUILD_ENV,
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
import { composeChildEnv } from "./runtime/child-env";
import { SESSION_ID_ENV, SERVICE_ENV, SERVICE_FLAG } from "../host/index";
import {
  HOST_MEMORY_GRACE_MS,
  HOST_RSS_OVER_BUDGET_SAMPLES,
  HOST_RSS_RESTART_BYTES,
  IDLE_HOST_TIMEOUT_MS,
  capacity,
  hostCeilingMessage,
  hostProcessCeiling,
  shouldRestartForMemory,
  type Capacity,
  type HostMemoryMetrics,
} from "../shared/performance";
import { isSessionBusyState, type TabStopReason } from "../shared/session-ipc";

/**
 * Supervises Pi host processes (plan step 4): one per session tab, spawned with
 * the bundled Node runtime, speaking JSONL over stdio.
 *
 * Responsibilities: request/response correlation with timeouts, per-host logs,
 * crash detection with backoff + `session.resume`, idle recycling, an emergency
 * host-process ceiling and port allocation (38617 is reserved for the Office
 * host, plan D10).
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
  /**
   * Session JSONL carried with the spawn for Diagnostics/compatibility. The
   * supervisor no longer resumes it itself: `session-service` owns the session
   * and reopens it after a process restart.
   */
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
  /**
   * Fingerprint of the bundle this host was spawned from. Optional: a host
   * started by an older main process never reports one.
   */
  buildId?: string | null;
  /**
   * Spawn → handshake duration in ms (2026-11-07 plan). Computed by the
   * supervisor (the host cannot see its own spawn), so it is absent until the
   * handshake completes.
   */
  bootMs?: number;
  /**
   * Optional host features (git-checkpoint plan step 24). Absent for a host
   * started by an older main, so every reader must treat it as "unknown, assume
   * no".
   */
  capabilities?: {
    /** True when the checkpoint extension is loaded (never in safe mode). */
    checkpointsExtension?: boolean;
    /** Which installed copy was found, or the bundled fallback. */
    checkpointExtensionSource?: "profile" | "package" | "bundled" | null;
  };
}

export interface HostEvent {
  event: string;
  sessionId?: string;
  /** Monotonic attachment counter; a reload keeps the id but bumps this. */
  sessionEpoch?: number;
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
  /**
   * Adds one line to that log. Optional so a test double stays small; the real
   * host uses it for service-level events ("retrying the open…") that only the
   * session service knows about.
   */
  note?(message: string): void;
  request(method: HostMethod, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
  on(event: string, listener: HostEventListener): () => void;
  /** True when the injected policy says this host must stay alive. */
  pinned(): boolean;
  /** True when the host is ready and has no request in flight. */
  isIdle(): boolean;
  /** Why the last shutdown stopped the host (idle/RSS/park/manual/restart). */
  stopReason?(): TabStopReason | null;
  /** True when a protected host is over the RSS budget but was not recycled. */
  overMemory?(): boolean;
  /** Crash auto-restarts in this process lifetime. */
  restartCount?(): number;
  /** The last restart reason (`crash`, `manual`, …). */
  lastRestartReason?(): string | null;
  restart(reason?: string): Promise<HostInfo>;
  shutdown(reason?: TabStopReason): Promise<void>;
}

export interface HostSupervisorOptions {
  nodePath: string;
  hostPath: string;
  binDir: string;
  /**
   * Directory containing the selected Node executable, or null when the runtime
   * was resolved from a bare command name. It goes on PATH after `binDir` so
   * `node` resolves to a real executable; `binDir` has no `node.cmd`.
   */
  nodeBinDir: string | null;
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
  /**
   * Fingerprint of the host bundle currently on disk. Called at every spawn and
   * passed to the child as `PI_DESKTOP_HOST_BUILD`, so a later comparison can
   * tell whether the running host predates a rebuild (2026-10-24 stale-host
   * plan). Absent in tests and when the bundle is unreadable.
   */
  hostBuildId?: () => string | null;
  profileDir: string;
  spawner?: HostSpawner;
  fs?: FsPort;
  now?: () => number;
  requestTimeoutMs?: number;
  /**
   * Log a completed request once it took at least this long, so a slow open or a
   * wedged SDK call is visible in `<logs>/<tab>.log` (2026-11-06 hang plan).
   * Defaults to {@link DEFAULT_SLOW_REQUEST_LOG_MS}; `0` logs every request and a
   * negative value disables the line.
   */
  slowRequestLogMs?: number;
  /** Rotate the per-session log after this many characters (0 disables). */
  maxLogFileChars?: number;
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
  /** Do not consider an RSS recycle before the host has lived this long. */
  memoryGraceMs?: number;
  /** Consecutive over-budget samples required before a background recycle. */
  memoryOverBudgetSamples?: number;
  /**
   * A session that must not be idle-recycled right now (the active tab, the
   * control host or the Office bridge owner). Evaluated at every idle tick, so a
   * bridge that moves between tabs pins the new owner without a restart.
   */
  isPinned?: (sessionId: string) => boolean;
  /**
   * The session hosting the on-demand Office bridge. Stopping it would drop port
   * 38617 and any attached pane, so it is exempt from both idle and RSS recycles.
   * The active/visible tab is protected by `isPinned`, not by this exemption.
   */
  isBridgeOwner?: (sessionId: string) => boolean;
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
  /** Used/limit of the memory-derived host-process ceiling (not a session limit). */
  capacity(): Capacity;
}

export const OFFICE_BRIDGE_PORT = 38617;
export const FIRST_GENERAL_PORT = 38618;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** A request slower than this is worth a line in the per-tab host log. */
export const DEFAULT_SLOW_REQUEST_LOG_MS = 2_000;
export const DEFAULT_MAX_HOSTS = hostProcessCeiling();
export const DEFAULT_IDLE_TIMEOUT_MS = IDLE_HOST_TIMEOUT_MS;
/**
 * Hosts are long-lived and their stderr is untrusted; keep the in-memory log
 * (and the file rewritten from it) bounded so a noisy host cannot grow main's
 * heap. The last lines are the useful ones for Diagnostics.
 */
export const MAX_HOST_LOG_LINES = 200;
export const MAX_HOST_LOG_CHARS = 64_000;
/**
 * One log segment before rotation. The file is appended to (never rewritten), so
 * a hang can be reconstructed; kept bounded by rotating once to `<id>.1.log`
 * (2026-11-06 plan, step 16).
 */
export const MAX_HOST_LOG_FILE_CHARS = 1_000_000;
/** Segments kept across spawns (`.1`–`.3`); a loop cannot fill the log dir. */
export const MAX_HOST_LOG_SEGMENTS = 3;
export const DEFAULT_METRICS_POLL_MS = 15_000;
export const RESTART_BACKOFF_MS = [0, 500, 2_000] as const;

interface Pending {
  method: HostMethod;
  /** The child this request was written to, so a replacement's work is never drained. */
  child: SpawnedHostProcess;
  /** When the frame was written, for the slow-request log line. */
  startedAt: number;
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
 * The host was stopped or replaced while the request was in flight.
 *
 * This is a *lifetime* answer, not a timeout: the child that would have answered
 * is gone, so waiting for it is pointless. Carries a stable `code` so the
 * session service can fail fast and retry instead of showing a 30 s hang.
 */
export class HostStoppedError extends Error {
  readonly code = "host_stopped";

  constructor(sessionId: string, method?: string) {
    super(
      method
        ? `host for ${sessionId} stopped during "${method}"`
        : `host for ${sessionId} was stopped`,
    );
    this.name = "host_stopped";
  }
}

/** The child is gone (or was never started); the request was never dispatched. */
export class HostNotRunningError extends Error {
  readonly code = "host_not_running";

  constructor(sessionId: string) {
    super(`host for ${sessionId} is not running`);
    this.name = "host_not_running";
  }
}

/**
 * A live host already exists for this `sessionId`.
 *
 * The supervisor keys its registry by session id, so a second start used to
 * overwrite the first handle: the child kept running (and kept its port) with
 * nothing in `list()`/`stopAll()`/`capacity()` able to reach it. That is how one
 * app launch ended up with seven control hosts under one map entry
 * (2026-11-07 host-singleton plan). The registry is now the single authority:
 * a caller that races gets this error instead of a silent orphan.
 *
 * A host whose status is `stopped` or `failed` is dead, not live: `start()`
 * stops and replaces it so a crashed session can still be reopened.
 */
export class HostAlreadyRunningError extends Error {
  readonly code = "host_already_running";

  constructor(sessionId: string, status: HostStatus) {
    super(`a host for ${sessionId} is already ${status}`);
    this.name = "HostAlreadyRunningError";
  }
}

/**
 * The emergency host-process ceiling was hit. Carries a stable `code` so IPC can
 * map it to the ceiling sentence instead of matching prose.
 */
export class HostLimitError extends Error {
  readonly code = "host_limit";

  constructor(limit: number) {
    super(hostCeilingMessage(limit));
    this.name = "HostLimitError";
  }
}

export function createHostSupervisor(options: HostSupervisorOptions): HostSupervisor {
  const fs = options.fs ?? createNodeFsPort();
  const spawner = options.spawner ?? defaultSpawner;
  const now = options.now ?? ((): number => Date.now());
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const slowRequestLogMs = options.slowRequestLogMs ?? DEFAULT_SLOW_REQUEST_LOG_MS;
  const maxLogFileChars = options.maxLogFileChars ?? MAX_HOST_LOG_FILE_CHARS;
  const maxHosts = options.maxHosts ?? DEFAULT_MAX_HOSTS;
  const maxRestarts = options.maxRestarts ?? RESTART_BACKOFF_MS.length;
  const memoryGraceMs = options.memoryGraceMs ?? HOST_MEMORY_GRACE_MS;
  const memoryOverBudgetSamples = Math.max(
    1,
    options.memoryOverBudgetSamples ?? HOST_RSS_OVER_BUDGET_SAMPLES,
  );
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
    private overBudgetSamples = 0;
    private overMemoryValue = false;
    private stopReasonValue: TabStopReason | null = null;
    private lastRestartReasonValue: string | null = null;
    private lastActivityAt: number;
    private intentionalStop = false;
    /** Set while the child is being stopped/replaced: every new request fails fast. */
    private stopping = false;
    private logBuffer: string[] = [];
    /** Serializes file writes, so a rotation cannot interleave with an append. */
    private logWrite: Promise<void> = Promise.resolve();
    /** Characters in the current log segment (rotation counter). */
    private logFileChars = 0;
    private lastInfo: HostInfo | null = null;
    /** When the current child was spawned, for the boot measurement. */
    private spawnedAt: number | null = null;
    private bootMsValue: number | null = null;
    private readyResolve: ((info: HostInfo) => void) | null = null;
    private readyReject: ((error: Error) => void) | null = null;
    /**
     * Whether `readyPromise` has settled. A host stopped before its handshake
     * must not leave `ready()` pending forever: the caller has no other signal
     * that the process it is waiting for will never arrive (2026-11-07 plan).
     */
    private readySettled = false;
    private readonly readyPromise: Promise<HostInfo>;

    constructor(
      spec: HostSpawnSpec,
      port: number,
      private readonly onIdle?: (reason: "idle" | "memory") => void,
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
      // `ready()` is optional (`start()` awaits the handshake instead), so a
      // rejection nobody asked for must not surface as an unhandled rejection.
      // Callers that do await it still get the rejection.
      void this.readyPromise.catch(() => undefined);
    }

    /** Settles the pending `ready()` with a rejection, at most once. */
    private rejectReady(error: Error): void {
      if (this.readySettled) return;
      this.readySettled = true;
      this.readyReject?.(error);
    }

    ready(): Promise<HostInfo> {
      return this.readyPromise;
    }

    status(): HostStatus {
      return this.state;
    }

    /** Ready and with no request in flight; a cheap first parkability filter. */
    isIdle(): boolean {
      return this.state === "ready" && this.pending.size === 0;
    }

    info(): HostInfo | null {
      if (!this.lastInfo) return null;
      return this.bootMsValue === null
        ? this.lastInfo
        : { ...this.lastInfo, bootMs: this.bootMsValue };
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
            this.logDuration(pending);
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
              ...(typeof frame.sessionEpoch === "number"
                ? { sessionEpoch: frame.sessionEpoch }
                : {}),
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
      while (this.logBuffer.length > MAX_HOST_LOG_LINES) this.logBuffer.shift();
      let chars = this.logBuffer.reduce((total, entry) => total + entry.length, 0);
      while (this.logBuffer.length > 1 && chars > MAX_HOST_LOG_CHARS) {
        const oldest = this.logBuffer[0];
        if (oldest === undefined) break;
        chars -= oldest.length;
        this.logBuffer.shift();
      }
      // Append instead of rewriting the bounded buffer: the in-memory tail is
      // for the Diagnostics view, the file is the record that survives a hang.
      this.logWrite = this.logWrite.then(() => this.writeLogLine(line)).catch(() => undefined);
    }

    /** The file half of {@link appendLog}: append, rotating one segment. */
    private async writeLogLine(line: string): Promise<void> {
      const target = this.logPath();
      if (maxLogFileChars > 0 && this.logFileChars + line.length > maxLogFileChars) {
        const previous = await fs.readTextFile(target);
        if (previous !== null && previous.length > 0) {
          await fs
            .writeTextFile(join(options.logDir, `${this.sessionId}.1.log`), previous)
            .catch(() => undefined);
        }
        this.logFileChars = 0;
        await fs.writeTextFile(target, "").catch(() => undefined);
      }
      this.logFileChars += line.length;
      await fs.appendTextFile(target, line);
    }

    /**
     * Shifts `<id>.log` to `<id>.1.log`, `.1`→`.2`, `.2`→`.3` before a new run.
     * One segment is dropped when the cap is reached.
     */
    private async rotateLogOnSpawn(): Promise<void> {
      const target = this.logPath();
      const segment = (index: number): string =>
        join(options.logDir, `${this.sessionId}.${index}.log`);
      const current = await fs.readTextFile(target);
      if (current === null || current.length === 0) {
        await fs.writeTextFile(target, "").catch(() => undefined);
        return;
      }
      await fs.remove(segment(MAX_HOST_LOG_SEGMENTS)).catch(() => undefined);
      for (let index = MAX_HOST_LOG_SEGMENTS - 1; index >= 1; index -= 1) {
        await fs.rename(segment(index), segment(index + 1)).catch(() => undefined);
      }
      await fs.rename(target, segment(1)).catch(async () => {
        // A platform/filesystem that refuses to replace: keep the bytes in the
        // segment instead of losing the run.
        await fs.writeTextFile(segment(1), current).catch(() => undefined);
      });
      await fs.writeTextFile(target, "").catch(() => undefined);
    }

    /** The log file this host is writing (Diagnostics and tests read it). */
    logPath(): string {
      return join(options.logDir, `${this.sessionId}.log`);
    }

    private captureStderr(): void {
      this.child?.stderr?.on("data", (chunk: Buffer | string) => {
        const text = chunk.toString().trim();
        if (text.length > 0) this.appendLog("error", text.replace(/\s+/g, " ").slice(0, 800));
      });
    }

    private spawnChild(): void {
      if (this.child) {
        // A second child for one session would share the port and the session
        // file. `restart()` terminates the old child before calling this.
        throw new Error(`host for ${this.sessionId} is already running`);
      }
      // A replacement is a live host again; only `shutdown()` keeps it stopped.
      this.stopping = false;
      this.spawnedAt = now();
      this.stopMetricsPolling();
      const telemetry =
        typeof options.telemetryEnabled === "function"
          ? options.telemetryEnabled()
          : options.telemetryEnabled === true;
      const env = composeChildEnv({
        baseEnv: options.env ?? process.env,
        platform: process.platform,
        binDir: options.binDir,
        nodeBinDir: options.nodeBinDir,
        extra: {
          [SESSION_ID_ENV]: this.sessionId,
          [HOST_ROLE_ENV]: this.spec.role ?? "session",
          [SAFE_MODE_ENV]: options.safeMode ? "1" : "0",
          [TELEMETRY_ENV]: telemetry ? "1" : "0",
          [BLOB_DIR_ENV]: options.blobDir,
          [SERVICE_ENV]: "service",
          PI_CODING_AGENT_DIR: options.profileDir,
          PI_OFFICE_BRIDGE_PORT: String(this.port),
        },
      });
      env[NODE_BIN_ENV] = options.nodePath;
      env.PI_DESKTOP_HOST_ENTRY = options.hostPath;
      const buildId = options.hostBuildId?.() ?? null;
      if (buildId) env[HOST_BUILD_ENV] = buildId;
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
      // Rotate, never truncate: a restart loop used to erase the very evidence
      // that explained it. Clear the in-memory tail and memory sample too, so
      // Diagnostics never mixes two processes.
      this.logBuffer.length = 0;
      this.lastMemory = null;
      this.overBudgetSamples = 0;
      this.overMemoryValue = false;
      this.logFileChars = 0;
      this.logWrite = this.logWrite.then(() => this.rotateLogOnSpawn()).catch(() => undefined);

      this.appendLog(
        "info",
        `spawned ${basename(options.nodePath)} ${args.join(" ")} (pid ${child.pid ?? "?"})`,
      );

      child.on("exit", (code: unknown, signal: unknown) => {
        this.handleExit(child, Number(code ?? -1), String(signal ?? ""));
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

    /** Rejects every in-flight request against the process being replaced. */
    private rejectPending(reason: string): void {
      this.drainPending((pending) => new Error(`${reason} during "${pending.method}"`));
    }

    /**
     * Fails in-flight requests, optionally only those written to one child.
     *
     * One drain point exists so a stop can never leave a request waiting for a
     * process that is already gone: that is exactly the 30 s "the session host
     * stopped responding" the user sees after a recycle or a restart.
     */
    private drainPending(
      error: (pending: Pending) => Error,
      match?: (pending: Pending) => boolean,
    ): Pending[] {
      const drained: Pending[] = [];
      for (const [id, pending] of this.pending) {
        if (match && !match(pending)) continue;
        if (pending.timer) clearTimeout(pending.timer);
        this.pending.delete(id);
        drained.push(pending);
        pending.reject(error(pending));
      }
      return drained;
    }

    /** Fails everything in flight because the host itself is going away. */
    private drainStopped(match?: (pending: Pending) => boolean): number {
      const drained = this.drainPending(
        (pending) => new HostStoppedError(this.sessionId, pending.method),
        match,
      );
      if (drained.length > 0) {
        const methods = [...new Set(drained.map((pending) => pending.method))];
        this.appendLog(
          "info",
          `stopped ${drained.length} in-flight request(s): ${methods.join(", ")}`,
        );
      }
      return drained.length;
    }

    /** One line when a request was slow enough to matter (`slowRequestLogMs`). */
    private logDuration(pending: Pending): void {
      if (slowRequestLogMs < 0) return;
      const elapsed = now() - pending.startedAt;
      if (elapsed < slowRequestLogMs) return;
      this.appendLog("info", `request "${pending.method}" took ${elapsed} ms`);
    }

    /** Service-level context (retry reasons) in the same per-tab log. */
    note(message: string): void {
      this.appendLog("info", message);
    }

    private handleExit(child: SpawnedHostProcess, code: number, signal: string): void {
      // A terminated/replaced child must never speak for the new one. Without
      // this, the old process's exit nulls `this.child` and emits `crashed` for
      // the replacement (the long-session restart corruption).
      if (this.child !== child) {
        this.appendLog(
          "error",
          `ignored exit from a superseded host (code ${code}${signal ? `, signal ${signal}` : ""})`,
        );
        return;
      }
      const wasIntentional = this.intentionalStop;
      this.child = null;
      this.rejectPending(`host exited (code ${code}${signal ? `, signal ${signal}` : ""})`);
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
        this.rejectReady(
          new Error(`host for ${this.sessionId} crashed ${this.restarts + 1} times; giving up`),
        );
        return;
      }

      const delay = RESTART_BACKOFF_MS[Math.min(this.restarts, RESTART_BACKOFF_MS.length - 1)] ?? 0;
      this.restarts += 1;
      this.state = "restarting";
      this.emitter.emit("status", "restarting");
      this.restartTimer = setTimeout(() => {
        // A shutdown that happened while the backoff was pending must win; do
        // not spawn a replacement for an intentionally stopped host
        // (plan step 27).
        if (this.intentionalStop) return;
        void this.restart("crash").catch((error: unknown) => {
          this.appendLog(
            "error",
            `restart failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          this.state = "failed";
          this.emitter.emit("status", "failed");
        });
      }, delay);
      if (
        typeof this.restartTimer === "object" &&
        this.restartTimer &&
        "unref" in this.restartTimer
      )
        this.restartTimer.unref();
    }

    /**
     * Stops the current child (if any), then starts a fresh process and
     * handshakes. It deliberately does **not** resume a session: the session
     * service owns the JSONL and reopens it after `status: ready`.
     */
    async restart(reason: string = "manual"): Promise<HostInfo> {
      this.lastRestartReasonValue = reason;
      // The crash backoff budget is per incident window, not per process
      // lifetime: without this reset, three crashes spread over a long session
      // permanently mark the host `failed` and every later restart is refused.
      // An automatic crash restart keeps the counter so the backoff still trips.
      if (reason !== "crash") this.restarts = 0;
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }
      // A queued restart that raced with `shutdown` must not spawn a process the
      // supervisor has already given up ownership of (plan step 27).
      if (this.intentionalStop) {
        throw new Error(`host ${this.sessionId} is shutting down`);
      }
      const previous = this.child;
      this.state = "restarting";
      this.emitter.emit("status", "restarting");
      if (previous) {
        await this.terminateChild(previous);
        this.rejectPending(`host restarted (${reason})`);
      }
      this.spawnChild();
      try {
        const info = await this.handshake();
        this.appendLog("info", `host restarted (${reason}) pid ${info.pids.pid}`);
        this.emitter.emit("restarted", { reason, sessionId: this.sessionId });
        return info;
      } catch (error) {
        // The replacement never became ready. Leaving it alive would make it an
        // invisible second host for this session (outside `hosts`, outside the
        // ceiling, holding a port), so stop it before propagating the failure.
        const child = this.child;
        this.rejectPending(`host restart failed (${reason})`);
        if (child) await this.terminateChild(child);
        this.state = "failed";
        this.emitter.emit("status", "failed");
        throw error;
      }
    }

    /**
     * Asks the child to shut down, then kills and waits for it. The child is
     * detached from `this.child` first, so its exit is treated as superseded.
     */
    private async terminateChild(child: SpawnedHostProcess): Promise<void> {
      if (this.child === child) this.child = null;
      // The child is being replaced or stopped: everything it was asked to do is
      // already lost. Fail it now (typed, so the caller can retry) instead of
      // letting each request sit until its own 30 s timer fires.
      this.drainStopped((pending) => pending.child === child);
      const exited = new Promise<void>((resolve) => {
        child.on("exit", () => resolve());
      });
      try {
        await this.requestOn(child, "host.shutdown", {}, 2_000);
      } catch {
        // Fall through to SIGTERM.
      }
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
      // A wedged child may never answer `host.shutdown`; that request is ours to
      // drain too, so no entry outlives the process it was written to.
      this.drainStopped((pending) => pending.child === child);
    }

    /** Sends one frame to a specific child (used while replacing the current one). */
    private requestOn(
      child: SpawnedHostProcess,
      method: HostMethod,
      params: unknown,
      timeoutMs: number,
    ): Promise<unknown> {
      const id = this.nextId++;
      const frame: HostRequestFrame = { id, method, ...(params === undefined ? {} : { params }) };
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new HostTimeoutError(method, timeoutMs));
        }, timeoutMs);
        if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
        this.pending.set(id, { method, child, startedAt: now(), resolve, reject, timer });
        child.stdin.write(encodeFrame(frame));
      });
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
      // Spawn → hello: the part of an open nobody can remove, only hide behind
      // a pre-warm. Reported so a slow cold boot is visible in Diagnostics.
      this.bootMsValue = this.spawnedAt === null ? null : Math.max(0, now() - this.spawnedAt);
      this.state = "ready";
      this.emitter.emit("status", "ready");
      this.readySettled = true;
      this.readyResolve?.(info);
      this.scheduleIdleCheck();
      this.startMetricsPolling();
      return info;
    }

    pinned(): boolean {
      try {
        return options.isPinned?.(this.sessionId) === true;
      } catch {
        // A broken predicate must not keep a host alive forever; fail open to
        // the existing recycle behaviour.
        return false;
      }
    }

    /** The bridge owner keeps port 38617; the RSS watchdog must never stop it. */
    private bridgeOwner(): boolean {
      try {
        return options.isBridgeOwner?.(this.sessionId) === true;
      } catch {
        return false;
      }
    }

    private scheduleIdleCheck(): void {
      const idleTimeoutMs = options.idleTimeoutMs;
      if (!idleTimeoutMs || idleTimeoutMs <= 0 || this.officeHost) return;
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => void this.checkIdle(idleTimeoutMs), idleTimeoutMs);
      if (typeof this.idleTimer === "object" && this.idleTimer && "unref" in this.idleTimer)
        this.idleTimer.unref();
    }

    /**
     * Recycles a host only after proving the session is not doing work. A long
     * tool call can run for more than the idle window without emitting an event,
     * so elapsed time alone is not evidence that the host is safe to stop.
     */
    private async checkIdle(idleTimeoutMs: number): Promise<void> {
      const since = now() - this.lastActivityAt;
      // Recycle only when nothing is in flight, the host has had no real
      // traffic for the whole window, and no live bridge is pinned to it. The
      // session service sees the `stopped` status, drops its stale handle and
      // re-spawns on the next activation.
      if (this.pending.size > 0 || since < idleTimeoutMs || this.pinned() || this.officeHost) {
        this.scheduleIdleCheck();
        return;
      }
      let busy: boolean;
      try {
        busy = isSessionBusyState(await this.request("state.get", undefined, { timeoutMs: 1_500 }));
      } catch {
        // A host that cannot answer the probe must not be killed from the idle
        // path; the user can restart it and the RSS watchdog still applies.
        busy = true;
      }
      if (busy) {
        this.appendLog("info", "keeping host alive: the session is still working");
        this.scheduleIdleCheck();
        return;
      }
      this.appendLog("info", `recycling idle host after ${Math.round(since / 1000)} s`);
      this.stopReasonValue = "idle";
      this.onIdle?.("idle");
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
        const over = threshold > 0 && shouldRestartForMemory(sample, threshold);
        if (!over) {
          this.overBudgetSamples = 0;
          this.overMemoryValue = false;
          return;
        }
        // A single 15 s spike is not a leak, and a cold host spends its first
        // seconds loading extensions/LSP caches. Require consecutive samples
        // and a grace window before a background recycle.
        this.overBudgetSamples += 1;
        if (this.overBudgetSamples < memoryOverBudgetSamples) return;
        const mb = (bytes: number): number => Math.round(bytes / (1024 * 1024));
        if (sample.uptimeMs < memoryGraceMs) {
          this.appendLog(
            "info",
            `RSS ${mb(sample.rssBytes)} MB is over the ${mb(threshold)} MB threshold; waiting out the startup grace period`,
          );
          return;
        }
        // Never recycle the Office bridge owner or the Office host: stopping
        // it would drop port 38617. The active/visible tab is protected for the
        // same reason an idle sleep would be surprising: the user is looking at
        // this session. Warn instead; the user owns the Restart action.
        if (this.officeHost || this.bridgeOwner() || this.pinned()) {
          if (!this.overMemoryValue) {
            this.overMemoryValue = true;
            this.appendLog(
              "info",
              `memory high: RSS ${mb(sample.rssBytes)} MB is over the ${mb(threshold)} MB threshold; the session is active, so it is not recycled`,
            );
          }
          return;
        }
        if (this.pending.size > 0) return;
        let busy: boolean;
        try {
          busy = isSessionBusyState(
            await this.request("state.get", undefined, { timeoutMs: 1_500 }),
          );
        } catch {
          busy = true;
        }
        if (busy) {
          this.appendLog("info", "keeping host alive: the session is still working");
          return;
        }
        this.overMemoryValue = false;
        this.appendLog(
          "info",
          `recycling host: RSS ${mb(sample.rssBytes)} MB is over the ${mb(threshold)} MB threshold`,
        );
        this.stopReasonValue = "memory";
        this.onIdle?.("memory");
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
      if (!child) return Promise.reject(new HostNotRunningError(this.sessionId));
      // A stopping host will never answer. Reject now, with the reason, rather
      // than arming a timer that fires 30 s after the process died.
      if (this.stopping) return Promise.reject(new HostStoppedError(this.sessionId, method));
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
        this.pending.set(id, { method, child, startedAt: now(), resolve, reject, timer });
        child.stdin.write(encodeFrame(frame));
      });
    }

    async shutdown(reason: TabStopReason = "manual"): Promise<void> {
      this.stopReasonValue = reason;
      this.intentionalStop = true;
      this.stopping = true;
      if (this.idleTimer) clearTimeout(this.idleTimer);
      if (this.restartTimer) clearTimeout(this.restartTimer);
      // The metrics interval is unref'd, but it must not keep asking a host that
      // is being stopped for its RSS (plan step 27).
      this.stopMetricsPolling();
      // Whatever a caller is waiting for, this host will never deliver it.
      this.rejectReady(new HostStoppedError(this.sessionId, "ready"));
      const child = this.child;
      if (!child) {
        this.state = "stopped";
        this.emitter.emit("status", "stopped");
        return;
      }
      // Nothing in flight can be answered any more. Fail it now: this is the
      // difference between an immediate, actionable error and a 30 s freeze
      // that looks like a wedged model.
      this.drainStopped();
      try {
        // `requestOn` (not `request`) because the host is already `stopping`.
        await this.requestOn(child, "host.shutdown", {}, 2_000);
      } catch {
        // Fall through to a hard kill.
      }
      // Wait for the process to actually exit before reporting `stopped`
      // (2026-10-30 project-scoped rail plan). The old shape answered
      // `host.shutdown`, sent SIGTERM and returned immediately, so a caller that
      // spawns a replacement (Office-host promotion) could race the dying child
      // for port 38617 — the "port is already in use" the user saw. Detaching the
      // child first makes its exit count as superseded, not as a crash.
      await this.terminateChild(child);
      this.state = "stopped";
      this.emitter.emit("status", "stopped");
    }

    stopReason(): TabStopReason | null {
      return this.stopReasonValue;
    }

    overMemory(): boolean {
      return this.overMemoryValue;
    }

    restartCount(): number {
      return this.restarts;
    }

    lastRestartReason(): string | null {
      return this.lastRestartReasonValue;
    }

    disposeHere(): void {
      this.stopMetricsPolling();
      this.emitter.removeAllListeners();
    }
  }

  const stopHost = async (sessionId: string, reason: TabStopReason = "manual"): Promise<void> => {
    const host = hosts.get(sessionId);
    if (!host) return;
    try {
      await host.shutdown(reason);
    } finally {
      // The entry and its port are the registry's only record of this child.
      // A rejected shutdown must not strand either: the child is either gone
      // or unkillable, and in both cases keeping the slot is worse.
      hosts.delete(sessionId);
      ports.delete(host.port);
      host.disposeHere();
    }
  };

  /** `stopped`/`failed` entries have no live child left to protect. */
  const isDeadStatus = (status: HostStatus): boolean => status === "stopped" || status === "failed";

  return {
    async start(spec: HostSpawnSpec): Promise<HostHandle> {
      // One child per session id. A live duplicate is refused *before* a port is
      // allocated or a process spawned, so a caller race cannot leak either. A
      // dead entry (stopped/failed) is replaced: that is how a crash-recovered
      // session reopens, and it must not hold a ceiling slot forever.
      const existing = hosts.get(spec.sessionId);
      if (existing) {
        const status = existing.status();
        if (!isDeadStatus(status)) throw new HostAlreadyRunningError(spec.sessionId, status);
        await stopHost(spec.sessionId);
      }
      if (hosts.size >= maxHosts) throw new HostLimitError(maxHosts);
      const port = allocatePort(spec.officeHost ?? false);
      const host = new SupervisorHost(
        spec,
        port,
        (reason) => void stopHost(spec.sessionId, reason),
      );
      hosts.set(spec.sessionId, host);
      try {
        await host.start();
      } catch (error) {
        hosts.delete(spec.sessionId);
        ports.delete(port);
        // `start()` spawns before it handshakes. A failed handshake (timeout,
        // protocol mismatch, slow cold start) would otherwise leave that child
        // running forever, outside the host map and the ceiling. Stop it and
        // dispose its listeners before reporting the failure.
        await host.shutdown().catch(() => undefined);
        host.disposeHere();
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
