import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { pruneForeignRuntimes } from "../../scripts/electron-builder-after-pack.mjs";

/**
 * `extraResources` copies `resources/runtime` wholesale, so a checkout that has
 * runtimes for several platforms would otherwise ship them all. Pruning is what
 * keeps each package to its own platform/arch — and, on Windows, what stops the
 * NSIS 7z step from choking on the Linux runtime's `bin/{npm,npx,corepack}`
 * symlinks.
 */

const roots: string[] = [];

function fixture(entries: string[]): { nodeDir: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-after-pack-"));
  roots.push(root);
  const nodeDir = join(root, "node");
  mkdirSync(nodeDir, { recursive: true });
  for (const entry of entries) mkdirSync(join(nodeDir, entry), { recursive: true });
  // The lock file and README live beside the runtime directories and must survive.
  writeFileSync(join(nodeDir, "node.lock.json"), "{}");
  writeFileSync(join(nodeDir, "README.md"), "# runtime\n");
  return { nodeDir };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("afterPack runtime pruning", () => {
  it("keeps only the runtime the package was built for", () => {
    const { nodeDir } = fixture([
      "win32-x64",
      "linux-x64",
      "linux-arm64",
      ".staging-linux-x64-abc",
    ]);

    expect(pruneForeignRuntimes(nodeDir, "win32-x64")).toEqual([
      ".staging-linux-x64-abc",
      "linux-arm64",
      "linux-x64",
    ]);
    expect(readdirSync(nodeDir).sort()).toEqual(["README.md", "node.lock.json", "win32-x64"]);
  });

  it("is a no-op when only the target runtime is installed", () => {
    const { nodeDir } = fixture(["linux-x64"]);

    expect(pruneForeignRuntimes(nodeDir, "linux-x64")).toEqual([]);
    expect(readdirSync(nodeDir).sort()).toEqual(["README.md", "linux-x64", "node.lock.json"]);
  });
});
