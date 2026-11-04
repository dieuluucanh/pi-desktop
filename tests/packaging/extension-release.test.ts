import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * The release tool's observable CLI contract. The pure version/tag/changelog
 * helpers live in `extension-package.test.ts`; this suite proves the command is
 * wired up and refuses unknown flags without touching the network.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = join(repoRoot, "scripts", "release-extension.mjs");
const execFileAsync = promisify(execFile);

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, [script, ...args], {
      cwd: repoRoot,
      timeout: 30_000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

describe("release-extension", () => {
  it("documents the flags, defaults and package name", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(0);
    for (const text of [
      "--status",
      "--dry-run",
      "--bump",
      "--branch",
      "--continue",
      "--no-push",
      "@dieulc/checkpoints",
      "default: main",
    ]) {
      expect(result.stdout).toContain(text);
    }
  });

  it("rejects an unknown flag with a non-zero exit", async () => {
    const result = await run(["--not-a-flag"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("unknown argument");
  });
});
