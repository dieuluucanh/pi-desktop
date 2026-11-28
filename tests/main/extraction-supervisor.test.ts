import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createExtractionSupervisor,
  ExtractionSupervisorError,
  type ExtractionChild,
  type ExtractionSupervisorDeps,
} from "../../src/main/extraction-supervisor";
import { EXTRACTION_BUDGETS, type ExtractionRequest } from "../../src/shared/extraction";
import {
  EXTRACTION_WORKER_PROTOCOL_VERSION,
  type ExtractionWorkerHello,
} from "../../src/shared/extraction-worker-protocol";

const opaque = (n: number): string =>
  `123e4567-e89b-42d3-a456-${String(426614174000 + n).padStart(12, "0")}`;
const sha = (c: string): string => c.repeat(64);
const request: ExtractionRequest = {
  version: 1,
  jobId: opaque(1),
  originalId: opaque(2),
  originalSha256: sha("a"),
  format: "pdf",
  selection: { version: 1, kind: "pdf", pages: { mode: "all" } },
  maxOutputBytes: 64 * 1024,
  consent: {
    version: 1,
    originalId: opaque(2),
    originalSha256: sha("a"),
    selectionDigest: sha("b"),
    policyDigest: sha("c"),
    approvedAt: 1,
  },
};

const hello: ExtractionWorkerHello = {
  version: EXTRACTION_WORKER_PROTOCOL_VERSION,
  node: "v24.0.0",
  contractVersion: 1,
  parsers: { pdf: false, ooxml: false, odf: false },
  disabled: false,
};

const proposalResult = {
  version: 1,
  format: "pdf",
  originalSha256: request.originalSha256,
  selectionDigest: request.consent.selectionDigest,
  chunks: [{ index: 0, text: "extracted", byteLength: 9 }],
  coverage: { kind: "complete", selectedUnits: 1, totalUnits: 1, omitted: [] },
  warnings: [],
  provenance: {
    converter: { name: "fake", version: "1" },
    contractVersion: 1,
    sourceSha256: request.originalSha256,
    selectionDigest: request.consent.selectionDigest,
    outputSha256: sha("d"),
    createdAt: 1,
  },
  outputBytes: 9,
};
const inventoryResult = {
  version: 1,
  format: "pdf",
  originalSha256: request.originalSha256,
  units: { total: 1, selected: 1, hidden: 0 },
  hasNotes: false,
  hasComments: false,
  hasMacros: false,
  warnings: [],
  digest: sha("e"),
};

