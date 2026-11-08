import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  hostPaths,
  parseVerifyArgs,
  resourcesDirFor,
  runtimeTarget,
} from "../../scripts/verify-packaged-terminal.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const checksWorkflow = readFileSync(join(repoRoot, ".github/workflows/checks.yml"), "utf8").replace(
  /\r\n/g,
  "\n",
);

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("parseVerifyArgs", () => {
  it("requires --resources or --dir", () => {
    expect(() => parseVerifyArgs([])).toThrow(/--resources .* or --dir/);
  });

  it("defaults to the host platform/arch and a 20 s timeout", () => {
    const options = parseVerifyArgs(["--dir", "release/linux-unpacked"]);
    expect(options).toMatchObject({
      resources: null,
      dir: "release/linux-unpacked",
      node: null,
      shell: null,
      platform: process.platform,
      arch: process.arch,
      timeoutMs: 20_000,
    });
  });

  it("accepts the container-friendly overrides", () => {
    const options = parseVerifyArgs([
      "--resources",
      "/app/resources",
      "--node",
      "/app/resources/runtime/node/linux-x64/bin/node",
      "--shell",
      "/bin/sh",
      "--cwd",
      "/",
      "--platform",
      "linux",
      "--arch",
      "x64",
      "--timeout",
      "5000",
    ]);
    expect(options).toMatchObject({
      resources: "/app/resources",
      node: "/app/resources/runtime/node/linux-x64/bin/node",
      shell: "/bin/sh",
      cwd: "/",
      platform: "linux",
      arch: "x64",
      timeoutMs: 5000,
    });
  });

  it("rejects an unknown platform, arch or timeout", () => {
    expect(() => parseVerifyArgs(["--dir", "x", "--platform", "freebsd"])).toThrow(/platform/);
    expect(() => parseVerifyArgs(["--dir", "x", "--arch", "ia32"])).toThrow(/arch/);
    expect(() => parseVerifyArgs(["--dir", "x", "--timeout", "0"])).toThrow(/timeout/);
  });
});

describe("resourcesDirFor", () => {
  it("prefers <dir>/resources and otherwise treats the dir as resources", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-terminal-smoke-"));
    roots.push(root);
    mkdirSync(join(root, "resources"), { recursive: true });
    expect(resourcesDirFor(root)).toBe(join(root, "resources"));
    expect(resourcesDirFor(join(root, "elsewhere"))).toBe(join(root, "elsewhere"));
  });
});

describe("hostPaths", () => {
  it("uses the <platform>-<arch> runtime and the platform's node name", () => {
    expect(runtimeTarget("linux", "arm64")).toBe("linux-arm64");
    expect(hostPaths("/app/resources", "linux", "x64")).toEqual({
      hostBundle: join("/app/resources", "app.asar.unpacked", "out", "host", "terminal.mjs"),
      nodePath: join("/app/resources", "runtime", "node", "linux-x64", "bin", "node"),
    });
    expect(hostPaths("/app/resources", "win32", "x64").nodePath).toBe(
      join("/app/resources", "runtime", "node", "win32-x64", "node.exe"),
    );
    expect(hostPaths("/app/resources", "darwin", "arm64").nodePath).toBe(
      join("/app/resources", "runtime", "node", "darwin-arm64", "bin", "node"),
    );
  });
});

describe("checks workflow", () => {
  it("requires the real PTY test and the pinned build", () => {
    // A skipped integration test is how the 0.8.0 Linux terminal shipped
    // untested. The bundle is built first and the flag makes a missing one a
    // failure; the env is scoped to the test step on purpose.
    expect(checksWorkflow).toContain("npm run build:host");
    expect(checksWorkflow).toContain("check-native-terminal.mjs");
    expect(checksWorkflow).toMatch(
      /Unit \+ integration tests\n\s+env:\n\s+PI_REQUIRE_TERMINAL_HOST: "1"\n\s+run: npm test/,
    );
    // The release's container build is exercised on every PR, not only at tag
    // time.
    expect(checksWorkflow).toContain("npm run pty:linux -- --arch x64 --force");
    expect(checksWorkflow).toContain("npm run pty:linux -- --check-only --arch x64");
    expect(checksWorkflow).toContain("if: matrix.os == 'ubuntu-latest'");
  });
});
