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
} from "../shared/host-protocol";

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
  if (error instanceof Error) return { message: error.message };
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

  const emit = (event: string, payload?: unknown, sessionId?: string): void => {
    send(sessionId ? { event, sessionId, payload } : { event, payload });
  };

  const respond = (id: number, result: unknown): void => send({ id, ok: true, result });
  const fail = (id: number, error: unknown): void =>
    send({ id, ok: false, error: toErrorBody(error) });

  /** Replaces an oversized result with a blob reference. */
  const spill = async (value: unknown): Promise<unknown> => {
    if (!exceedsThreshold(value)) return value;
    const serialized = JSON.stringify(value) ?? "null";
    const path = await writeBlob(`${randomUUID()}.json`, serialized);
    const reference: BlobRef = { $blob: path, bytes: Buffer.byteLength(serialized, "utf8") };
    return reference;
  };

  const contextFor = (request: HostRequestFrame, method: HostMethod): HostRequestContext => ({
    method,
    requestId: request.id,
    emit,
    readBlob,
  });

  handlers["host.ping"] = () => ({ pong: true, at: Date.now() });

  handlers["host.hello"] = () => ({
    protocolVersion: HOST_PROTOCOL_VERSION,
    nodeVersion: options.info.nodeVersion,
    piVersion: options.info.piVersion,
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
    if (!path.startsWith(blobDir)) {
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
      respond(id, method === "host.blobs.read" ? result : await spill(result));
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
