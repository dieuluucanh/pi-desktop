/**
 * The terminal host entry (2026-11-05 native-terminal plan, step 4).
 *
 * A slim service loop, deliberately **not** `src/host/index.ts`: this process
 * must never load the Pi SDK, the extension runner, the TUI surface or an Office
 * port. It owns N PTYs for one window and speaks only the terminal frames from
 * `src/shared/terminal-protocol.ts` over stdin/stdout.
 *
 * Lifecycle: the parent (main's `TerminalHost`) owns the pipe. On stdin end,
 * SIGTERM or an uncaught error every PTY is killed before the process exits, so
 * closing the window cannot orphan a shell or a dev server.
 *
 * Native-module policy (2026-11-08 linux-terminal plan, step 1): `node-pty` is
 * loaded **lazily, on the first request**, through `loadNodePty()` — never at
 * module evaluation. A package whose `pty.node` cannot be dlopen'd (the 0.8.0
 * Linux build demanded `GLIBC_2.42`) must still answer `terminal.info` and
 * return a typed `native_unavailable` error for `terminal.open` instead of
 * exiting 1 before the request can be read.
 */

import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";
import { TerminalCore, TerminalCoreError, type PtyPort } from "./terminal-core";
import { createNodeTreeKill, loadNodePty, type NodePtyLoad } from "./pty-node";
import { JsonlDecoder } from "../shared/jsonl";
import {
  MAX_TERMINAL_FRAME_BYTES,
  TERMINAL_PROTOCOL_VERSION,
  decodeTerminalFrame,
  encodeTerminalFrame,
  isTerminalMethod,
  type TerminalFrame,
  type TerminalFrameError,
  type TerminalHostInfo,
  type TerminalRequestFrame,
  type TerminalResponseFrame,
  type TerminalSpawnSpec,
} from "../shared/terminal-protocol";

/** Splits stdin into frames and drops an oversized line instead of buffering it. */
export class TerminalLineReader {
  private readonly decoder: JsonlDecoder<string>;

  constructor(maxBytes: number = MAX_TERMINAL_FRAME_BYTES) {
    this.decoder = new JsonlDecoder<string>((line) => {
      if (line.length === 0) return null;
      return line.endsWith("\r") ? line.slice(0, -1) : line;
    }, maxBytes);
  }

  push(chunk: string): string[] {
    return this.decoder.push(chunk).frames;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string") {
    throw new TerminalCoreError(`${key} must be a string`, "bad_request");
  }
  return value;
}

function requireNumber(params: Record<string, unknown>, key: string): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TerminalCoreError(`${key} must be a number`, "bad_request");
  }
  return value;
}

