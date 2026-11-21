/**
 * Bounded document-extraction supervisor (plan step 18).
 *
 * One worker process per job, at most two jobs app-wide, a bounded queue, a
 * 30 s deadline, a V8 heap flag plus a separate RSS ceiling sampled from the OS,
 * a bounded frame stream and disposable per-job temp storage. All process,
 * clock, RSS, filesystem and kill-tree facts are injected so the policy is
 * unit-testable; the Node adapter lives in `extraction-node.ts`.
 *
 * A killed/failed job never yields partial content: the promise rejects and the
 * temp directory is always removed. This is a resource boundary, not an OS
 * sandbox.
 */

import {
  EXTRACTION_BUDGETS,
  validateExtractionInventory,
  validateExtractionProposal,
  type ExtractionInventory,
  type ExtractionProposal,
  type ExtractionRequest,
} from "../shared/extraction";
import {
  EXTRACTION_CHUNK_BYTES,
  EXTRACTION_MAX_FRAME_BYTES,
  EXTRACTION_WORKER_PROTOCOL_VERSION,
  ExtractionFrameDecoder,
  encodeExtractionFrame,
  type ExtractionWorkerErrorCode,
  type ExtractionWorkerHello,
  type ExtractionWorkerRequestFrame,
  type ExtractionWorkerResponseFrame,
} from "../shared/extraction-worker-protocol";

export interface ExtractionChild {
  readonly pid: number | null;
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream | null;
  on(event: "exit" | "error", listener: (...args: unknown[]) => void): ExtractionChild;
  kill(signal?: NodeJS.Signals): boolean;
}

export type ExtractionSpawner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string>; windowsHide: boolean },
) => ExtractionChild;

export interface ExtractionSupervisorDeps {
  readonly nodePath: string;
  readonly workerPath: string;
  readonly tempRoot: string;
  readonly platform: string;
  readonly enabled: boolean;
  readonly safeMode: boolean;
  readonly maxJobs?: number;
  readonly maxQueue?: number;
  readonly deadlineMs?: number;
  readonly maxRssBytes?: number;
  readonly maxHeapBytes?: number;
  /** Cap on bytes received from one worker, including result JSON. */
  readonly maxStreamBytes?: number;
  readonly rssSampleMs?: number;
  readonly now?: () => number;
  readonly schedule?: (delayMs: number, callback: () => void) => () => void;
  readonly spawner?: ExtractionSpawner;
  readonly killTree?: (pid: number | null) => Promise<void>;
  readonly readRss?: (pid: number) => Promise<number | null>;
  readonly makeTempDir?: (root: string) => Promise<string>;
  readonly removeTempDir?: (path: string) => Promise<void>;
}

export type ExtractionSupervisorErrorCode =
  ExtractionWorkerErrorCode | "disabled" | "unavailable" | "queue_full";

export class ExtractionSupervisorError extends Error {
  constructor(readonly code: ExtractionSupervisorErrorCode) {
    super(`extraction: ${code}`);
    this.name = "ExtractionSupervisorError";
  }
}

export interface ExtractionJobInput {
  readonly request: ExtractionRequest;
  /** The original bytes, already authorized by the caller (≤25 MiB). */
  readonly bytes: Uint8Array;
}

export interface ExtractionSupervisor {
  hello(): Promise<ExtractionWorkerHello>;
  inventory(input: ExtractionJobInput): Promise<ExtractionInventory>;
  extract(input: ExtractionJobInput): Promise<ExtractionProposal>;
  /** Active/queued counts for diagnostics and tests. */
  stats(): { readonly active: number; readonly queued: number };
  dispose(): void;
}

interface PendingResponse {
  resolve: (frame: ExtractionWorkerResponseFrame) => void;
  reject: (error: ExtractionSupervisorError) => void;
}

interface RunningJob {
  readonly child: ExtractionChild;
  readonly tempDir: string;
  cancelDeadline: () => void;
  cancelRss: () => void;
  readonly pending: Map<number, PendingResponse>;
  outputBytes: number;
  settled: boolean;
}

