import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  BLOB_DIR_ENV,
  HOST_PROTOCOL_VERSION,
  JsonlFrameDecoder,
  encodeFrame,
  exceedsThreshold,
  isBlobRef,
  isHostMethod,
  type BlobRef,
  type HostErrorBody,
  type HostFrame,
  type HostMethod,
  type HostRequestFrame,
  type HostRole,
} from "../shared/host-protocol";
import { isPathInside } from "./path-guard";
import type { HostMemoryMetrics } from "../shared/performance";

/**
 * Host-side protocol service (plan step 4).
 *
 * Reads `HostRequest` frames from stdin, dispatches them to handlers and writes
 * `HostResponse`/`HostEvent` frames to stdout. Transport-level methods (hello,
 * ping, shutdown, blob reads) live here; the session methods are injected by
 * `src/host/session-core.ts` in plan step 5, and everything else answers with a
 * `not_implemented` error instead of silently hanging.
 */

export type HostHandler = (
  params: unknown,
  context: HostRequestContext,
) => Promise<unknown> | unknown;

export interface HostRequestContext {
  method: HostMethod;
  requestId: number;
  /** Emits an unsolicited event frame to the supervisor. */
  emit(event: string, payload?: unknown, sessionId?: string): void;
  /** Reads a previously spilled payload back from the blob cache. */
  readBlob(path: string): Promise<string | null>;
}

export interface HostServiceInfo {
  sessionId: string | null;
  cwd: string;
  bridgePort: number | null;
  nodeVersion: string;
  piVersion: string | null;
  startedAt: number;
  /** `control` hosts serve app-wide state and own no `AgentSession` (plan D-A3). */
  role?: HostRole;
}

export interface HostServiceOptions {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  blobDir: string;
  info: HostServiceInfo;
  handlers?: Partial<Record<HostMethod, HostHandler>>;
  /** Spills a payload to the blob cache and returns its reference. */
  writeBlob?: (name: string, contents: string) => Promise<string>;
  readBlob?: (path: string) => Promise<string | null>;
  /** Called after `host.shutdown` has been answered. */
  onShutdown?: () => void;
  /**
   * Samples this process's memory for `host.metrics` (plan step 24). Injectable
   * so tests assert on a fixed sample instead of the test runner's own RSS.
   */
  readMemory?: () => HostMemoryMetrics;
  maxFrameBytes?: number;
}

export interface HostService {
  /** Handles one already-received line (used by tests and by the stream loop). */
  handleLine(line: string): Promise<void>;
  /** Subscribes to stdin until it closes. */
  start(): void;
  stop(): void;
  /** Pushes an unsolicited event frame (session events, extension UI requests). */
  emit(event: string, payload?: unknown, sessionId?: string): void;
}

class HostError extends Error {
  readonly code: string;

  constructor(message: string, code = "host_error") {
    super(message);
    this.code = code;
  }
}

function toErrorBody(error: unknown): HostErrorBody {
  if (error instanceof HostError) return { message: error.message, code: error.code };
  if (error instanceof Error) {
    // Any error carrying a string `code` (provider/resource/package errors) keeps
    // it, so the renderer can branch on the cause instead of matching prose; an
    // optional `data` payload (e.g. the captured npm output) travels with it.
    const code = (error as { code?: unknown }).code;
    const data = (error as { data?: unknown }).data;
    return {
      message: error.message,
      ...(typeof code === "string" && code.length > 0 ? { code } : {}),
      ...(data !== undefined ? { data } : {}),
    };
  }
  return { message: String(error) };
}