function toFrameError(error: unknown): TerminalFrameError {
  if (error instanceof TerminalCoreError) return { code: error.code, message: error.message };
  return {
    code: "protocol",
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * The report used when a caller drives `dispatchTerminalRequest` with a bare
 * core (unit tests). The real host always passes the probed status.
 */
export function defaultHostInfo(): TerminalHostInfo {
  return {
    protocol: TERMINAL_PROTOCOL_VERSION,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    pty: { loaded: false, path: null, candidates: [], error: "not reported" },
  };
}

/**
 * Routes one validated frame to the core. Unknown methods and malformed params
 * become typed errors; nothing here throws into the read loop.
 */
export function dispatchTerminalRequest(
  core: TerminalCore,
  frame: TerminalRequestFrame,
  info: TerminalHostInfo = defaultHostInfo(),
): TerminalResponseFrame {
  if (!isTerminalMethod(frame.method)) {
    return {
      id: frame.id,
      error: { code: "bad_request", message: `unknown terminal method: ${frame.method}` },
    };
  }
  try {
    const params = asRecord(frame.params);
    switch (frame.method) {
      case "terminal.open":
        return { id: frame.id, result: core.open(params.spec as TerminalSpawnSpec) };
      case "terminal.attach":
        return { id: frame.id, result: core.attach(requireString(params, "terminalId")) };
      case "terminal.write":
        core.write(requireString(params, "terminalId"), requireString(params, "data"));
        return { id: frame.id, result: {} };
      case "terminal.resize":
        core.resize(
          requireString(params, "terminalId"),
          requireNumber(params, "cols"),
          requireNumber(params, "rows"),
        );
        return { id: frame.id, result: {} };
      case "terminal.ack":
        core.ack(requireString(params, "terminalId"), requireNumber(params, "bytes"));
        return { id: frame.id, result: {} };
      case "terminal.close":
        return {
          id: frame.id,
          result: {
            closed: core.close(requireString(params, "terminalId"), {
              force: params.force === true,
            }),
          },
        };
      case "terminal.list":
        return { id: frame.id, result: core.list() };
      case "terminal.info":
        return { id: frame.id, result: info };
      default:
        return {
          id: frame.id,
          error: { code: "bad_request", message: `unknown terminal method: ${frame.method}` },
        };
    }
  } catch (error) {
    return { id: frame.id, error: toFrameError(error) };
  }
}

/** What the service needs for one request: the core plus its native report. */
export interface TerminalHostRuntime {
  core: TerminalCore;
  info: TerminalHostInfo;
}

/**
 * A ready core (tests, fakes) or a factory that builds it on the first request.
 * The factory is how the real host keeps `node-pty` out of module evaluation.
 */
export type TerminalRuntimeSource =
  TerminalCore | (() => TerminalHostRuntime | Promise<TerminalHostRuntime>);

export interface TerminalHostServiceOptions {
  core: TerminalRuntimeSource;
  input: Readable;
  output: Writable;
  onError?: (error: unknown) => void;
}

export interface TerminalHostService {
  /** Removes listeners and kills every PTY; idempotent. */
  dispose(): void;
}

/** The transport half of the host, injectable so it is testable with streams. */
export function createTerminalHostService(
  options: TerminalHostServiceOptions,
): TerminalHostService {
  const { core, input, output, onError } = options;
  const reader = new TerminalLineReader();
  const plainCore = typeof core === "function" ? null : core;
  let disposed = false;
  let runtime: Promise<TerminalHostRuntime> | null = null;
  /** Requests are answered in arrival order even though the first may load. */
  let queue: Promise<void> = Promise.resolve();

  const write = (frame: TerminalFrame): void => {
    if (disposed) return;
    output.write(encodeTerminalFrame(frame));
  };

  const resolveRuntime = (): Promise<TerminalHostRuntime> => {
    if (runtime) return runtime;
    runtime =
      typeof core === "function"
        ? Promise.resolve().then(core)
        : Promise.resolve({ core, info: defaultHostInfo() });
    return runtime;
  };

  const handle = async (frame: TerminalRequestFrame): Promise<void> => {
    if (disposed) return;
    const resolved = await resolveRuntime();
    if (disposed) return;
    write(dispatchTerminalRequest(resolved.core, frame, resolved.info));
  };

  const fail = (frame: TerminalRequestFrame, error: unknown): void => {
    if (disposed) return;
    onError?.(error);
    write({ id: frame.id, error: toFrameError(error) });
  };

  const onData = (chunk: string | Buffer): void => {
    if (disposed) return;
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const line of reader.push(text)) {
      const frame = decodeTerminalFrame(line);
      // A response/event on the host's stdin is a protocol violation, not work.
      if (!frame || !("method" in frame)) continue;
      const request = frame as TerminalRequestFrame;
      // A ready core is answered synchronously (the unit tests and any caller
      // that owns the port); only the lazy loader needs the ordered queue, so
      // a request written immediately before `end` is never dropped.
      if (plainCore) {
        write(dispatchTerminalRequest(plainCore, request));
        continue;
      }
      queue = queue.then(() => handle(request)).catch((error) => fail(request, error));
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    input.off("data", onData);
    input.off("end", onEnd);
    input.off("error", onInputError);
    if (plainCore) {
      plainCore.dispose();
      return;
    }
    // A load that has not started must not be started just to dispose it.
    if (runtime) void runtime.then((resolved) => resolved.core.dispose()).catch(() => undefined);
  };

  const onEnd = (): void => {
    dispose();
  };

  const onInputError = (error: unknown): void => {
    onError?.(error);
    dispose();
  };

  input.setEncoding?.("utf8");
  input.on("data", onData);
  input.on("end", onEnd);
  input.on("error", onInputError);

  return { dispose };
}

/** Builds the core and its report from a native load result (never throws). */
export function createHostRuntime(
  load: NodePtyLoad,
  emit: (frame: TerminalFrame) => void,
): TerminalHostRuntime {
  const info: TerminalHostInfo = {
    protocol: TERMINAL_PROTOCOL_VERSION,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    pty: load.ok
      ? { loaded: true, path: load.path, candidates: [], error: null }
      : { loaded: false, path: null, candidates: load.candidates, error: load.error },
  };
  const pty: PtyPort = load.ok
    ? load.port
    : {
        spawn() {
          // The host is alive, so this becomes a typed frame error instead of
          // an exit-1 crash the supervisor can only report as "host exited".
          throw new TerminalCoreError(
            `node-pty could not be loaded: ${load.error}`,
            "native_unavailable",
          );
        },
      };
  return {
    core: new TerminalCore({
      pty,
      treeKill: createNodeTreeKill(),
      emit,
    }),
    info,
  };
}

/** Builds the real runtime (lazy `node-pty` + POSIX process-group / taskkill). */
export function runTerminalHost(): void {
  let disposed = false;

  const service = createTerminalHostService({
    core: async () =>
      createHostRuntime(await loadNodePty(), (frame) => {
        if (!disposed) process.stdout.write(encodeTerminalFrame(frame));
      }),
    input: process.stdin,
    output: process.stdout,
    onError: (error) => {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      process.stderr.write(`pi-desktop terminal host input error: ${detail}\n`);
    },
  });

  const shutdown = (code: number, detail?: string): void => {
    disposed = true;
    if (detail) process.stderr.write(`${detail}\n`);
    service.dispose();
    // Give the last frames a tick to flush before the process ends.
    setTimeout(() => process.exit(code), 10);
  };

  process.stdin.on("end", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));
  process.on("uncaughtException", (error) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    shutdown(1, `pi-desktop terminal host crashed: ${detail}`);
  });
  process.on("unhandledRejection", (reason) => {
    shutdown(1, `pi-desktop terminal host rejected: ${String(reason)}`);
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runTerminalHost();
}