export function createExtractionSupervisor(deps: ExtractionSupervisorDeps): ExtractionSupervisor {
  const maxJobs = deps.maxJobs ?? EXTRACTION_BUDGETS.globalJobs;
  const maxQueue = deps.maxQueue ?? 8;
  const deadlineMs = deps.deadlineMs ?? EXTRACTION_BUDGETS.wallMs;
  const maxRssBytes = deps.maxRssBytes ?? EXTRACTION_BUDGETS.rssBytes;
  const maxHeapBytes = deps.maxHeapBytes ?? EXTRACTION_BUDGETS.heapBytes;
  const maxStreamBytes = deps.maxStreamBytes ?? EXTRACTION_BUDGETS.outputBytes * 4;
  const rssSampleMs = deps.rssSampleMs ?? 500;
  const schedule =
    deps.schedule ??
    ((delay, callback) => {
      const timer = setTimeout(callback, delay);
      timer.unref();
      return () => clearTimeout(timer);
    });
  if (
    !deps.spawner ||
    !deps.killTree ||
    !deps.readRss ||
    !deps.makeTempDir ||
    !deps.removeTempDir
  ) {
    throw new ExtractionSupervisorError("unavailable");
  }
  const spawner = deps.spawner;
  const killTree = deps.killTree;
  const readRss = deps.readRss;
  const makeTempDir = deps.makeTempDir;
  const removeTempDir = deps.removeTempDir;

  let nextId = 1;
  const running = new Set<RunningJob>();
  const queue: Array<() => void> = [];
  let disposed = false;

  const reject = (code: ExtractionSupervisorErrorCode): never => {
    throw new ExtractionSupervisorError(code);
  };

  const requireEnabled = (): void => {
    if (!deps.enabled) reject("disabled");
    if (deps.safeMode) reject("safe_mode");
  };

  const releaseSlot = (): void => {
    while (queue.length > 0 && running.size < maxJobs && !disposed) {
      const start = queue.shift();
      start?.();
    }
  };

  const startWorker = async (): Promise<RunningJob> => {
    if (!spawner || !killTree || !readRss || !makeTempDir || !removeTempDir) {
      reject("unavailable");
    }
    const tempDir = await makeTempDir(deps.tempRoot);
    const env: Record<string, string> = {
      PI_DESKTOP_EXTRACTION: "1",
      PI_EXTRACTION_TEMP: tempDir,
      NODE_OPTIONS: `--max-old-space-size=${Math.floor(maxHeapBytes / (1024 * 1024))}`,
      TZ: "UTC",
    };
    if (deps.platform === "win32") {
      if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
      if (process.env.windir) env.windir = process.env.windir;
    }
    let child: ExtractionChild;
    try {
      child = spawner(deps.nodePath, [deps.workerPath], {
        cwd: tempDir,
        env,
        windowsHide: true,
      });
    } catch {
      await removeTempDir(tempDir).catch(() => undefined);
      return reject("unavailable");
    }
    const pending = new Map<number, PendingResponse>();
    const job: RunningJob = {
      child,
      tempDir,
      pending,
      cancelDeadline: () => {},
      cancelRss: () => {},
      outputBytes: 0,
      settled: false,
    };
    running.add(job);
    const settle = async (code?: ExtractionSupervisorErrorCode): Promise<void> => {
      if (job.settled) return;
      job.settled = true;
      job.cancelDeadline();
      job.cancelRss();
      running.delete(job);
      for (const entry of pending.values()) {
        entry.reject(new ExtractionSupervisorError(code ?? "unavailable"));
      }
      pending.clear();
      await killTree(child.pid).catch(() => undefined);
      await removeTempDir(tempDir).catch(() => undefined);
      releaseSlot();
    };
    child.on("exit", () => void settle("unavailable"));
    child.on("error", () => void settle("internal_error"));
    job.cancelDeadline = schedule(deadlineMs, () => void settle("timeout"));
    job.cancelRss = schedule(rssSampleMs, function sample(): void {
      if (job.settled || child.pid === null) return;
      void readRss(child.pid)
        .then((rss) => {
          if (job.settled || rss === null) return;
          if (rss > maxRssBytes) void settle("limit_exceeded");
          else job.cancelRss = schedule(rssSampleMs, sample);
        })
        .catch(() => {
          job.cancelRss = schedule(rssSampleMs, sample);
        });
    });

    const decoder = new ExtractionFrameDecoder();
    const onData = (chunk: Buffer | string): void => {
      if (job.settled) return;
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      job.outputBytes += Buffer.byteLength(text, "utf8");
      if (job.outputBytes > maxStreamBytes) {
        void settle("output_too_large");
        return;
      }
      const decoded = decoder.push(text);
      if (decoded.tooLarge) {
        void settle("frame_too_large");
        return;
      }
      for (const value of decoded.frames) {
        if (value === null) {
          void settle("protocol");
          return;
        }
        const frame = value as Partial<ExtractionWorkerResponseFrame>;
        if (
          !frame ||
          typeof frame !== "object" ||
          typeof frame.id !== "number" ||
          typeof frame.ok !== "boolean"
        ) {
          void settle("protocol");
          return;
        }
        const entry = pending.get(frame.id);
        if (!entry) continue;
        pending.delete(frame.id);
        entry.resolve(frame as ExtractionWorkerResponseFrame);
      }
    };
    child.stdout.on("data", onData);
    child.stderr?.on("data", () => {
      // Worker diagnostics are never forwarded: a parser must not leak content
      // through stderr, and the supervisor only reports stable codes.
    });
    return job;
  };

  const request = (
    job: RunningJob,
    method: ExtractionWorkerRequestFrame["method"],
    params?: unknown,
    timeoutMs = deadlineMs,
  ): Promise<ExtractionWorkerResponseFrame> => {
    if (job.settled) return Promise.reject(new ExtractionSupervisorError("unavailable"));
    const id = nextId++;
    const frame = params === undefined ? { id, method } : { id, method, params };
    const payload = encodeExtractionFrame(frame);
    if (Buffer.byteLength(payload, "utf8") > EXTRACTION_MAX_FRAME_BYTES) {
      return Promise.reject(new ExtractionSupervisorError("limit_exceeded"));
    }
    return new Promise<ExtractionWorkerResponseFrame>((resolve, rejectRequest) => {
      const timer = schedule(timeoutMs, () => {
        job.pending.delete(id);
        rejectRequest(new ExtractionSupervisorError("timeout"));
      });
      job.pending.set(id, {
        resolve: (response) => {
          timer();
          resolve(response);
        },
        reject: (error) => {
          timer();
          rejectRequest(error);
        },
      });
      job.child.stdin.write(payload);
    });
  };

  const call = async <T>(
    kind: "inventory" | "extract",
    input: ExtractionJobInput,
    validate: (value: unknown) => T | null,
  ): Promise<T> => {
    requireEnabled();
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > 25 * 1024 * 1024) {
      reject("limit_exceeded");
    }
    if (running.size >= maxJobs && queue.length >= maxQueue) reject("queue_full");
    if (running.size >= maxJobs) {
      await new Promise<void>((resolve) => queue.push(resolve));
      if (disposed) reject("unavailable");
    }
    const job = await startWorker();
    try {
      const hello = await request(job, "hello");
      if (!hello.ok) {
        return reject(hello.error.code);
      }
      const helloResult = hello.result as ExtractionWorkerHello;
      if (
        !helloResult ||
        helloResult.version !== EXTRACTION_WORKER_PROTOCOL_VERSION ||
        helloResult.contractVersion !== 1
      ) {
        return reject("protocol");
      }
      if (helloResult.disabled) return reject("safe_mode");
      const begin = await request(job, "begin", {
        version: EXTRACTION_WORKER_PROTOCOL_VERSION,
        jobId: input.request.jobId,
        originalId: input.request.originalId,
        originalSha256: input.request.originalSha256,
        size: input.bytes.byteLength,
      });
      if (!begin.ok) return reject(begin.error.code);
      for (let offset = 0; offset < input.bytes.byteLength; offset += EXTRACTION_CHUNK_BYTES) {
        const slice = input.bytes.subarray(offset, offset + EXTRACTION_CHUNK_BYTES);
        const chunk = await request(job, "chunk", {
          version: EXTRACTION_WORKER_PROTOCOL_VERSION,
          jobId: input.request.jobId,
          offset,
          data: Buffer.from(slice).toString("base64"),
        });
        if (!chunk.ok) return reject(chunk.error.code);
      }
      const seal = await request(job, "seal", {
        version: EXTRACTION_WORKER_PROTOCOL_VERSION,
        jobId: input.request.jobId,
      });
      if (!seal.ok) return reject(seal.error.code);
      const response = await request(job, kind, {
        version: EXTRACTION_WORKER_PROTOCOL_VERSION,
        request: input.request,
      });
      if (!response.ok) return reject(response.error.code);
      const validated = validate(response.result);
      if (!validated) return reject("protocol");
      return validated;
    } finally {
      // The worker has no reason to stay alive between jobs.
      job.settled = true;
      job.cancelDeadline();
      job.cancelRss();
      running.delete(job);
      await killTree(job.child.pid).catch(() => undefined);
      await removeTempDir(job.tempDir).catch(() => undefined);
      for (const entry of job.pending.values())
        entry.reject(new ExtractionSupervisorError("unavailable"));
      job.pending.clear();
      releaseSlot();
    }
  };

  return {
    async hello() {
      requireEnabled();
      if (running.size >= maxJobs && queue.length >= maxQueue) reject("queue_full");
      const job = await startWorker();
      try {
        const response = await request(job, "hello");
        if (!response.ok) return reject(response.error.code);
        const hello = response.result as ExtractionWorkerHello;
        if (!hello || hello.version !== EXTRACTION_WORKER_PROTOCOL_VERSION) {
          return reject("protocol");
        }
        return hello;
      } finally {
        job.settled = true;
        job.cancelDeadline();
        job.cancelRss();
        running.delete(job);
        await killTree(job.child.pid).catch(() => undefined);
        await removeTempDir(job.tempDir).catch(() => undefined);
        releaseSlot();
      }
    },
    inventory: (input) => call("inventory", input, validateExtractionInventory),
    extract: (input) => call("extract", input, validateExtractionProposal),
    stats: () => ({ active: running.size, queued: queue.length }),
    dispose: () => {
      disposed = true;
      for (const job of [...running]) {
        job.settled = true;
        job.cancelDeadline();
        job.cancelRss();
        void killTree?.(job.child.pid).catch(() => undefined);
        void removeTempDir?.(job.tempDir).catch(() => undefined);
      }
      running.clear();
      for (const start of queue.splice(0)) start();
    },
  };
}