export function createHostService(options: HostServiceOptions): HostService {
  const { stdin, stdout, blobDir } = options;
  const decoder = new JsonlFrameDecoder(options.maxFrameBytes);
  const handlers: Partial<Record<HostMethod, HostHandler>> = { ...options.handlers };
  let closed = false;

  const writeBlob =
    options.writeBlob ??
    (async (name: string, contents: string): Promise<string> => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const target = join(blobDir, name);
      await mkdir(blobDir, { recursive: true });
      await writeFile(target, contents, "utf8");
      return target;
    });

  const readBlob =
    options.readBlob ??
    (async (path: string): Promise<string | null> => {
      const { readFile } = await import("node:fs/promises");
      try {
        return await readFile(path, "utf8");
      } catch {
        return null;
      }
    });

  const send = (frame: HostFrame): void => {
    if (closed && !isBlobRef(frame)) {
      // Still allow the shutdown response through before the stream ends.
    }
    stdout.write(encodeFrame(frame));
  };

  /**
   * Emits an event, spilling any oversized field. Events are serialized through
   * a promise chain so a spill (or a large payload) can never reorder them
   * relative to one another (plan step 24).
   */
  let emitChain: Promise<void> = Promise.resolve();
  const emit = (event: string, payload?: unknown, sessionId?: string): void => {
    emitChain = emitChain
      .then(async () => {
        const spilled = await spillEvent(payload);
        send(sessionId ? { event, sessionId, payload: spilled } : { event, payload: spilled });
      })
      .catch(() => undefined);
  };

  const respond = (id: number, result: unknown): void => send({ id, ok: true, result });
  const fail = (id: number, error: unknown): void =>
    send({ id, ok: false, error: toErrorBody(error) });

  const writeBlobRef = async (value: unknown): Promise<BlobRef> => {
    const serialized = JSON.stringify(value) ?? "null";
    const path = await writeBlob(`${randomUUID()}.json`, serialized);
    return { $blob: path, bytes: Buffer.byteLength(serialized, "utf8") };
  };

  /** Replaces an oversized *response* with a single blob reference. */
  const spillResponse = async (value: unknown): Promise<unknown> => {
    return exceedsThreshold(value) ? writeBlobRef(value) : value;
  };

  /**
   * Spills an oversized *event payload* in place: a large nested field (a tool
   * result, a message body) is replaced by a BlobRef while the event keeps its
   * identity (`toolName`, `toolCallId`, …), so the renderer can still render the
   * card and fetch the body lazily via `host.blobs.read` (plan step 24).
   */
  const spillEvent = async (payload: unknown): Promise<unknown> => {
    if (!exceedsThreshold(payload)) return payload;
    if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
      const record = payload as Record<string, unknown>;
      const next: Record<string, unknown> = { ...record };
      let replaced = false;
      for (const key of Object.keys(record)) {
        if (exceedsThreshold(record[key])) {
          next[key] = await writeBlobRef(record[key]);
          replaced = true;
        }
      }
      if (replaced) return next;
    }
    return writeBlobRef(payload);
  };

  const contextFor = (request: HostRequestFrame, method: HostMethod): HostRequestContext => ({
    method,
    requestId: request.id,
    emit,
    readBlob,
  });

  handlers["host.ping"] = () => ({ pong: true, at: Date.now() });

  const readMemory =
    options.readMemory ??
    ((): HostMemoryMetrics => {
      const usage = process.memoryUsage();
      return {
        rssBytes: usage.rss,
        heapUsedBytes: usage.heapUsed,
        heapTotalBytes: usage.heapTotal,
        uptimeMs: Math.round(process.uptime() * 1_000),
        at: Date.now(),
      };
    });

  // The host is the only process that can read its own RSS without an
  // OS-specific query; the supervisor polls this for Diagnostics and the RSS
  // restart threshold (plan step 24).
  handlers["host.metrics"] = () => readMemory();

  handlers["host.hello"] = () => ({
    protocolVersion: HOST_PROTOCOL_VERSION,
    nodeVersion: options.info.nodeVersion,
    piVersion: options.info.piVersion,
    role: options.info.role ?? "session",
    sessionId: options.info.sessionId,
    cwd: options.info.cwd,
    bridgePort: options.info.bridgePort,
    pids: { pid: process.pid, ppid: process.ppid },
    env: { blobDir: blobDir || process.env[BLOB_DIR_ENV] || null },
    startedAt: options.info.startedAt,
  });

  handlers["host.blobs.read"] = async (
    params: unknown,
  ): Promise<{ path: string; contents: string | null }> => {
    const path = (params as { path?: unknown } | null)?.path;
    if (typeof path !== "string" || path.length === 0) {
      throw new HostError("host.blobs.read requires a path", "bad_request");
    }
    // A blob reference is a path the host itself spilled. The containment check
    // is lexical (the cache is app-owned, so a symlink cannot be planted there),
    // but it must be a *real* containment: `startsWith` also accepted a sibling
    // such as `…/blob-cache-evil/x`, and an unset blob dir accepted everything.
    if (blobDir.length === 0 || !isPathInside(blobDir, path)) {
      throw new HostError(`refusing to read outside the blob cache: ${path}`, "forbidden");
    }
    return { path, contents: await readBlob(path) };
  };

  handlers["host.shutdown"] = () => {
    options.onShutdown?.();
    return { ok: true };
  };

  const dispatch = async (request: HostRequestFrame): Promise<void> => {
    const { id, method } = request;
    if (!isHostMethod(method)) {
      fail(id, new HostError(`unknown method: ${method}`, "unknown_method"));
      return;
    }
    const handler = handlers[method];
    if (!handler) {
      fail(id, new HostError(`method not implemented yet: ${method}`, "not_implemented"));
      return;
    }
    try {
      const result = await handler(request.params, contextFor(request, method));
      // `host.blobs.read` is the escape hatch for oversized payloads, so its own
      // answer must never be spilled again.
      respond(id, method === "host.blobs.read" ? result : await spillResponse(result));
    } catch (error) {
      fail(id, error);
    }
  };

  return {
    async handleLine(line: string): Promise<void> {
      const { frames, overflow } = decoder.push(`${line}\n`);
      if (overflow) fail(0, new HostError("frame exceeded the size limit", "frame_too_large"));
      for (const frame of frames) {
        if ("method" in frame) await dispatch(frame as HostRequestFrame);
      }
    },

    start(): void {
      const onData = (chunk: Buffer | string): void => {
        const { frames, overflow } = decoder.push(chunk.toString());
        if (overflow) fail(0, new HostError("frame exceeded the size limit", "frame_too_large"));
        for (const frame of frames) {
          if (!("method" in frame)) continue;
          void dispatch(frame as HostRequestFrame);
        }
      };
      const onEnd = (): void => {
        closed = true;
      };
      stdin.on("data", onData);
      stdin.on("end", onEnd);
      stdin.on("close", onEnd);
      stdin.resume();
    },

    stop(): void {
      closed = true;
      stdin.pause();
    },

    emit,
  };
}
