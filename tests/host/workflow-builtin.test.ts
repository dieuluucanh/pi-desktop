import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  WORKFLOW_BUILTIN_DISABLE_ENTRY,
  WORKFLOW_BUILTIN_PATH,
  describeWorkflowBuiltinLoad,
  resolveWorkflowBuiltin,
  type WorkflowBuiltinResolution,
} from "../../src/host/workflow-builtin";
import { WORKFLOW_BUNDLE_METADATA } from "../../src/shared/workflow-bundle";

/**
 * The `builtin:workflow` decision (plan step 27).
 *
 * The app registers the staged Workflow artifact under Pi's named-builtin
 * mechanism; these tests pin the decision half: safe mode registers nothing,
 * a missing/invalid artifact is reported (never replaced by a checkout), and a
 * valid one reports its pinned version/source/integrity plus the replaceability
 * gate. Whether the SDK then loads it is tested against the real loader.
 */

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wf-builtin-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function metadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    package: "@dieulc/workflow",
    version: "0.13.0",
    entry: "index.ts",
    license: "MIT",
    integrity: "sha512-abc=",
    hostPeers: ["@earendil-works/pi-coding-agent", "typebox"],
    files: [
      { path: "index.ts", sha256: "a".repeat(64) },
      { path: "LICENSE", sha256: "b".repeat(64) },
    ],
    ...overrides,
  };
}

/** A resolution shape that is already "registered", for the load-report tests. */
function registered(): WorkflowBuiltinResolution {
  return resolveWorkflowBuiltin({
    bundleDir: join("C:", "resources", "extensions", "workflow"),
    exists: () => true,
    readFile: () => JSON.stringify(metadata()),
  });
}

describe("builtin:workflow identity", () => {
  it("pins the resource path and the opt-out entry the settings array carries", () => {
    expect(WORKFLOW_BUILTIN_PATH).toBe("builtin:workflow");
    expect(WORKFLOW_BUILTIN_DISABLE_ENTRY).toBe("-builtin:workflow");
  });
});

