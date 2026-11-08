import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
    ) => {
      found: boolean;
      removed: string[];
      kept: string | null;
      binary: string | null;
      helper?: string | null;
      helperPatched?: boolean;
    };
  };

const roots: string[] = [];

function fixture(entries: string[] = []): { resources: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), "pi-pty-"));
  roots.push(base);
  const root = join(base, "app.asar.unpacked", "node_modules", "node-pty");
  const files = [
    "prebuilds/win32-x64/pty.node",
    "prebuilds/darwin-arm64/pty.node",
    "prebuilds/darwin-arm64/spawn-helper",
    "deps/src/unix/pty.cc",
    "third_party/conpty/x.dll",
    "scripts/prebuild.js",
    "lib/index.js",
    // node-pty 1.1.0's rewrite, verbatim: packing patches it to be idempotent.
    "lib/unixTerminal.js",
    "package.json",
    "pty.pdb",
    ...entries,
  ];
  for (const path of files) {
    const target = join(root, path);
    mkdirSync(join(target, ".."), { recursive: true });
    // A `.node` must be non-empty: a zero-byte binary is a failed copy, not a
    // usable native module.
    if (path === "lib/unixTerminal.js") {
      writeFileSync(
        target,
        [
          "var helperPath = native.dir + '/spawn-helper';",
          "helperPath = path.resolve(__dirname, helperPath);",
          "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
          "helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');",
          "",
        ].join("\n"),
      );
      continue;
    }
    writeFileSync(target, path.endsWith(".node") ? "native-binary" : "");
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
    expect(result).toMatchObject({
      found: true,
      kept: "win32-x64",
      binary: join(root, "prebuilds", "win32-x64", "pty.node"),
    });
    expect(readdirSync(join(root, "prebuilds"))).toEqual(["win32-x64"]);
    for (const name of ["deps", "third_party", "scripts", "pty.pdb"]) {
      expect(result.removed).toContain(name);
    }
    expect(result.removed).toContain("prebuilds/darwin-arm64");
    expect(readdirSync(root).sort()).toEqual(["lib", "package.json", "prebuilds"]);
  });

  it("accepts the pinned Linux prebuild and reports it", () => {
    const { resources, root } = fixture(["prebuilds/linux-x64/pty.node"]);
    const result = pruneNodePty(resources, "linux-x64");
    expect(result.kept).toBe("linux-x64");
    expect(result.binary).toBe(join(root, "prebuilds", "linux-x64", "pty.node"));
    expect(readdirSync(join(root, "prebuilds"))).toEqual(["linux-x64"]);
  });

  it("fails the package when the Linux tree still contains a runner build", () => {
    // node-pty checks build/Release before prebuilds, so shipping both would
    // load the binary compiled against the runner's (newer) glibc.
    const { resources } = fixture(["prebuilds/linux-x64/pty.node", "build/Release/pty.node"]);
    expect(() => pruneNodePty(resources, "linux-x64")).toThrow(/must ship the pinned prebuild/);
  });

  it("fails the package when no binary for the target survives", () => {
    const { resources } = fixture(["prebuilds/linux-x64/pty.node"]);
    // The fixture only holds win32/darwin prebuilds for a win target, so a
    // linux target with no Linux prebuild and no build/ output must throw.
    expect(() => pruneNodePty(resources, "win32-x64")).not.toThrow();
    expect(() => pruneNodePty(resources, "linux-arm64")).toThrow(
      /no usable binary for linux-arm64/,
    );
  });

  it("rejects a zero-byte binary instead of shipping it", () => {
    const { resources, root } = fixture();
    writeFileSync(join(root, "prebuilds", "win32-x64", "pty.node"), "");
    expect(() => pruneNodePty(resources, "win32-x64")).toThrow(/no usable binary/);
  });

  it("is a no-op when the package is absent", () => {
    const base = mkdtempSync(join(tmpdir(), "pi-pty-empty-"));
    roots.push(base);
    expect(pruneNodePty(base, "linux-x64")).toEqual({
      found: false,
      removed: [],
      kept: null,
      binary: null,
      helper: null,
      helperPatched: false,
    });
  });

  it("makes node-pty's macOS helper rewrite idempotent in the package", () => {
    // node-pty@1.1.0 appends `.unpacked` unconditionally, so a module that
    // already lives in app.asar.unpacked points macOS at
    // app.asar.unpacked.unpacked/spawn-helper and every open fails with
    // `posix_spawnp failed` (upstream PR #924).
    const { resources, root } = fixture();
    const result = pruneNodePty(resources, "darwin-arm64");
    expect(result.helperPatched).toBe(true);
    const source = readFileSync(join(root, "lib", "unixTerminal.js"), "utf8");
    expect(source).toContain("Pi Desktop: node-pty@1.1.0 rewrote app.asar");
    expect(source).toContain("!helperPath.includes('app.asar.unpacked')");
    expect(source).toContain("helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');");

    // A second pack of the same tree is a no-op, never a double patch.
    expect(pruneNodePty(resources, "darwin-arm64").helperPatched).toBe(false);
  });

  it("fails the package when node-pty's helper rewrite is gone", () => {
    // Fail closed: the upstream source changed, so the bug has to be
    // re-evaluated instead of silently shipping an unpatched helper path.
    const { resources, root } = fixture();
    writeFileSync(join(root, "lib", "unixTerminal.js"), "// upstream changed\n");
    expect(() => pruneNodePty(resources, "darwin-arm64")).toThrow(
      /no longer contains node-pty's helper rewrite/,
    );
  });

  it("makes the macOS spawn-helper executable", () => {
    // node-pty execs prebuilds/<target>/spawn-helper to allocate the PTY; the
    // npm tarball stores it 0644, so packaging re-applies 0755.
    const { resources, root } = fixture();
    const result = pruneNodePty(resources, "darwin-arm64");
    const helper = join(root, "prebuilds", "darwin-arm64", "spawn-helper");
    expect(result.helper).toBe(helper);
    if (process.platform !== "win32") {
      expect(statSync(helper).mode & 0o111).not.toBe(0);
    }
  });

  it("fails the macOS package when the spawn-helper is missing", () => {
    const { resources, root } = fixture();
    rmSync(join(root, "prebuilds", "darwin-arm64", "spawn-helper"), { force: true });
    expect(() => pruneNodePty(resources, "darwin-arm64")).toThrow(/no node-pty spawn-helper/);
  });
});
