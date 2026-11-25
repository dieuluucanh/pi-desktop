import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  REQUIRED_PARITY_COMMANDS,
  REQUIRED_REFINEMENT_COMMANDS,
  checkPackagedArtifact,
  contributedCommands,
  packagedEnv,
  packagedPaths,
  parseVerifyArgs,
  resourcesDirFor,
  workflowRegistrations,
} from "../../scripts/verify-packaged-workflow.mjs";
import { WORKFLOW_STAGE_DIR, WORKFLOW_LOCK_FILE } from "../../scripts/workflow-bundle.mjs";

/**
 * The packaged Workflow acceptance harness (plan step 39).
 *
 * A real package cannot be built inside a unit test, so these assertions pin the
 * parts that *decide* whether a package passes: the layout it reads, the
 * deliberately hostile environment every spawned binary gets, the "exactly one
 * Workflow registration" rule, and the artifact check against the lock. The real
 * package run is recorded separately in
 * `docs/architecture/packaged-workflow-acceptance-2026-11-24.md`.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lock = JSON.parse(readFileSync(join(repoRoot, WORKFLOW_LOCK_FILE), "utf8"));

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-packaged-test-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe("verify-packaged-workflow arguments", () => {
  it("requires a package location and validates platform/arch/timeout", () => {
    expect(() => parseVerifyArgs([])).toThrow(/--dir <app-out-dir> or --resources/);
    expect(() => parseVerifyArgs(["--dir", "release/win-unpacked", "--platform", "aix"])).toThrow(
      /unsupported --platform/,
    );
    expect(() => parseVerifyArgs(["--dir", "x", "--arch", "ia32"])).toThrow(/unsupported --arch/);
    expect(() => parseVerifyArgs(["--dir", "x", "--timeout", "0"])).toThrow(/positive integer/);
  });

  it("accepts an unpacked app dir or a resources dir and defaults to this machine", () => {
    const parsed = parseVerifyArgs(["--dir", "release/win-unpacked"]);
    expect(parsed).toMatchObject({
      help: false,
      resources: null,
      dir: "release/win-unpacked",
      platform: process.platform,
      arch: process.arch,
      timeoutMs: 60_000,
      keep: false,
      json: false,
    });
    expect(parseVerifyArgs(["--help"])).toEqual({ help: true });
  });
});

describe("packaged layout", () => {
  it("reads `<dir>/resources` but accepts a resources dir directly", () => {
    const appDir = tempDir();
    expect(resourcesDirFor(appDir)).toBe(resolve(appDir));
    cpSync(join(repoRoot, WORKFLOW_LOCK_FILE), join(appDir, "marker"), { dereference: true });
    // A nested `resources` directory is what electron-builder produces.
    mkdirSync(join(appDir, "resources"), { recursive: true });
    expect(resourcesDirFor(appDir)).toBe(join(resolve(appDir), "resources"));
  });

  it("derives the bundled Node, host bundle and Pi CLI for each platform", () => {
    const win = packagedPaths("C:\\app\\resources", "win32", "x64");
    expect(win.nodePath.endsWith(join("runtime", "node", "win32-x64", "node.exe"))).toBe(true);
    expect(win.hostBundle.endsWith(join("app.asar.unpacked", "out", "host", "index.mjs"))).toBe(
      true,
    );
    expect(win.piCliPath).toContain(join("pi-coding-agent", "dist", "bundle", "cli.js"));
    expect(win.extensionsDir.endsWith(join("extensions", "workflow"))).toBe(true);

    const linux = packagedPaths("/app/resources", "linux", "arm64");
    expect(linux.nodePath.endsWith(join("runtime", "node", "linux-arm64", "bin", "node"))).toBe(
      true,
    );

    const mac = packagedPaths("/app/resources", "darwin", "x64");
    expect(mac.nodePath.endsWith(join("runtime", "node", "darwin-x64", "bin", "node"))).toBe(true);
  });
});

describe("packaged environment", () => {
  it("hides every developer toolchain and points the network at a closed port", () => {
    const dir = tempDir();
    const env = packagedEnv({
      tempDir: dir,
      agentDir: join(dir, "agent"),
      blobDir: join(dir, "blobs"),
      platform: "win32",
    });
    // One empty directory: a system `pi`, `node` or `npm` cannot be found.
    const pathEntry = env.PATH ?? "";
    expect(dirname(pathEntry)).toBe(dir);
    expect(pathEntry.endsWith("empty-path")).toBe(true);
    expect(env.HOME).toBe(join(dir, "home"));
    expect(env.PI_CODING_AGENT_DIR).toBe(join(dir, "agent"));
    expect(env.PI_DESKTOP_SAFE_MODE).toBe("0");
    expect(env.PI_DESKTOP_WORKFLOW_BUNDLE_DIR).toBeUndefined();
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
      expect(env[key]).toBe("http://127.0.0.1:9");
    }
    // Nothing from the caller's profile leaks in.
    expect(env.PI_DESKTOP_PI_CLI).toBeUndefined();
    expect(env.PI_DESKTOP_NODE).toBeUndefined();
  });

  it("carries safe mode and an explicit bundle override only when asked", () => {
    const dir = tempDir();
    const env = packagedEnv({
      tempDir: dir,
      agentDir: join(dir, "agent"),
      blobDir: join(dir, "blobs"),
      bundleDir: join(dir, "override"),
      safeMode: true,
      platform: "linux",
    });
    expect(env.PI_DESKTOP_SAFE_MODE).toBe("1");
    expect(env.PI_DESKTOP_WORKFLOW_BUNDLE_DIR).toBe(join(dir, "override"));
    expect((env.PATH ?? "").endsWith("empty-path")).toBe(true);
  });
});

describe("registration counting", () => {
  function row(overrides: Record<string, unknown>) {
    return {
      kind: "extensions",
      name: "workflow",
      path: "builtin:workflow",
      enabled: true,
      ...overrides,
    };
  }

  it("counts the builtin row as the one Workflow registration", () => {
    const registrations = workflowRegistrations({
      resources: [
        row({ builtin: { name: "workflow", version: "0.13.0" }, overridePath: "builtin:workflow" }),
        row({ kind: "skills", name: "workflow", path: "C:/x/skills/workflow" }),
      ],
    });
    expect(registrations).toHaveLength(1);
  });

  it("counts an installed copy too, so a double load is never mistaken for one", () => {
    const registrations = workflowRegistrations({
      resources: [
        row({ builtin: { name: "workflow" }, overridePath: "builtin:workflow" }),
        row({
          name: "index.ts",
          path: "C:/profile/extensions/workflow/index.ts",
          overridePath: "C:/profile/extensions/workflow/index.ts",
        }),
      ],
    });
    expect(registrations).toHaveLength(2);
  });

  it("ignores unrelated extensions and returns only command names", () => {
    expect(
      workflowRegistrations({
        resources: [row({ name: "checkpoint", path: "C:/x/checkpoint.ts", builtin: undefined })],
      }),
    ).toHaveLength(0);
    expect(
      contributedCommands({
        contributed: [
          { kind: "command", name: "prompt" },
          { kind: "tool", name: "todo" },
          { kind: "command", name: "" },
        ],
      }),
    ).toEqual(["prompt"]);
    expect(contributedCommands(null)).toEqual([]);
    expect(contributedCommands({})).toEqual([]);
  });

  it("names the refinement and parity surfaces the package must advertise", () => {
    expect(REQUIRED_REFINEMENT_COMMANDS).toContain("prompt");
    expect(REQUIRED_REFINEMENT_COMMANDS).toContain("prompt-refine-companion");
    expect(REQUIRED_PARITY_COMMANDS).toContain("workflow-cycle");
    expect(REQUIRED_PARITY_COMMANDS).toContain("review");
    expect(REQUIRED_PARITY_COMMANDS).toContain("orchestrator");
    expect(REQUIRED_PARITY_COMMANDS).not.toContain("review-abort");
    expect(new Set(REQUIRED_PARITY_COMMANDS).size).toBe(REQUIRED_PARITY_COMMANDS.length);
  });
});

describe("artifact check against the lock", () => {
  function stageCopy(): { dir: string; metadata: Record<string, unknown> } {
    const dir = join(tempDir(), "workflow");
    cpSync(join(repoRoot, WORKFLOW_STAGE_DIR), dir, { recursive: true });
    return { dir, metadata: JSON.parse(readFileSync(join(dir, "workflow-bundle.json"), "utf8")) };
  }

  it("accepts the pinned staged copy", () => {
    const { dir, metadata } = stageCopy();
    expect(checkPackagedArtifact({ extensionsDir: dir, lock, metadata })).toEqual([]);
  });

  it("fails a stale or edited module instead of trusting the metadata", () => {
    const { dir, metadata } = stageCopy();
    writeFileSync(
      join(dir, "index.ts"),
      `${readFileSync(join(dir, "index.ts"), "utf8")}\n// edited\n`,
    );
    const problems = checkPackagedArtifact({ extensionsDir: dir, lock, metadata });
    expect(problems.join("\n")).toMatch(/does not match its recorded hash/);
  });

  it("fails a manifest that tries to add an install hook or a runtime dependency", () => {
    const { dir } = stageCopy();
    const manifestPath = join(dir, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(
      manifestPath,
      JSON.stringify({
        ...manifest,
        scripts: { postinstall: "node evil.mjs" },
        dependencies: { evil: "1" },
      }),
    );
    const edited = JSON.parse(readFileSync(join(dir, "workflow-bundle.json"), "utf8"));
    // Re-hash the edited manifest so the file check passes; the policy check must
    // still refuse it.
    edited.files = (edited.files as Array<{ path: string; sha256: string }>).map((file) =>
      file.path === "package.json"
        ? {
            path: file.path,
            sha256: createHash("sha256").update(readFileSync(manifestPath)).digest("hex"),
          }
        : file,
    );
    edited.manifest = { ...edited.manifest, scripts: { postinstall: "node evil.mjs" } };
    const problems = checkPackagedArtifact({ extensionsDir: dir, lock, metadata: edited });
    expect(problems.join("\n")).toMatch(/lifecycle|runtime dependencies/);
  });

  it("reports a missing or unreadable bundle instead of claiming success", () => {
    const problems = checkPackagedArtifact({
      extensionsDir: join(tempDir(), "absent"),
      lock,
      metadata: null,
    });
    expect(problems[0]).toMatch(/no staged Workflow bundle/);
  });
});
