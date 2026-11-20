import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Release retry scripts (2026-11-08 release-network-resilience plan, step 2).
 *
 * The v0.8.0 release failed on a transient GitHub 504 because electron-builder's
 * own retry window is only ~12 s. These scripts add the longer, bounded retry.
 *
 * The tests run the real Bash scripts against a stub Node command in a temporary
 * directory: one stub fails twice and succeeds on the third attempt, another
 * always fails, and a third asserts that `package-retry.sh` removes a partial
 * `release/` before trying electron-builder again. The suite skips when `bash`
 * is unavailable (for example, a Windows runner without Git Bash); the release
 * workflow itself runs the scripts under Git Bash and the workflow-contract
 * test pins their use.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const retryScript = join(repoRoot, "scripts", "retry.sh");
const packageRetryScript = join(repoRoot, "scripts", "package-retry.sh");

const STUB = `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const [counter, mode] = process.argv.slice(2);
let attempt = 0;
try {
  attempt = Number(readFileSync(counter, "utf8")) || 0;
} catch {}
attempt += 1;
writeFileSync(counter, String(attempt));

if (mode === "cleanup") {
  if (existsSync("release")) {
    console.error("release/ survived into attempt " + attempt);
    process.exit(9);
  }
  mkdirSync("release", { recursive: true });
  writeFileSync("release/partial", "partial");
  process.exit(attempt >= 2 ? 0 : 1);
}

if (mode === "always-fail") process.exit(1);
process.exit(attempt < 3 ? 1 : 0);
`;

interface Fixture {
  dir: string;
  counter: string;
  stub: string;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "pi-retry-"));
  const counter = join(dir, "counter");
  const stub = join(dir, "stub.mjs");
  writeFileSync(stub, STUB);
  return { dir, counter, stub };
}

function runScript(
  script: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): SpawnSyncReturns<string> {
  return spawnSync("bash", [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

const hasBash = spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasBash)("release retry helpers", () => {
  it("retries a command until it succeeds and preserves the attempt count", () => {
    const { dir, counter, stub } = fixture();
    try {
      const result = runScript(
        retryScript,
        ["3", "0", "--", process.execPath, stub, counter, "flaky"],
        dir,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(counter, "utf8")).toBe("3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the last status after every attempt fails", () => {
    const { dir, counter, stub } = fixture();
    try {
      const result = runScript(
        retryScript,
        ["2", "0", "--", process.execPath, stub, counter, "always-fail"],
        dir,
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("failed after 2 attempt(s)");
      expect(readFileSync(counter, "utf8")).toBe("2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cleans release/ before retrying electron-builder", () => {
    const { dir, counter, stub } = fixture();
    try {
      const result = runScript(
        packageRetryScript,
        [process.execPath, stub, counter, "cleanup"],
        dir,
        {
          PACKAGE_RETRY_ATTEMPTS: "2",
          PACKAGE_RETRY_DELAY_SECONDS: "0",
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(counter, "utf8")).toBe("2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed retry arguments instead of looping forever", () => {
    const { dir } = fixture();
    try {
      const result = runScript(retryScript, ["three", "0", "--", "true"], dir);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("usage: retry.sh");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
