/**
 * The JSONL protocol between the Electron main process and a Pi host process.
 *
 * One host per session tab (plan D4). Main sends `HostRequest` frames on stdin;
 * the host answers with `HostResponse` frames and pushes `HostEvent` frames on
 * stdout. One JSON object per line, no framing headers, so a host can also be
 * driven by hand when debugging.
 *
 * Both sides share this module: it is the only place that knows the wire shape.
 */

export const HOST_PROTOCOL_VERSION = 1;

/** Requests and responses larger than this are refused (blobs are the answer). */
export const MAX_FRAME_BYTES = 5 * 1024 * 1024;

/** Values at or above this size are spilled to the blob cache instead of the frame. */
export const BLOB_SPILL_THRESHOLD_BYTES = 1024 * 1024;

/** Environment variable telling a host where to spill oversized payloads. */
export const BLOB_DIR_ENV = "PI_DESKTOP_BLOB_DIR";

/** Selects the host service instead of the `pi` CLI (plan D16). */
export const SERVICE_FLAG = "--service";
export const SERVICE_ENV = "PI_DESKTOP_HOST_MODE";
/** Identifies which session tab a host belongs to. */
export const SESSION_ID_ENV = "PI_DESKTOP_SESSION_ID";

/**
 * Which kind of host a process is (plan D-A3).
 *
 * `control` hosts serve app-wide state (settings, providers, packages, session
 * and file listings) and deliberately never construct an `AgentSession`;
 * `session` hosts own exactly one Pi session. The role travels in the child's
 * environment because the host process decides which core to build.
 */
export const HOST_ROLE_ENV = "PI_DESKTOP_HOST_ROLE";
export const ROLE_FLAG = "--role";

export type HostRole = "control" | "session";

export function isHostRole(value: unknown): value is HostRole {
  return value === "control" || value === "session";
}

export interface HostRequestFrame {
  id: number;
  method: string;
  params?: unknown;
}

export interface HostErrorBody {
  message: string;
  code?: string;
  data?: unknown;
}

export type HostResponseFrame =
  { id: number; ok: true; result: unknown } | { id: number; ok: false; error: HostErrorBody };

export interface HostEventFrame {
  event: string;
  sessionId?: string;
  payload?: unknown;
}

export type HostFrame = HostRequestFrame | HostResponseFrame | HostEventFrame;

/**
 * A stand-in for a payload that was too large for a frame. `path` is inside the
 * host's blob cache (`userData/blob-cache/`); `host.blobs.read` fetches it back.
 */
export interface BlobRef {
  $blob: string;
  bytes: number;
  sha256?: string;
}

/** Methods a host must understand. Session semantics land in plan step 5. */
export const HOST_METHODS = [
  // transport
  "host.hello",
  "host.ping",
  "host.shutdown",
  "host.blobs.read",
  // sessions
  "session.create",
  "session.open",
  "session.list",
  "session.resume",
  "session.fork",
  "session.clone",
  "session.delete",
  "session.rename",
  "session.exportHtml",
  "session.reload",
  // conversation
  "prompt",
  "steer",
  "followUp",
  "abort",
  "clearQueue",
  // state
  "state.get",
  "messages.get",
  "entries.get",
  "tree.get",
  "stats.get",
  "commands.list",
  "tools.list",
  "tools.setActive",
  "model.list",
  "model.set",
  "model.cycle",
  "thinking.set",
  "thinking.cycle",
  "thinking.levels",
  "compact",
  // configuration
  "settings.get",
  "settings.set",
  "settings.flush",
  "settings.raw",
  "providers.list",
  "providers.auth",
  "providers.login",
  "providers.logout",
  "providers.setKey",
  "packages.install",
  "packages.remove",
  "packages.update",
  "packages.list",
  // extension UI + files
  "oi.respond",
  "files.list",
  "files.read",
  "files.write",
  // RPC-aligned additions (plan step 4). Names deliberately mirror Pi's RPC
  // commands (in parentheses) so the parity test can pin the mapping, while
  // operations that already have a protocol name keep that name.
  "session.new", // new_session
  "session.switch", // switch_session
  "session.forkMessages", // get_fork_messages
  "session.lastAssistantText", // get_last_assistant_text
  "session.queueMode", // set_steering_mode / set_follow_up_mode
  "session.autoCompaction", // set_auto_compaction
  "session.autoRetry", // set_auto_retry
  "session.abortRetry", // abort_retry
  "model.available", // get_available_models
  "bash.run", // bash
  "bash.abort", // abort_bash
  "providers.runtimeKey", // setRuntimeApiKey (no RPC equivalent)
  "providers.refresh", // refresh (no RPC equivalent)
  "providers.custom", // models.json gateway editor (no RPC equivalent)
] as const;

export type HostMethod = (typeof HOST_METHODS)[number];

export function isHostMethod(value: unknown): value is HostMethod {
  return typeof value === "string" && (HOST_METHODS as readonly string[]).includes(value);
}

export function encodeFrame(frame: HostFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/** Parses one line; returns null for blank lines and for anything that is not an object. */
export function decodeFrame(line: string): HostFrame | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as HostFrame;
  } catch {
    return null;
  }
}

export function isResponseFrame(frame: HostFrame): frame is HostResponseFrame {
  return typeof (frame as HostResponseFrame).id === "number" && "ok" in frame;
}

export function isRequestFrame(frame: HostFrame): frame is HostRequestFrame {
  return typeof (frame as HostRequestFrame).id === "number" && "method" in frame;
}

export function isEventFrame(frame: HostFrame): frame is HostEventFrame {
  return typeof (frame as HostEventFrame).event === "string";
}

export function isBlobRef(value: unknown): value is BlobRef {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BlobRef>;
  return typeof candidate.$blob === "string" && typeof candidate.bytes === "number";
}

/**
 * Splits a byte stream into frames.
 *
 * Guards against a single frame exceeding `maxBytes` (a bug or a hostile
 * payload): the oversized line is discarded and reported once, and the decoder
 * resynchronises on the next newline.
 */
export class JsonlFrameDecoder {
  private buffer = "";
  private dropping = false;
  private readonly maxBytes: number;

  constructor(maxBytes: number = MAX_FRAME_BYTES) {
    this.maxBytes = maxBytes;
  }

  /** Feeds a chunk and returns every complete frame it produced. */
  push(chunk: string): { frames: HostFrame[]; overflow: boolean } {
    this.buffer += chunk;
    const frames: HostFrame[] = [];
    let overflow = false;

    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (this.dropping) {
        this.dropping = false;
        overflow = true;
        continue;
      }
      if (line.length > this.maxBytes) {
        overflow = true;
        continue;
      }
      frames.push(...toFrames(decodeFrame(line)));
    }

    if (this.buffer.length > this.maxBytes) {
      this.buffer = "";
      this.dropping = true;
      overflow = true;
    }

    return { frames, overflow };
  }
}

function toFrames(frame: HostFrame | null): HostFrame[] {
  return frame === null ? [] : [frame];
}

/** True when a value cannot be sent as-is inside a frame. */
export function exceedsThreshold(
  value: unknown,
  threshold: number = BLOB_SPILL_THRESHOLD_BYTES,
): boolean {
  return byteLength(JSON.stringify(value ?? null) ?? "") > threshold;
}

/** UTF-8 byte length; `TextEncoder` is available in Node and the browser. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
