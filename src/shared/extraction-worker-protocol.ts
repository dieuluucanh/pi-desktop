/**
 * Private JSONL protocol for the document-extraction worker (plan step 18).
 *
 * Main never passes a path, a command, an environment handle or a renderer
 * object to the worker. A job is opened with a generated id and metadata, the
 * original bytes arrive in bounded ordered chunks, and the worker answers with
 * the validated inventory/proposal contracts from `src/shared/extraction.ts`.
 */

import { isAttachmentId, isWellFormedAttachmentText, type AttachmentId } from "./attachments";
import {
  EXTRACTION_BUDGETS,
  type EXTRACTION_CONTRACT_VERSION,
  validateExtractionRequest,
  type ExtractionFailureCode,
  type ExtractionInventory,
  type ExtractionProposal,
  type ExtractionRequest,
} from "./extraction";

export const EXTRACTION_WORKER_PROTOCOL_VERSION = 1 as const;
/** Incoming and outgoing frames stay well below the 5 MiB host frame ceiling. */
export const EXTRACTION_MAX_FRAME_BYTES = 1024 * 1024;
export const EXTRACTION_CHUNK_BYTES = 256 * 1024;
export const EXTRACTION_MAX_ORIGINAL_BYTES = 25 * 1024 * 1024;

export type ExtractionWorkerMethod =
  "hello" | "begin" | "chunk" | "seal" | "inventory" | "extract" | "cancel" | "stats" | "shutdown";

export type ExtractionWorkerErrorCode =
  ExtractionFailureCode | "bad_request" | "busy" | "frame_too_large" | "protocol" | "safe_mode";

export interface ExtractionWorkerHello {
  readonly version: typeof EXTRACTION_WORKER_PROTOCOL_VERSION;
  readonly node: string;
  readonly contractVersion: typeof EXTRACTION_CONTRACT_VERSION;
  readonly parsers: {
    readonly pdf: boolean;
    readonly ooxml: boolean;
    readonly odf: boolean;
  };
  readonly disabled: boolean;
}

export interface ExtractionWorkerStats {
  readonly rss: number;
  readonly heapUsed: number;
  readonly heapTotal: number;
  readonly uptimeMs: number;
}

export type ExtractionWorkerResult =
  | ExtractionWorkerHello
  | ExtractionWorkerStats
  | ExtractionInventory
  | ExtractionProposal
  | { readonly ok: true };

export interface ExtractionWorkerError {
  readonly code: ExtractionWorkerErrorCode;
  /** Bounded, content-free detail. */
  readonly message?: string;
}

export interface ExtractionWorkerRequestFrame {
  readonly id: number;
  readonly method: ExtractionWorkerMethod;
  readonly params?: unknown;
}

export type ExtractionWorkerResponseFrame =
  | { readonly id: number; readonly ok: true; readonly result: ExtractionWorkerResult }
  | { readonly id: number; readonly ok: false; readonly error: ExtractionWorkerError };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function encodeExtractionFrame(frame: unknown): string {
  return `${JSON.stringify(frame)}\n`;
}

/** Bounded line decoder; a frame at or above the cap drops the connection. */
export class ExtractionFrameDecoder {
  private buffer = "";

  push(chunk: string): { frames: unknown[]; tooLarge: boolean } {
    this.buffer += chunk;
    if (this.buffer.length > EXTRACTION_MAX_FRAME_BYTES && !this.buffer.includes("\n")) {
      this.buffer = "";
      return { frames: [], tooLarge: true };
    }
    const frames: unknown[] = [];
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > EXTRACTION_MAX_FRAME_BYTES) {
        this.buffer = "";
        return { frames, tooLarge: true };
      }
      if (line.trim().length > 0) {
        try {
          frames.push(JSON.parse(line));
        } catch {
          frames.push(null);
        }
      }
      index = this.buffer.indexOf("\n");
    }
    return { frames, tooLarge: false };
  }
}

export function parseExtractionRequestFrame(value: unknown): ExtractionWorkerRequestFrame | null {
  const frame = record(value);
  if (
    !frame ||
    !exactKeys(
      frame,
      Object.hasOwn(frame, "params") ? ["id", "method", "params"] : ["id", "method"],
    ) ||
    !count(frame.id) ||
    typeof frame.method !== "string" ||
    !EXTRACTION_WORKER_METHOD_NAMES.includes(frame.method as ExtractionWorkerMethod)
  ) {
    return null;
  }
  return {
    id: frame.id,
    method: frame.method as ExtractionWorkerMethod,
    ...(Object.hasOwn(frame, "params") ? { params: frame.params } : {}),
  };
}

const EXTRACTION_WORKER_METHOD_NAMES: readonly ExtractionWorkerMethod[] = [
  "hello",
  "begin",
  "chunk",
  "seal",
  "inventory",
  "extract",
  "cancel",
  "stats",
  "shutdown",
];

