import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The `~/.pi` sync script (2026-10-30 plan step 13). It only replaces the built
 * `index.mjs`; the release package owns its manifest, README, LICENSE and
 * CHANGELOG. `--check` is the release gate against a stale artifact.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = join(repoRoot, "scripts", "sync-extension.mjs");
const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-checkpoints-sync-"));
  tempDirs.push(dir);
  return dir;
}

async function seed(root: string, source: string): Promise<{ sourcePath: string; target: string }> {
  const target = join(root, "agent", "extensions", "checkpoints");
  await mkdir(target, { recursive: true });
  await writeFile(
    join(target, "package.json"),
    JSON.stringify({
      name: "@dieulc/checkpoints",
      version: "0.1.0",
      pi: { extensions: ["./index.mjs"] },
    }),
    "utf8",
  );
  const sourcePath = join(root, "dist", "pi-checkpoints", "index.mjs");
  await mkdir(join(root, "dist", "pi-checkpoints"), { recursive: true });
  await writeFile(sourcePath, source, "utf8");
  return { sourcePath, target };
}

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

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("sync-extension", () => {
  it("copies the artifact and preserves the release manifest", async () => {
    const root = await temp();
    const { sourcePath, target } = await seed(root, "export default 1;\n");
    const manifestBefore = await readFile(join(target, "package.json"), "utf8");

    const result = await run(["--pi-root", root, "--source", sourcePath]);
    expect(result.code).toBe(0);
    expect(await readFile(join(target, "index.mjs"), "utf8")).toBe("export default 1;\n");
    expect(await readFile(join(target, "package.json"), "utf8")).toBe(manifestBefore);
    expect(result.stdout).toContain("updated");
  });

  it("reports a stale artifact with --check and does not write it", async () => {
    const root = await temp();
    const { sourcePath, target } = await seed(root, "first\n");
    await run(["--pi-root", root, "--source", sourcePath]);
    await writeFile(sourcePath, "second\n", "utf8");

    const result = await run(["--pi-root", root, "--source", sourcePath, "--check"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("STALE");
    expect(await readFile(join(target, "index.mjs"), "utf8")).toBe("first\n");
  });

  it("refuses a target that is not the checkpoint package", async () => {
    const root = await temp();
    const { sourcePath } = await seed(root, "x\n");
    await writeFile(join(root, "agent", "extensions", "checkpoints", "package.json"), "{}", "utf8");

    const result = await run(["--pi-root", root, "--source", sourcePath]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("does not declare pi.extensions");
  });

  it("refuses a missing package.json", async () => {
    const root = await temp();
    const { sourcePath } = await seed(root, "x\n");
    await rm(join(root, "agent", "extensions", "checkpoints", "package.json"));
    const result = await run(["--pi-root", root, "--source", sourcePath]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("is missing");
  });
});
