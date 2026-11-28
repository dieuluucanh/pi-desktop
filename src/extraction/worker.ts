/**
 * Document-extraction worker entry (plan step 18).
 *
 * Runs under the bundled Node runtime in its own process. It imports only
 * Node built-ins and shared contracts: no Electron, Pi SDK, extensions,
 * workspace/Office bridge, terminal/PTY, credentials or provider code.
 *
 * Bytes arrive in ordered base64 chunks, are written to a disposable per-job
 * temp file, and are validated before any parser runs. Step 18 ships the
 * bounded protocol and staging lifecycle; the PDF/OOXML/ODF extractors land in
 * steps 20–23, so a sealed job currently answers `parser_unavailable` instead
 * of pretending to convert.
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXTRACTION_CHUNK_BYTES,
  EXTRACTION_MAX_ORIGINAL_BYTES,
  EXTRACTION_WORKER_PROTOCOL_VERSION,
  ExtractionFrameDecoder,
  encodeExtractionFrame,
  extractionWorkerFailure,
  parseBeginParams,
  parseCancelParams,
  parseChunkParams,
  parseExtractionCallParams,
  parseExtractionRequestFrame,
  parseSealParams,
  type BeginParams,
  type ExtractionWorkerHello,
  type ExtractionWorkerResponseFrame,
  type ExtractionWorkerStats,
} from "../shared/extraction-worker-protocol";
import type { ExtractionRequest } from "../shared/extraction";

const SAFE_MODE = process.env.PI_EXTRACTION_SAFE_MODE === "1";
const TEMP_ROOT = process.env.PI_EXTRACTION_TEMP?.trim() || join(tmpdir(), "pi-extraction");
const MAX_JOB_AGE_MS = 30_000;

interface Job {
  readonly params: BeginParams;
  readonly directory: string;
  readonly path: string;
  readonly hash: ReturnType<typeof createHash>;
  readonly writer: ReturnType<typeof createWriteStream>;
  offset: number;
  sealed: boolean;
  createdAt: number;
}

let job: Job | null = null;
let closed = false;

function write(frame: ExtractionWorkerResponseFrame): void {
  if (closed) return;
  process.stdout.write(encodeExtractionFrame(frame));
}

function cleanupJob(): void {
  if (!job) return;
  const current = job;
  job = null;
  try {
    current.writer.end();
  } catch {
    // The stream may already be closed by a failed write.
  }
  void rm(current.directory, { recursive: true, force: true }).catch(() => undefined);
}

function stats(): ExtractionWorkerStats {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    uptimeMs: Math.round(process.uptime() * 1_000),
  };
}

function hello(): ExtractionWorkerHello {
  return {
    version: EXTRACTION_WORKER_PROTOCOL_VERSION,
    node: process.version,
    contractVersion: 1,
    // Honest advertisement: no format parser is wired in this step.
    parsers: { pdf: false, ooxml: false, odf: false },
    disabled: SAFE_MODE,
  };
}

async function start(params: BeginParams): Promise<ExtractionWorkerResponseFrame> {
  if (SAFE_MODE) return { id: 0, ok: false, error: { code: "safe_mode" } };
  if (job) return { id: 0, ok: false, error: { code: "busy" } };
  if (params.size > EXTRACTION_MAX_ORIGINAL_BYTES) {
    return { id: 0, ok: false, error: { code: "limit_exceeded" } };
  }
  try {
    const directory = await mkdtemp(join(TEMP_ROOT, "job-"));
    const path = join(directory, "original.bin");
    const writer = createWriteStream(path, { flags: "wx", mode: 0o600 });
    job = {
      params,
      directory,
      path,
      hash: createHash("sha256"),
      writer,
      offset: 0,
      sealed: false,
      createdAt: Date.now(),
    };
    return { id: 0, ok: true, result: { ok: true } };
  } catch {
    return { id: 0, ok: false, error: { code: "internal_error" } };
  }
}

function appendChunk(params: {
  jobId: string;
  offset: number;
  data: string;
}): ExtractionWorkerResponseFrame {
  if (!job || params.jobId !== job.params.jobId) {
    return { id: 0, ok: false, error: { code: "bad_request" } };
  }
  if (job.sealed || params.offset !== job.offset) {
    return { id: 0, ok: false, error: { code: "bad_request" } };
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(params.data, "base64");
  } catch {
    return { id: 0, ok: false, error: { code: "bad_request" } };
  }
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > EXTRACTION_CHUNK_BYTES ||
    job.offset + bytes.byteLength > job.params.size
  ) {
    return { id: 0, ok: false, error: { code: "limit_exceeded" } };
  }
  job.hash.update(bytes);
  job.writer.write(bytes);
  job.offset += bytes.byteLength;
  return { id: 0, ok: true, result: { ok: true } };
}

async function seal(jobId: string): Promise<ExtractionWorkerResponseFrame> {
  if (!job || jobId !== job.params.jobId || job.sealed) {
    return { id: 0, ok: false, error: { code: "bad_request" } };
  }
  if (job.offset !== job.params.size) {
    return { id: 0, ok: false, error: { code: "bad_request" } };
  }
  if (job.hash.digest("hex") !== job.params.originalSha256) {
    cleanupJob();
    return { id: 0, ok: false, error: { code: "bad_request" } };
  }
  job.sealed = true;
  await new Promise<void>((resolve) => job?.writer.end(resolve));
  return { id: 0, ok: true, result: { ok: true } };
}

function call(request: ExtractionRequest): ExtractionWorkerResponseFrame {
  if (SAFE_MODE) return { id: 0, ok: false, error: { code: "safe_mode" } };
  if (
    !job ||
    !job.sealed ||
    job.params.jobId !== request.jobId ||
    job.params.originalId !== request.originalId
  ) {
    return { id: 0, ok: false, error: { code: "bad_request" } };
  }
  // The bounded protocol and staging lifecycle are implemented; format parsers
  // are explicitly unavailable until their own steps land.
  return { id: 0, ok: false, error: { code: "parser_unavailable" } };
}

async function dispatch(frame: {
  id: number;
  method: string;
  params?: unknown;
}): Promise<ExtractionWorkerResponseFrame> {
  const respond = (result: ExtractionWorkerResponseFrame): ExtractionWorkerResponseFrame => ({
    ...result,
    id: frame.id,
  });
  switch (frame.method) {
    case "hello":
      return respond({ id: 0, ok: true, result: hello() });
    case "stats":
      return respond({ id: 0, ok: true, result: stats() });
    case "begin": {
      if (SAFE_MODE) return respond({ id: 0, ok: false, error: { code: "safe_mode" } });
      const params = parseBeginParams(frame.params);
      if (!params) return respond({ id: 0, ok: false, error: { code: "bad_request" } });
      return respond(await start(params));
    }
    case "chunk": {
      const params = parseChunkParams(frame.params);
      if (!params) return respond({ id: 0, ok: false, error: { code: "bad_request" } });
      return respond(appendChunk(params));
    }
    case "seal": {
      const params = parseSealParams(frame.params);
      if (!params) return respond({ id: 0, ok: false, error: { code: "bad_request" } });
      return respond(await seal(params.jobId));
    }
    case "cancel": {
      const params = parseCancelParams(frame.params);
      if (!params) return respond({ id: 0, ok: false, error: { code: "bad_request" } });
      if (job?.params.jobId === params.jobId) cleanupJob();
      return respond({ id: 0, ok: true, result: { ok: true } });
    }
    case "inventory":
    case "extract": {
      const params = parseExtractionCallParams(frame.params);
      if (!params) return respond({ id: 0, ok: false, error: { code: "bad_request" } });
      return respond(call(params.request));
    }
    case "shutdown": {
      cleanupJob();
      closed = true;
      setTimeout(() => process.exit(0), 10).unref();
      return respond({ id: 0, ok: true, result: { ok: true } });
    }
    default:
      return respond({ id: 0, ok: false, error: { code: "bad_request" } });
  }
}

const decoder = new ExtractionFrameDecoder();

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  const decoded = decoder.push(chunk);
  if (decoded.tooLarge) {
    write(extractionWorkerFailure(0, "frame_too_large"));
    process.exit(2);
  }
  for (const value of decoded.frames) {
    if (value === null) {
      write(extractionWorkerFailure(0, "bad_request"));
      continue;
    }
    const frame = parseExtractionRequestFrame(value);
    if (!frame) {
      write(extractionWorkerFailure(0, "bad_request"));
      continue;
    }
    void dispatch(frame as { id: number; method: string; params?: unknown })
      .then((response) => write(response))
      .catch(() => write(extractionWorkerFailure(frame.id, "internal_error")));
  }
});

process.stdin.on("end", () => {
  cleanupJob();
  process.exit(0);
});

process.on("uncaughtException", () => {
  write(extractionWorkerFailure(0, "internal_error"));
  cleanupJob();
  process.exit(1);
});
process.on("unhandledRejection", () => {
  write(extractionWorkerFailure(0, "internal_error"));
  cleanupJob();
  process.exit(1);
});
process.on("SIGTERM", () => {
  cleanupJob();
  process.exit(0);
});
process.on("SIGINT", () => {
  cleanupJob();
  process.exit(0);
});

// Clean stale jobs only from this process's own temp dirs; the supervisor
// removes the per-job directory on every failure path as well.
setInterval(() => {
  if (job && Date.now() - job.createdAt > MAX_JOB_AGE_MS) {
    cleanupJob();
    process.exit(3);
  }
}, 1_000).unref();