export interface BeginParams {
  readonly version: typeof EXTRACTION_WORKER_PROTOCOL_VERSION;
  readonly jobId: AttachmentId;
  readonly originalId: AttachmentId;
  readonly originalSha256: string;
  readonly size: number;
}

export function parseBeginParams(value: unknown): BeginParams | null {
  const params = record(value);
  if (
    !params ||
    !exactKeys(params, ["version", "jobId", "originalId", "originalSha256", "size"]) ||
    params.version !== EXTRACTION_WORKER_PROTOCOL_VERSION ||
    !isAttachmentId(params.jobId) ||
    !isAttachmentId(params.originalId) ||
    typeof params.originalSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(params.originalSha256) ||
    !count(params.size) ||
    params.size === 0 ||
    params.size > EXTRACTION_MAX_ORIGINAL_BYTES
  ) {
    return null;
  }
  return {
    version: 1,
    jobId: params.jobId,
    originalId: params.originalId,
    originalSha256: params.originalSha256,
    size: params.size,
  };
}

export interface ChunkParams {
  readonly version: typeof EXTRACTION_WORKER_PROTOCOL_VERSION;
  readonly jobId: AttachmentId;
  readonly offset: number;
  /** Base64 of at most {@link EXTRACTION_CHUNK_BYTES}. */
  readonly data: string;
}

export function parseChunkParams(value: unknown): ChunkParams | null {
  const params = record(value);
  if (
    !params ||
    !exactKeys(params, ["version", "jobId", "offset", "data"]) ||
    params.version !== EXTRACTION_WORKER_PROTOCOL_VERSION ||
    !isAttachmentId(params.jobId) ||
    !count(params.offset) ||
    typeof params.data !== "string" ||
    params.data.length === 0 ||
    params.data.length > Math.ceil((EXTRACTION_CHUNK_BYTES * 4) / 3) + 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(params.data)
  ) {
    return null;
  }
  const length = Math.floor((params.data.length * 3) / 4);
  if (length === 0 || length > EXTRACTION_CHUNK_BYTES) return null;
  return { version: 1, jobId: params.jobId, offset: params.offset, data: params.data };
}

export function parseSealParams(value: unknown): { version: 1; jobId: AttachmentId } | null {
  const params = record(value);
  if (
    !params ||
    !exactKeys(params, ["version", "jobId"]) ||
    params.version !== EXTRACTION_WORKER_PROTOCOL_VERSION ||
    !isAttachmentId(params.jobId)
  ) {
    return null;
  }
  return { version: 1, jobId: params.jobId };
}

export function parseCancelParams(value: unknown): { version: 1; jobId: AttachmentId } | null {
  return parseSealParams(value);
}

export function parseExtractionCallParams(value: unknown): {
  readonly version: 1;
  readonly request: ExtractionRequest;
} | null {
  const params = record(value);
  if (
    !params ||
    !exactKeys(params, ["version", "request"]) ||
    params.version !== EXTRACTION_WORKER_PROTOCOL_VERSION
  ) {
    return null;
  }
  const request = validateExtractionRequest(params.request);
  return request ? { version: 1, request } : null;
}

/** Worker-side error builder; messages stay short and content-free. */
export function extractionWorkerError(
  code: ExtractionWorkerErrorCode,
  message?: string,
): ExtractionWorkerError {
  let bounded: string | undefined;
  if (typeof message === "string" && message.length > 0) {
    bounded = "";
    for (const character of message.slice(0, 200)) {
      const code = character.charCodeAt(0);
      bounded += code < 32 || code === 127 ? " " : character;
    }
  }
  return bounded ? { code, message: bounded } : { code };
}

export function extractionWorkerResponse(
  id: number,
  result: ExtractionWorkerResult,
): ExtractionWorkerResponseFrame {
  return { id, ok: true, result };
}

export function extractionWorkerFailure(
  id: number,
  code: ExtractionWorkerErrorCode,
  message?: string,
): ExtractionWorkerResponseFrame {
  return { id, ok: false, error: extractionWorkerError(code, message) };
}

/** A proposal is only usable when it passes the shared contract and has chunks. */
export function proposalIsUsable(proposal: ExtractionProposal): boolean {
  return (
    proposal.outputBytes <= EXTRACTION_BUDGETS.outputBytes &&
    proposal.chunks.length > 0 &&
    proposal.chunks.every(
      (chunk) =>
        chunk.byteLength <= EXTRACTION_BUDGETS.chunkBytes &&
        new TextEncoder().encode(chunk.text).byteLength === chunk.byteLength &&
        isWellFormedAttachmentText(chunk.text),
    )
  );
}
