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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveAppRuntime } from "../../src/main/runtime/environment";
import { SERVICE_ENV } from "../../src/shared/host-protocol";
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
    npmPayload?: Record<string, { path?: string; sha256: string }>;
  };
};

const target = runtimeTarget(process.platform, process.arch);

/**
 * The app injects `PI_DESKTOP_*` into every child it spawns (this suite can be
 * run from inside Pi Desktop). These checks are about the runtime on disk and a
 * clean machine, so both resolution and spawning start from the app's variables
 * removed. The load-bearing one is `PI_DESKTOP_HOST_MODE=service`: inherited,
 * the host bundle starts the JSONL service loop instead of the CLI, so
 * `pi --version` exits 0 with no output.
 */
function withoutAppEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  delete clean.PI_DESKTOP_NODE;
  delete clean.PI_DESKTOP_NPM_CLI;
  delete clean.PI_DESKTOP_RUNTIME_DIR;
  delete clean.PI_DESKTOP_HOST_ENTRY;
  delete clean[SERVICE_ENV];
  delete clean.PI_DESKTOP_SESSION_ID;
  return clean;
}

const resolution = resolveAppRuntime({
  isPackaged: false,
  resourcesPath: runtimeRoot,
  appRoot: repoRoot,
  env: withoutAppEnv(process.env),
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
  return { ...withoutAppEnv(process.env), PATH: resolution.binDir };
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

/**
 * Runs a shim and, when it fails, re-raises the failure with the information
 * needed to place the bug: the host platform, the runtime that was installed in
 * the repo (a foreign-platform one is the classic cause — the live shim tests
 * only mean anything on the platform whose runtime is installed), and the
 * interp that actually failed.
 */
function expectShimOk(name: ShimName, args: string[]): ShimResult {
  const result = runShim(name, args);
  if (result.status !== 0) {
    const installed = readdirSync(join(runtimeRoot, "node"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const expected = shimFileName(name, process.platform);
    throw new Error(
      [
        `\`${expected}${args.length > 0 ? ` ${args.join(" ")}` : ""}\` exited ${result.status}`,
        `  host        ${target} (a foreign runtime cannot be executed here)`,
        `  installed   ${installed.join(", ") || "none"}`,
        `  shim dir    ${resolution.binDir}`,
        `  stderr      ${result.stderr.trim() || "(empty)"}`,
      ].join("\n"),
    );
  }
  return result;
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

  it("pins the npm payload digest that verifies a foreign-platform runtime", () => {
    // A runtime for another platform can never be executed on this host, so
    // `runtime:fetch` verifies it against this digest instead. Without it, a
    // Linux installer could not be produced from a Windows machine at all (and
    // installOne would hard-fail on any non-host platform).
    const payload = lock.node.npmPayload;
    expect(payload, "node.lock.json must carry node.npmPayload").toBeDefined();
    const digests = new Set<string>();
    for (const platform of ["win32", "linux", "darwin"]) {
      const entry = payload?.[platform];
      expect(entry, platform).toBeDefined();
      expect(entry?.sha256, platform).toMatch(/^[0-9a-f]{64}$/);
      expect(entry?.path, platform).toBeTruthy();
      if (entry) digests.add(entry.sha256);
    }
    // One npm release is one payload: Windows ships it with CRLF, so the digest
    // has to be taken over normalised text or the platforms would disagree.
    expect(digests.size).toBe(1);
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
        env: strippedEnv(),
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
    const result = expectShimOk("node", ["--version"]);
    expect(result.stdout.trim()).toBe(`v${lock.node.version}`);
  });

  it(
    "resolves `pi --version` through the shim with no system Node on PATH",
    () => {
      const result = expectShimOk("pi", ["--version"]);
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "resolves `npm --version` through the bundled npm with no system Node on PATH",
    () => {
      const result = expectShimOk("npm", ["--version"]);
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "resolves `npx --version` through the bundled npm with no system Node on PATH",
    () => {
      const result = expectShimOk("npx", ["--version"]);
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    },
    SPAWN_TIMEOUT_MS,
  );
});
