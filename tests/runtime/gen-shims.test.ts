import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Generator contract for the runtime shims.
 *
 * These run the real `scripts/gen-shims.mjs` into a temp directory, so they do
 * not need a fetched Node runtime and they still run on every CI platform. The
 * live suite then executes the generated files.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const generator = join(repoRoot, "scripts", "gen-shims.mjs");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function generate(platform: string, prepopulate?: (binDir: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "pi-gen-shims-"));
  roots.push(root);
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  prepopulate?.(binDir);

  const result = spawnSync(
    process.execPath,
    [
      generator,
      "--platform",
      platform,
      "--mode",
      "packaged",
      "--runtime-dir",
      root,
      "--out",
      binDir,
      "--app-root",
      root,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  return binDir;
}

describe("gen-shims Windows output", () => {
  it("writes the cmd twins but never a node.cmd", () => {
    const binDir = generate("win32-x64");

    expect(readdirSync(binDir).sort()).toEqual([
      "node",
      "npm",
      "npm.cmd",
      "npx",
      "npx.cmd",
      "pi",
      "pi.cmd",
    ]);
    // The extensionless scripts stay for Git Bash, but cmd/PowerShell must get
    // the real node.exe from the runtime's node directory instead.
    expect(readFileSync(join(binDir, "node"), "utf8")).toContain("#!/bin/sh");
  });

  it("points the packaged pi shim at app.asar.unpacked", () => {
    const binDir = generate("win32-x64");
    expect(readFileSync(join(binDir, "pi.cmd"), "utf8")).toContain(
      "..\\app.asar.unpacked\\out\\host\\index.mjs",
    );
  });

  it("prunes a stale node.cmd left by an older build", () => {
    const binDir = generate("win32-x64", (dir) => {
      writeFileSync(join(dir, "node.cmd"), "stale", "utf8");
    });

    expect(readdirSync(binDir).sort()).not.toContain("node.cmd");
  });

  it("makes every .cmd self-locating without PI_DESKTOP_NODE", () => {
    const binDir = generate("win32-x64");

    for (const name of ["pi.cmd", "npm.cmd", "npx.cmd"]) {
      const content = readFileSync(join(binDir, name), "utf8");
      expect(content, name).toContain('set "SELF="');
      expect(content, name).toContain(`for %%I in (${name}) do set "SELF=%%~$PATH:I"`);
      expect(content, name).toContain("..\\node\\win32-x64\\node.exe");
      expect(content, name).toContain("exit /b 127");
    }
  });
});

describe("gen-shims POSIX output", () => {
  it("writes only the extensionless shims and prunes stale cmd twins", () => {
    const binDir = generate("linux-x64", (dir) => {
      writeFileSync(join(dir, "node.cmd"), "stale", "utf8");
      writeFileSync(join(dir, "pi.cmd"), "stale", "utf8");
    });

    expect(readdirSync(binDir).sort()).toEqual(["node", "npm", "npx", "pi"]);
    const pi = readFileSync(join(binDir, "pi"), "utf8");
    expect(pi).toContain("#!/bin/sh");
    expect(pi).toContain("command -v");
    expect(pi).toContain("PI_DESKTOP_NODE");
  });
});
