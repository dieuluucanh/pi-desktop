import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The hook is plain ESM with inferred types; the runtime export is asserted here
// rather than importing the default (which is `afterPack`, not this helper).
const { pruneNodePty } =
  (await import("../../scripts/electron-builder-after-pack.mjs")) as unknown as {
    pruneNodePty: (
      resourcesDir: string,
      target: string,
    ) => { found: boolean; removed: string[]; kept: string | null };
  };

const roots: string[] = [];

function fixture(): { resources: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), "pi-pty-"));
  roots.push(base);
  const root = join(base, "app.asar.unpacked", "node_modules", "node-pty");
  for (const path of [
    "prebuilds/win32-x64/pty.node",
    "prebuilds/darwin-arm64/pty.node",
    "prebuilds/darwin-arm64/spawn-helper",
    "deps/src/unix/pty.cc",
    "third_party/conpty/x.dll",
    "scripts/prebuild.js",
    "lib/index.js",
    "package.json",
    "pty.pdb",
  ]) {
    const target = join(root, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "");
  }
  return { resources: base, root };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("pruneNodePty", () => {
  it("keeps only the target platform/arch prebuild and drops build-time files", () => {
    const { resources, root } = fixture();
    const result = pruneNodePty(resources, "win32-x64");
    expect(result).toMatchObject({ found: true, kept: "win32-x64" });
    expect(readdirSync(join(root, "prebuilds"))).toEqual(["win32-x64"]);
    for (const name of ["deps", "third_party", "scripts", "pty.pdb"]) {
      expect(result.removed).toContain(name);
    }
    expect(result.removed).toContain("prebuilds/darwin-arm64");
    expect(readdirSync(root).sort()).toEqual(["lib", "package.json", "prebuilds"]);
  });

  it("is a no-op when the package is absent", () => {
    const base = mkdtempSync(join(tmpdir(), "pi-pty-empty-"));
    roots.push(base);
    expect(pruneNodePty(base, "linux-x64")).toEqual({
      found: false,
      removed: [],
      kept: null,
    });
  });
});