describe("resolveWorkflowBuiltin", () => {
  it("registers nothing in safe mode, without reading the staged copy", () => {
    const reads: string[] = [];
    const resolution = resolveWorkflowBuiltin({
      safeMode: true,
      bundleDir: join("C:", "resources", "extensions", "workflow"),
      exists: (target) => {
        reads.push(target);
        return true;
      },
      readFile: (target) => {
        reads.push(target);
        return "{}";
      },
    });
    expect(resolution.registered).toBe(false);
    expect(resolution.disabledBy).toBe("safe-mode");
    expect(resolution.version).toBeNull();
    expect(resolution.source).toBeNull();
    expect(reads).toEqual([]);
  });

  it("reports a missing staged copy instead of falling back to a checkout", () => {
    const resolution = resolveWorkflowBuiltin({ bundleDir: null });
    expect(resolution.registered).toBe(false);
    expect(resolution.disabledBy).toBe("missing-bundle");
    expect(resolution.hint).toMatch(/npm run workflow:stage/);
    expect(resolution.problems.join(" ")).toMatch(/no staged Workflow bundle/);
  });

  it("reports a directory that disappeared between resolution and load", () => {
    const resolution = resolveWorkflowBuiltin({
      bundleDir: join("C:", "gone"),
      exists: () => false,
    });
    expect(resolution.registered).toBe(false);
    expect(resolution.disabledBy).toBe("missing-bundle");
    expect(resolution.problems[0]).toMatch(/does not exist/);
  });

  it("reports a staged directory without its metadata document", () => {
    const dir = join("C:", "resources", "extensions", "workflow");
    const resolution = resolveWorkflowBuiltin({
      bundleDir: dir,
      exists: (target) => target === dir,
    });
    expect(resolution.registered).toBe(false);
    expect(resolution.disabledBy).toBe("invalid-bundle");
    expect(resolution.problems[0]).toMatch(new RegExp(WORKFLOW_BUNDLE_METADATA));
  });

  it("refuses a hand-edited or truncated metadata document", () => {
    const dir = join("C:", "resources", "extensions", "workflow");
    for (const document of ["{", JSON.stringify(metadata({ schema: 2 })), JSON.stringify({})]) {
      const resolution = resolveWorkflowBuiltin({
        bundleDir: dir,
        exists: () => true,
        readFile: () => document,
      });
      expect(resolution.registered).toBe(false);
      expect(resolution.disabledBy).toBe("invalid-bundle");
      expect(resolution.problems[0]).toMatch(/invalid workflow-bundle\.json/);
    }
  });

  it("registers the verified copy with its pinned version, source and integrity", () => {
    const dir = join("C:", "resources", "extensions", "workflow");
    const resolution = resolveWorkflowBuiltin({
      bundleDir: dir,
      exists: () => true,
      readFile: () => JSON.stringify(metadata()),
    });
    expect(resolution).toMatchObject({
      name: "workflow",
      path: "builtin:workflow",
      packageName: "@dieulc/workflow",
      registered: true,
      version: "0.13.0",
      source: "bundled",
      dir,
      entryPath: join(dir, "index.ts"),
      integrity: "sha512-abc=",
      replaceable: true,
      disabledBy: null,
      problems: [],
      hint: null,
    });
  });

  it("leaves the replaceable gate switchable while the pin is unproven", () => {
    const resolution = resolveWorkflowBuiltin({
      bundleDir: join("C:", "resources", "extensions", "workflow"),
      exists: () => true,
      readFile: () => JSON.stringify(metadata()),
      replaceable: false,
    });
    expect(resolution.registered).toBe(true);
    expect(resolution.replaceable).toBe(false);
  });

  it("reads a real staged directory the same way the main resolver does", () => {
    const dir = tempDir();
    writeFileSync(join(dir, WORKFLOW_BUNDLE_METADATA), JSON.stringify(metadata()));
    writeFileSync(join(dir, "index.ts"), "export default function workflow() {}\n");
    const resolution = resolveWorkflowBuiltin({
      bundleDir: dir,
      exists: () => true,
      readFile: (target) => readFileSync(target, "utf8"),
    });
    expect(resolution.registered).toBe(true);
    expect(resolution.entryPath).toBe(join(dir, "index.ts"));
  });
});

describe("describeWorkflowBuiltinLoad", () => {
  it("reports a loaded builtin from the loader's own list", () => {
    expect(
      describeWorkflowBuiltinLoad(registered(), {
        loadedPaths: ["C:/ext/checkpoints/index.ts", "builtin:workflow"],
      }),
    ).toEqual({ state: "loaded", replacedBy: null, message: null });
  });

  it("reports replacement from Pi's warning rather than re-deriving the conflict", () => {
    const message =
      "Extension C:/profile/extensions/workflow/index.ts registers command `/workflow`, so built-in extension `workflow` was not loaded.";
    expect(
      describeWorkflowBuiltinLoad(registered(), {
        loadedPaths: ["C:/profile/extensions/workflow/index.ts"],
        warnings: [{ path: "builtin:workflow", warning: message }],
      }),
    ).toEqual({ state: "replaced", replacedBy: message, message });
  });

  it("distinguishes a user opt-out (not replaced) from a replacement", () => {
    expect(describeWorkflowBuiltinLoad(registered(), { loadedPaths: [], warnings: [] })).toEqual({
      state: "disabled",
      replacedBy: null,
      message: null,
    });
  });

  it("reports safe mode and an absent artifact without claiming a user opt-out", () => {
    expect(
      describeWorkflowBuiltinLoad(resolveWorkflowBuiltin({ safeMode: true }), { loadedPaths: [] })
        .state,
    ).toBe("safe-mode");
    expect(describeWorkflowBuiltinLoad(resolveWorkflowBuiltin({}), { loadedPaths: [] }).state).toBe(
      "absent",
    );
  });
});
