import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  WORKFLOW_BUNDLE_OVERRIDE_ENV,
  isUsableWorkflowBundle,
  parseWorkflowBundleMetadata,
  resolveWorkflowBundle,
  workflowBundleCandidates,
  type WorkflowBundleEnvironment,
} from "../../src/main/runtime/workflow-bundle";
import { findCheckoutReferences } from "../../scripts/workflow-bundle.mjs";

/**
 * The bundled Workflow location (plan step 26).
 *
 * The app must find the *staged* artifact in both layouts and must never fall
 * back to a `@dieulc/workflow` developer checkout. These tests use an injected
 * `exists`/`readFile` for the layout matrix, plus one real temp tree for the
 * document contract.
 */

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wf-bundle-resolver-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    schema: 1,
    package: "@dieulc/workflow",
    version: "0.13.0",
    entry: "index.ts",
    license: "MIT",
    integrity: "sha512-abc=",
    hostPeers: ["@earendil-works/pi-coding-agent", "typebox"],
    files: [{ path: "index.ts", sha256: "a".repeat(64) }],
    ...overrides,
  };
}

function env(overrides: Partial<WorkflowBundleEnvironment> = {}): WorkflowBundleEnvironment {
  return {
    isPackaged: true,
    resourcesPath: join("C:", "app", "resources"),
    appRoot: join("C:", "checkout"),
    env: {},
    exists: () => false,
    ...overrides,
  };
}

function stagedDirEnv(dir: string, extra: Partial<WorkflowBundleEnvironment> = {}) {
  const document = metadata();
  return env({
    exists: (target) =>
      target === dir ||
      target === join(dir, "workflow-bundle.json") ||
      target === join(dir, "index.ts"),
    readFile: () => JSON.stringify(document),
    ...extra,
  });
}

describe("workflowBundleCandidates", () => {
  it("prefers the packaged unpacked copy, then the extraResources copy", () => {
    const candidates = workflowBundleCandidates({
      isPackaged: true,
      resourcesPath: join("C:", "app", "resources"),
      appRoot: join("C:", "checkout"),
      env: {},
    });
    // Host peers resolve by walking up to `app.asar.unpacked/node_modules`, which
    // only the unpacked copy can reach on an installed machine (plan step 39).
    expect(candidates.map((candidate) => candidate.source)).toEqual(["packaged", "packaged"]);
    expect(candidates[0]?.dir).toBe(
      join("C:", "app", "resources", "app.asar.unpacked", "out", "extensions", "workflow"),
    );
    expect(candidates[1]?.dir).toBe(join("C:", "app", "resources", "extensions", "workflow"));
  });

  it("tries the staged source then the unpacked host-build copy in development", () => {
    const candidates = workflowBundleCandidates({
      isPackaged: false,
      resourcesPath: join("C:", "app", "resources"),
      appRoot: join("C:", "checkout"),
      env: {},
    });
    expect(candidates.map((candidate) => candidate.source)).toEqual(["dev-resources", "dev-out"]);
  });

  it("puts an explicit override first", () => {
    const candidates = workflowBundleCandidates({
      isPackaged: true,
      resourcesPath: join("C:", "app", "resources"),
      appRoot: join("C:", "checkout"),
      env: { [WORKFLOW_BUNDLE_OVERRIDE_ENV]: join("C:", "custom") },
    });
    expect(candidates[0]).toMatchObject({ source: "override", dir: join("C:", "custom") });
  });
});

