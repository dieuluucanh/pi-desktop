import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeExtractionDeps } from "../../src/main/extraction-node";
import { createExtractionSupervisor } from "../../src/main/extraction-supervisor";
import type { ExtractionRequest } from "../../src/shared/extraction";
import { EXTRACTION_WORKER_PROTOCOL_VERSION } from "../../src/shared/extraction-worker-protocol";

/**
 * Real bundled-worker integration (plan step 18). CI builds the host bundle
 * before tests (`npm run build:host`); set PI_REQUIRE_EXTRACTION_WORKER=1 to make
 * a missing bundle a failure instead of a skip.
 */
const WORKER = join(process.cwd(), "out", "host", "extraction-worker.mjs");
const required = process.env.PI_REQUIRE_EXTRACTION_WORKER === "1";
const available = existsSync(WORKER);

const opaque = (n: number): string =>
  `123e4567-e89b-42d3-a456-${String(426614174000 + n).padStart(12, "0")}`;
const sha = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "pi-extraction-test-"));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function requestFor(bytes: Uint8Array): ExtractionRequest {
  const originalSha256 = sha(bytes);
  const originalId = opaque(2);
  return {
    version: 1,
    jobId: opaque(1),
    originalId,
    originalSha256,
    format: "pdf",
    selection: { version: 1, kind: "pdf", pages: { mode: "all" } },
    maxOutputBytes: 64 * 1024,
    consent: {
      version: 1,
      originalId,
      originalSha256,
      selectionDigest: "b".repeat(64),
      policyDigest: "c".repeat(64),
      approvedAt: 1,
    },
  };
}

function supervisor(overrides: { safeMode?: boolean; workerPath?: string } = {}) {
  return createExtractionSupervisor(
    createNodeExtractionDeps({
      nodePath: process.execPath,
      workerPath: overrides.workerPath ?? WORKER,
      tempRoot,
      enabled: true,
      safeMode: overrides.safeMode ?? false,
    }),
  );
}

describe("bundled extraction worker", () => {
  it.skipIf(!available && !required)(
    "starts offline, advertises no parser and stages/validates input",
    async () => {
      if (!available) throw new Error("extraction worker bundle is missing");
      const worker = supervisor();
      const hello = await worker.hello();
      expect(hello).toMatchObject({
        version: EXTRACTION_WORKER_PROTOCOL_VERSION,
        contractVersion: 1,
        parsers: { pdf: false, ooxml: false, odf: false },
        disabled: false,
      });

      const bytes = new TextEncoder().encode("%PDF-1.7 fake");
      await expect(worker.extract({ request: requestFor(bytes), bytes })).rejects.toMatchObject({
        code: "parser_unavailable",
      });
      // Every job cleans its disposable temp directory.
      expect(await readdir(tempRoot)).toEqual([]);
    },
  );

  it.skipIf(!available && !required)(
    "rejects a missing worker bundle without leaking temp state",
    async () => {
      const worker = supervisor({ workerPath: join(tempRoot, "missing-worker.mjs") });
      await expect(worker.hello()).rejects.toMatchObject({ code: "unavailable" });
      expect(await readdir(tempRoot)).toEqual([]);
    },
  );

  it("hard-disables in safe mode before spawning", async () => {
    const worker = supervisor({ safeMode: true });
    await expect(worker.hello()).rejects.toMatchObject({ code: "safe_mode" });
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it.skipIf(!available && !required)(
    "answers a malformed frame with a bounded error and no content",
    async () => {
      if (!available) throw new Error("extraction worker bundle is missing");
      const child = spawn(process.execPath, [WORKER], {
        env: { PI_DESKTOP_EXTRACTION: "1", PI_EXTRACTION_TEMP: tempRoot, TZ: "UTC" },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      try {
        child.stdin.write("not json\n");
        const output = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("worker did not answer")), 10_000);
          child.stdout.once("data", (chunk) => {
            clearTimeout(timer);
            resolve(String(chunk));
          });
        });
        expect(JSON.parse(output.trim())).toMatchObject({
          ok: false,
          error: { code: "bad_request" },
        });
        expect(output).not.toContain("%PDF");
      } finally {
        child.kill();
      }
    },
  );
});
