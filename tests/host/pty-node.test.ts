import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadNodePty,
  nativeCandidatePaths,
  summarizeNativeFailure,
  type NodePtyModule,
  type NodePtyProcess,
} from "../../src/host/pty-node";
import type { TerminalNativeCandidate } from "../../src/shared/terminal-protocol";

const roots: string[] = [];

function tempModuleDir(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-pty-load-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeProcess(): NodePtyProcess {
  return {
    pid: 4242,
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
    write: () => undefined,
    resize: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    kill: () => undefined,
  };
}

const GLIBC: TerminalNativeCandidate = {
  path: "/app/node-pty/build/Release/pty.node",
  error: "/lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.42' not found",
};
const MISSING: TerminalNativeCandidate = {
  path: "/app/node-pty/prebuilds/linux-x64/pty.node",
  error: "Cannot find module '/app/node-pty/prebuilds/linux-x64/pty.node'",
};

describe("nativeCandidatePaths", () => {
  it("mirrors node-pty's own load order", () => {
    expect(nativeCandidatePaths("/app/node_modules/node-pty", "linux", "x64")).toEqual([
      join("/app/node_modules/node-pty", "build", "Release", "pty.node"),
      join("/app/node_modules/node-pty", "build", "Debug", "pty.node"),
      join("/app/node_modules/node-pty", "prebuilds", "linux-x64", "pty.node"),
    ]);
  });
});

describe("summarizeNativeFailure", () => {
  it("prefers the real dlopen error over the missing-module noise", () => {
    expect(summarizeNativeFailure([MISSING, GLIBC], "fallback")).toBe(GLIBC.error);
  });

  it("falls back to the import failure when every candidate is absent", () => {
    expect(summarizeNativeFailure([MISSING], "Cannot find package 'node-pty'")).toBe(
      "Cannot find package 'node-pty'",
    );
  });

  it("copes with an empty candidate list", () => {
    expect(summarizeNativeFailure([], "boom")).toBe("boom");
  });
});

describe("loadNodePty", () => {
  it("never rejects and reports every probed path when the import fails", async () => {
    const moduleDir = tempModuleDir();
    const load = await loadNodePty({
      moduleDir,
      platform: "linux",
      arch: "x64",
      importer: async () => {
        throw new Error("dlopen(pty.node): invalid ELF header");
      },
    });

    expect(load.ok).toBe(false);
    if (load.ok) return;
    expect(load.error).toBe("dlopen(pty.node): invalid ELF header");
    expect(load.candidates.map((candidate) => candidate.path)).toEqual(
      nativeCandidatePaths(moduleDir, "linux", "x64"),
    );
    for (const candidate of load.candidates) {
      expect(candidate.error).toMatch(/Cannot find module/);
    }
  });

  it("headlines the first non-ENOENT error from the probes", async () => {
    // A directory with a real file at build/Release/pty.node: `require` fails
    // with an ELF error (not MODULE_NOT_FOUND), which must win over the
    // prebuilds ENOENT — this is the 0.8.0 Linux shape.
    const moduleDir = tempModuleDir();
    const release = join(moduleDir, "build", "Release");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(release, { recursive: true });
    writeFileSync(join(release, "pty.node"), "not an elf");

    const load = await loadNodePty({
      moduleDir,
      platform: "linux",
      arch: "x64",
      importer: async () => {
        throw new Error("Failed to load native module: pty.node");
      },
    });

    expect(load.ok).toBe(false);
    if (load.ok) return;
    const releaseError = load.candidates[0]?.error ?? "";
    expect(releaseError).not.toMatch(/Cannot find module/);
    expect(load.error).toBe(releaseError);
  });

  it("returns a working port when node-pty loads", async () => {
    const calls: Array<{ shell: string; args: string[]; encoding: unknown }> = [];
    const module: NodePtyModule = {
      spawn: (shell, args, options) => {
        calls.push({ shell, args, encoding: options.encoding });
        return fakeProcess();
      },
    };

    const load = await loadNodePty({
      moduleDir: tempModuleDir(),
      platform: "linux",
      arch: "x64",
      importer: async () => module,
    });

    expect(load.ok).toBe(true);
    if (!load.ok) return;
    expect(load.path).toBeNull();
    expect(load.candidates).toEqual([]);
    const pty = load.port.spawn({
      shell: "/bin/bash",
      args: ["-l"],
      cwd: "/work",
      env: { TERM: "xterm-256color" },
      cols: 80,
      rows: 24,
      name: "xterm-256color",
    });
    expect(pty.pid).toBe(4242);
    expect(calls).toEqual([{ shell: "/bin/bash", args: ["-l"], encoding: null }]);
  });

  it("rejects a module without spawn()", async () => {
    const load = await loadNodePty({
      moduleDir: tempModuleDir(),
      importer: async () => ({ default: "nope" }),
    });
    expect(load.ok).toBe(false);
    if (load.ok) return;
    expect(load.error).toBe("node-pty did not export spawn()");
  });
});