describe("resolveWorkflowBundle", () => {
  it("resolves the packaged bundle when metadata and the entry exist", () => {
    const dir = join("C:", "app", "resources", "extensions", "workflow");
    const resolution = resolveWorkflowBundle(stagedDirEnv(dir));
    expect(resolution).toMatchObject({
      ok: true,
      source: "packaged",
      dir,
      entryPath: join(dir, "index.ts"),
    });
  });

  it("falls back to the extraResources copy when the unpacked one is absent", () => {
    const primary = join(
      "C:",
      "app",
      "resources",
      "app.asar.unpacked",
      "out",
      "extensions",
      "workflow",
    );
    const fallback = join("C:", "app", "resources", "extensions", "workflow");
    const resolution = resolveWorkflowBundle(stagedDirEnv(fallback));
    expect(resolution).toMatchObject({ ok: true, source: "packaged", dir: fallback });
    expect(primary).not.toBe(fallback);
  });

  it("parses the staged metadata through the optional reader", () => {
    const dir = join("C:", "app", "resources", "extensions", "workflow");
    const resolution = resolveWorkflowBundle(stagedDirEnv(dir));
    expect(resolution.ok).toBe(true);
    expect(resolution.metadata).toEqual(metadata());
    expect(isUsableWorkflowBundle(resolution)).toBe(true);
  });

  it("refuses a bundle whose metadata document is not the pinned schema", () => {
    const dir = join("C:", "app", "resources", "extensions", "workflow");
    const resolution = resolveWorkflowBundle(
      stagedDirEnv(dir, { readFile: () => '{"schema":99}' }),
    );
    expect(resolution.ok).toBe(false);
    expect(resolution.problems.join(" ")).toContain("invalid workflow-bundle.json");
  });

  it("never invents a checkout path when nothing is staged", () => {
    const resolution = resolveWorkflowBundle(env({ exists: () => false }));
    expect(resolution.ok).toBe(false);
    expect(resolution.dir).toBeNull();
    expect(resolution.problems.join(" ")).not.toContain("agent/extensions/workflow");
    expect(resolution.hint).toContain("workflow:stage");
  });

  it("reports a missing entry instead of loading half a bundle", () => {
    const dir = join("C:", "app", "resources", "extensions", "workflow");
    const resolution = resolveWorkflowBundle(
      env({ exists: (target) => target === dir || target === join(dir, "workflow-bundle.json") }),
    );
    expect(resolution.ok).toBe(false);
    expect(resolution.problems.join(" ")).toContain("has no index.ts");
  });

  it("reports a missing metadata document", () => {
    const dir = join("C:", "app", "resources", "extensions", "workflow");
    const resolution = resolveWorkflowBundle(env({ exists: (target) => target === dir }));
    expect(resolution.ok).toBe(false);
    expect(resolution.problems.join(" ")).toContain("workflow-bundle.json");
  });
});

describe("parseWorkflowBundleMetadata", () => {
  it("accepts the pinned document", () => {
    expect(parseWorkflowBundleMetadata(metadata())).toEqual(metadata());
  });

  it.each([
    ["wrong schema", metadata({ schema: 2 })],
    ["wrong package", metadata({ package: "@dieulc/other" })],
    ["empty version", metadata({ version: "" })],
    ["wrong entry", metadata({ entry: "main.js" })],
    ["non-sha512 integrity", metadata({ integrity: "sha256-abc" })],
    ["empty peers", metadata({ hostPeers: [] })],
    ["no files", metadata({ files: [] })],
    ["unsafe file path", metadata({ files: [{ path: "../index.ts", sha256: "a".repeat(64) }] })],
    ["bad file hash", metadata({ files: [{ path: "index.ts", sha256: "nope" }] })],
    ["entry not listed", metadata({ files: [{ path: "helper.ts", sha256: "a".repeat(64) }] })],
  ])("rejects %s", (_label, document) => {
    expect(parseWorkflowBundleMetadata(document)).toBeNull();
  });
});

describe("the staged document on disk", () => {
  it("resolves a real temp tree through the override without a checkout", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "workflow-bundle.json"), `${JSON.stringify(metadata(), null, 2)}\n`);
    writeFileSync(join(dir, "index.ts"), "export default () => undefined;\n");
    const resolution = resolveWorkflowBundle({
      isPackaged: false,
      resourcesPath: join("C:", "app", "resources"),
      appRoot: join("C:", "checkout"),
      env: { [WORKFLOW_BUNDLE_OVERRIDE_ENV]: dir },
      exists: existsSync,
      readFile: (target) => readFileSync(target, "utf8"),
    });
    expect(resolution).toMatchObject({ ok: true, source: "override", dir });
    expect(isUsableWorkflowBundle(resolution)).toBe(true);
  });
});

describe("checkout references", () => {
  it("ignores a path in a comment but flags a path literal", () => {
    const files = ["a.ts"];
    expect(
      findCheckoutReferences(files, () => "// C:\\Users\\RUNNER~1\\tmp\nconst ok = 1;\n"),
    ).toEqual([]);
    expect(findCheckoutReferences(files, () => 'const path = "C:\\Users\\x";\n')).toEqual([
      { file: "a.ts", needle: "C:\\Users\\" },
    ]);
  });
});