class FakeChild implements ExtractionChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | null = 4242;
  killed = false;
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  private readonly silent: boolean;
  private readonly broken: boolean;
  private readonly output: unknown;

  constructor(options: { silent?: boolean; broken?: boolean; output?: unknown } = {}) {
    this.silent = options.silent === true;
    this.broken = options.broken === true;
    this.output = options.output;
    let pending = "";
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      pending += chunk;
      let index = pending.indexOf("\n");
      while (index >= 0) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        const nextIndex = pending.indexOf("\n");
        if (this.silent) {
          index = nextIndex;
          continue;
        }
        const frame = JSON.parse(line) as { id: number; method: string };
        const result =
          frame.method === "hello"
            ? hello
            : frame.method === "inventory"
              ? inventoryResult
              : frame.method === "extract"
                ? proposalResult
                : { ok: true };
        const value = this.output === undefined ? result : this.output;
        queueMicrotask(() => {
          if (this.killed) return;
          this.stdout.write(`${JSON.stringify({ id: frame.id, ok: true, result: value })}\n`);
        });
        if (this.broken) this.stdout.write("not json\n");
        index = pending.indexOf("\n");
      }
    });
  }

  on(event: "exit" | "error", listener: (...args: unknown[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  emit(event: "exit" | "error", value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

function deps(
  child: ExtractionChild,
  overrides: Partial<ExtractionSupervisorDeps> = {},
): {
  deps: ExtractionSupervisorDeps;
  spawns: Array<Record<string, unknown>>;
  removed: string[];
  killed: number[];
} {
  const spawns: Array<Record<string, unknown>> = [];
  const removed: string[] = [];
  const killed: number[] = [];
  let counter = 0;
  const base: ExtractionSupervisorDeps = {
    nodePath: "/node",
    workerPath: "/worker.mjs",
    tempRoot: "/tmp/extract",
    platform: "linux",
    enabled: true,
    safeMode: false,
    maxJobs: 1,
    maxQueue: 2,
    deadlineMs: 1_000,
    spawner: (_command, _args, options) => {
      spawns.push(options as unknown as Record<string, unknown>);
      return child;
    },
    killTree: async (pid) => {
      if (pid !== null) killed.push(pid);
    },
    readRss: async () => 1_000_000,
    makeTempDir: async (root) => {
      counter += 1;
      return `${root}/job-${counter}`;
    },
    removeTempDir: async (path) => {
      removed.push(path);
    },
    ...overrides,
  };
  return { deps: base, spawns, removed, killed };
}

const bytes = new Uint8Array(300 * 1024).fill(7);

describe("extraction supervisor", () => {
  it("starts a bounded worker, streams chunks, validates the result and cleans up", async () => {
    const child = new FakeChild();
    const h = deps(child);
    const supervisor = createExtractionSupervisor(h.deps);
    await expect(supervisor.extract({ request, bytes })).resolves.toEqual(proposalResult);
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0]).toMatchObject({
      env: {
        PI_DESKTOP_EXTRACTION: "1",
        NODE_OPTIONS: `--max-old-space-size=${EXTRACTION_BUDGETS.heapBytes / (1024 * 1024)}`,
      },
      windowsHide: true,
    });
    expect(Object.keys((h.spawns[0]?.env ?? {}) as Record<string, string>)).not.toContain("HOME");
    expect(h.removed).toEqual(["/tmp/extract/job-1"]);
    expect(h.killed).toEqual([4242]);
    expect(supervisor.stats()).toEqual({ active: 0, queued: 0 });
  });

  it("returns a validated inventory", async () => {
    const supervisor = createExtractionSupervisor(deps(new FakeChild()).deps);
    await expect(supervisor.inventory({ request, bytes })).resolves.toEqual(inventoryResult);
  });

  it("kills a hung worker at the deadline", async () => {
    const child = new FakeChild({ silent: true });
    const h = deps(child, { deadlineMs: 20 });
    const supervisor = createExtractionSupervisor(h.deps);
    await expect(supervisor.extract({ request, bytes })).rejects.toMatchObject({ code: "timeout" });
    expect(h.killed).toContain(4242);
    expect(h.removed).toContain("/tmp/extract/job-1");
  });

  it("kills a worker whose RSS exceeds the ceiling", async () => {
    const h = deps(new FakeChild({ silent: true }), {
      deadlineMs: 5_000,
      rssSampleMs: 5,
      readRss: async () => EXTRACTION_BUDGETS.rssBytes + 1,
    });
    const supervisor = createExtractionSupervisor(h.deps);
    await expect(supervisor.extract({ request, bytes })).rejects.toMatchObject({
      code: "limit_exceeded",
    });
  });

  it("fails closed for oversized output, malformed frames and worker exit", async () => {
    const output = deps(new FakeChild({ output: { ok: true, text: "x".repeat(10_000) } }), {
      maxStreamBytes: 100,
    });
    await expect(
      createExtractionSupervisor(output.deps).extract({ request, bytes }),
    ).rejects.toBeInstanceOf(ExtractionSupervisorError);

    const broken = deps(new FakeChild({ broken: true }));
    await expect(
      createExtractionSupervisor(broken.deps).extract({ request, bytes }),
    ).rejects.toMatchObject({ code: "protocol" });

    const exitingChild = new FakeChild({ silent: true });
    const exited = deps(exitingChild);
    const crashed = createExtractionSupervisor(exited.deps);
    const pending = crashed.extract({ request, bytes });
    setTimeout(() => exitingChild.emit("exit", 1), 5);
    await expect(pending).rejects.toMatchObject({ code: "unavailable" });
  });

  it("denies disabled and safe-mode builds before spawning", async () => {
    const disabled = deps(new FakeChild(), { enabled: false });
    await expect(
      createExtractionSupervisor(disabled.deps).extract({ request, bytes }),
    ).rejects.toMatchObject({ code: "disabled" });
    const safe = deps(new FakeChild(), { safeMode: true });
    await expect(
      createExtractionSupervisor(safe.deps).extract({ request, bytes }),
    ).rejects.toMatchObject({ code: "safe_mode" });
  });

  it("requires process, kill-tree, RSS and temp ports at construction", () => {
    const base = deps(new FakeChild()).deps;
    expect(() => createExtractionSupervisor({ ...base, spawner: undefined })).toThrow(
      ExtractionSupervisorError,
    );
  });

  it("queues a second job while one is active", async () => {
    const child = new FakeChild();
    const h = deps(child);
    const supervisor = createExtractionSupervisor(h.deps);
    const first = supervisor.extract({ request, bytes });
    const second = supervisor.extract({ request, bytes });
    await expect(first).resolves.toEqual(proposalResult);
    await expect(second).resolves.toEqual(proposalResult);
    expect(h.spawns.length).toBe(2);
  });
});
