/**
 * Main-side supervisor for the terminal host (2026-11-05 terminal plan, step 5).
 *
 * One terminal host per window multiplexes every PTY in that window. It is
 * deliberately **not** `HostSupervisor`: a terminal host needs no Office port,
 * no idle recycling, no RSS restart and no host-process ceiling — and silently
 * respawning a shell would be worse than showing "terminal exited".
 *
 * What it does own: spawning the bundled Node with the shim PATH, JSONL request
 * correlation with timeouts, event forwarding, crash detection and a shutdown
 * that ends stdin (the host kills its PTYs) before force-killing the process.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { JsonlDecoder } from "../shared/jsonl";
import {
  MAX_TERMINAL_FRAME_BYTES,
  decodeTerminalFrame,
  encodeTerminalFrame,
  type TerminalErrorCode,
  type TerminalEventFrame,
  type TerminalFrame,
  type TerminalMethod,
} from "../shared/terminal-protocol";
import { composeChildEnv } from "./runtime/child-env";

/** Production spawner; tests inject a fake `ChildProcess` built on PassThrough. */
export type TerminalHostSpawner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; windowsHide?: boolean },
) => ChildProcess;

const defaultSpawner: TerminalHostSpawner = (command, args, options) =>
  nodeSpawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: options.windowsHide ?? true,
  });

/** A typed error response from the host, preserved across the RPC boundary. */
export class TerminalHostRpcError extends Error {
  readonly code: TerminalErrorCode;

  constructor(code: TerminalErrorCode, message: string) {
    super(message);
    this.name = "TerminalHostRpcError";
    this.code = code;
  }
}

export interface TerminalHostExitInfo {
  code: number;
  signal: string;
  /** False for a crash, true for a shutdown this supervisor initiated. */
  expected: boolean;
}

export interface TerminalHostOptions {
  nodePath: string;
  /** `out/host/terminal.mjs` (dev or `app.asar.unpacked`). */
  hostPath: string;
  cwd: string;
  profileDir: string;
  binDir: string;
  nodeBinDir?: string | null;
  env?: Record<string, string | undefined>;
  spawner?: TerminalHostSpawner;
  requestTimeoutMs?: number;
  /** Diagnostics sink; the supervisor never writes to the console itself. */
  log?: (line: string) => void;
  onEvent: (frame: TerminalEventFrame) => void;
  onExit?: (info: TerminalHostExitInfo) => void;
}

interface PendingRequest {
  method: TerminalMethod;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class TerminalHost {
  private child: ChildProcess | null = null;
  private decoder = new JsonlDecoder<TerminalFrame>(decodeTerminalFrame, MAX_TERMINAL_FRAME_BYTES);
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private stopping = false;
  private readonly spawner: TerminalHostSpawner;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: TerminalHostOptions) {
    this.spawner = options.spawner ?? defaultSpawner;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  /** True while a child process exists (it may still be starting). */
  get running(): boolean {
    return this.child !== null;
  }

  /**
   * Sends one request. The child is spawned lazily, and a crash is not hidden:
   * the next request starts a fresh host, but no shell is ever respawned without
   * a user action.
   */
  request<T>(method: TerminalMethod, params?: unknown): Promise<T> {
    if (this.stopping) {
      return Promise.reject(new Error("the terminal host is shutting down"));
    }
    try {
      this.ensureStarted();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const child = this.child;
    if (!child?.stdin) {
      return Promise.reject(new Error("the terminal host has no stdin"));
    }

    const id = this.nextId;
    this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`terminal host request timed out: ${method}`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        child.stdin?.write(encodeTerminalFrame({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Ends stdin so the host kills every PTY itself, waits up to 2 s, then
   * force-kills. Resolves exactly once; safe to call with no child.
   */
  async dispose(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    this.rejectPending("the terminal host is shutting down");
    if (!child) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
        finish();
      }, 2000);
      timer.unref?.();
      child.once("exit", finish);
      try {
        child.stdin?.end();
      } catch {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
        finish();
      }
    });
  }

  private ensureStarted(): void {
    if (this.child) return;

    const env = composeChildEnv({
      baseEnv: this.options.env ?? process.env,
      platform: process.platform,
      binDir: this.options.binDir,
      nodeBinDir: this.options.nodeBinDir ?? null,
      extra: {
        // So `pi` run inside a terminal uses the same profile as the app.
        PI_CODING_AGENT_DIR: this.options.profileDir,
        PI_DESKTOP_TERMINAL_HOST: "1",
        TERM_PROGRAM: "PiDesktop",
      },
      // Electron sets this when it re-executes itself as Node; a shell must not
      // inherit it.
      strip: ["ELECTRON_RUN_AS_NODE"],
    });

    const child = this.spawner(this.options.nodePath, [this.options.hostPath], {
      cwd: this.options.cwd,
      env,
      windowsHide: true,
    });
    this.child = child;
    this.decoder = new JsonlDecoder<TerminalFrame>(decodeTerminalFrame, MAX_TERMINAL_FRAME_BYTES);
    this.options.log?.(`spawned terminal host ${this.options.hostPath} (pid ${child.pid ?? "?"})`);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string | Buffer) => this.ingest(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString().trim();
      if (text.length > 0) this.options.log?.(`terminal host stderr: ${text.slice(0, 800)}`);
    });
    child.on("error", (error: Error) => {
      this.options.log?.(`terminal host error: ${error.message}`);
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.handleExit(child, code, signal);
    });
  }

  private ingest(chunk: string): void {
    const { frames, overflow } = this.decoder.push(chunk);
    if (overflow) this.options.log?.("terminal host frame overflow; input dropped");
    for (const frame of frames) this.handleFrame(frame);
  }

  private handleFrame(frame: TerminalFrame): void {
    if ("event" in frame) {
      this.options.onEvent(frame);
      return;
    }
    // A request on the host's stdout is a protocol violation; only a response
    // correlates with one of our pending ids.
    if ("method" in frame) return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.error) {
      pending.reject(new TerminalHostRpcError(frame.error.code, frame.error.message));
      return;
    }
    pending.resolve(frame.result);
  }

  private handleExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.child !== child) return;
    this.child = null;
    this.decoder.reset();
    const reason = code ?? signal ?? "unknown";
    this.rejectPending(`the terminal host exited (${reason})`);
    this.options.onExit?.({
      code: code ?? -1,
      signal: signal ?? "",
      expected: this.stopping,
    });
  }

  private rejectPending(reason: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${reason} during "${pending.method}"`));
    }
    this.pending.clear();
  }
}
