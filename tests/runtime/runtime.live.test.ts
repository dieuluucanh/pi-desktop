/**
 * Runtime acceptance check — `npm run runtime:verify`.
 *
 * Proves the bundled runtime is installed, verifiable and usable *without any
 * system Node/npm*: the shims are executed with a PATH that contains nothing but
 * the shim directory, which is exactly the situation on a machine that has never
 * seen Node (plan step 2 acceptance).
 *
 *   npx vitest run tests/runtime/runtime.live.test.ts --disable-console-intercept
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveAppRuntime } from "../../src/main/runtime/environment";
import {
  meetsMinimumNodeVersion,
  runtimeTarget,
  shimFileName,
  type ShimName,
} from "../../src/main/runtime/layout";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const runtimeRoot = join(repoRoot, "resources", "runtime");
const lock = JSON.parse(readFileSync(join(runtimeRoot, "node.lock.json"), "utf8")) as {
  node: {
    version: string;
    minimumEngine: string;
    artifacts: Record<string, { sha256: string; archive: string }>;
  };
};

const target = runtimeTarget(process.platform, process.arch);
const resolution = resolveAppRuntime({
  isPackaged: false,
  resourcesPath: runtimeRoot,
  appRoot: repoRoot,
});

/**
 * First start of a host on Windows can take >10 s on a cold file cache (Defender
 * and NTFS scanning thousands of SDK files), so every spawn gets a wide timeout.
 */
const SPAWN_TIMEOUT_MS = 90_000;

/**
 * `npm test` runs anywhere (CI has no fetched runtime, so these suites skip).
 * `npm run runtime:verify` sets the flag and turns a missing runtime into a
 * hard failure — that is the acceptance check for plan step 2.
 */
const runtimeReady = resolution.ok && existsSync(resolution.piHostPath);
const runtimeRequired = process.env.PI_DESKTOP_REQUIRE_RUNTIME === "1";

/** A PATH containing only the shim directory: no system node, no system npm. */
function strippedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: resolution.binDir };
  delete env.PI_DESKTOP_NODE;
  delete env.PI_DESKTOP_HOST_ENTRY;
  return env;
}

interface ShimResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runShim(name: ShimName, args: string[]): ShimResult {
  const file = join(resolution.binDir, shimFileName(name, process.platform));
  const env = strippedEnv();

  if (process.platform === "win32") {
    // Hand cmd.exe one pre-quoted command string: passing an args array with
    // `shell: true` is deprecated (Node DEP0190) because it concatenates.
    const command = `"${file}"${args.length > 0 ? ` ${args.map((arg) => `"${arg}"`).join(" ")}` : ""}`;
    const result = spawnSync(command, {
      shell: true,
      env,
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  const result = spawnSync(file, args, { env, encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("pinned runtime lock", () => {
  it("records a checksum for every supported target and respects the Pi engine gate", () => {
    expect(lock.node.minimumEngine).toBe("22.19.0");
    expect(meetsMinimumNodeVersion(lock.node.version)).toBe(true);

    for (const platform of [
      "win32-x64",
      "win32-arm64",
      "darwin-arm64",
      "darwin-x64",
      "linux-x64",
      "linux-arm64",
    ]) {
      const artifact = lock.node.artifacts[platform];
      expect(artifact, `${platform} must be pinned`).toBeDefined();
      expect(artifact?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact?.archive).toContain(`v${lock.node.version}`);
    }
  });
});

describe.runIf(runtimeRequired)("require-runtime gate (runtime:verify)", () => {
  it("the bundled runtime and the built host bundle are present", () => {
    expect(resolution.ok, resolution.problems.join("; ")).toBe(true);
    expect(resolution.source).toBe("bundled");
    expect(
      existsSync(resolution.piHostPath),
      `${resolution.piHostPath} — run npm run build:host`,
    ).toBe(true);
    expect(existsSync(resolution.binDir), `${resolution.binDir} — run npm run runtime:fetch`).toBe(
      true,
    );
  });
});

describe.skipIf(!runtimeReady)("resolved runtime (live)", () => {
  it("resolves the bundled runtime for this machine", () => {
    expect(resolution.problems.join(" ")).not.toContain("no bundled runtime");
    expect(resolution.ok).toBe(true);
    expect(resolution.source).toBe("bundled");
    expect(resolution.nodeVersion).toBe(lock.node.version);
    expect(resolution.nodePath).not.toBeNull();
    expect(existsSync(resolution.piHostPath)).toBe(true);
  });

  it("runs the pinned node", () => {
    const result = spawnSync(resolution.nodePath ?? "", ["--version"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`v${lock.node.version}`);
  });

  it(
    "runs the Pi host bundle, which delegates to the Pi CLI (plan D16)",
    () => {
      const result = spawnSync(resolution.nodePath ?? "", [resolution.piHostPath, "--version"], {
        encoding: "utf8",
        timeout: SPAWN_TIMEOUT_MS,
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe.skipIf(!runtimeReady)("PATH shims (live)", () => {
  it(`installs all four shims for ${target}`, () => {
    for (const name of ["pi", "node", "npm", "npx"] as ShimName[]) {
      expect(
        existsSync(join(resolution.binDir, shimFileName(name, process.platform))),
        `${name} shim`,
      ).toBe(true);
    }
  });

  it("resolves `node --version` through the shim with no system Node on PATH", () => {
    const result = runShim("node", ["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`v${lock.node.version}`);
  });

  it(
    "resolves `pi --version` through the shim with no system Node on PATH",
    () => {
      const result = runShim("pi", ["--version"]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "resolves `npm --version` through the bundled npm with no system Node on PATH",
    () => {
      const result = runShim("npm", ["--version"]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "resolves `npx --version` through the bundled npm with no system Node on PATH",
    () => {
      const result = runShim("npx", ["--version"]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    },
    SPAWN_TIMEOUT_MS,
  );
});
