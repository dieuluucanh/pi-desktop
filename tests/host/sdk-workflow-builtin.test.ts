import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  workflowBuiltinExtensions,
  workflowBuiltinFactory,
  workflowBuiltinLoaderOptions,
} from "../../src/host/sdk/workflow-builtin";
import {
  WORKFLOW_BUILTIN_PATH,
  resolveWorkflowBuiltin,
  type WorkflowBuiltinResolution,
} from "../../src/host/workflow-builtin";
import { WORKFLOW_BUNDLE_METADATA } from "../../src/shared/workflow-bundle";

/**
 * The SDK adapter for `builtin:workflow` (plan step 27).
 *
 * These tests pin the *shape* Pi's loader needs: a named, hidden-by-Pi builtin
 * with the replaceability flag from the pure decision, and a factory that does
 * nothing but delegate to the staged artifact's default export. Loading the
 * real artifact (and the replacement/opt-out behaviour) is covered by the
 * loader-level suite.
 */

function resolution(overrides: { registered?: boolean; replaceable?: boolean } = {}) {
  const resolved = resolveWorkflowBuiltin({
    bundleDir: join("C:", "resources", "extensions", "workflow"),
    exists: () => true,
    readFile: () =>
      JSON.stringify({
        schema: 1,
        package: "@dieulc/workflow",
        version: "0.13.0",
        entry: "index.ts",
        license: "MIT",
        integrity: "sha512-abc=",
        hostPeers: ["typebox"],
        files: [{ path: "index.ts", sha256: "a".repeat(64) }],
      }),
    ...(overrides.replaceable === undefined ? {} : { replaceable: overrides.replaceable }),
  });
  if (overrides.registered === false) {
    return resolveWorkflowBuiltin({});
  }
  return resolved;
}

describe("workflowBuiltinFactory", () => {
  it("names the entry so the SDK resolves and reports builtin:workflow", () => {
    const entry = workflowBuiltinFactory(resolution());
    expect(entry).toMatchObject({
      name: "workflow",
      builtin: true,
      replaceable: true,
    });
    expect(typeof (entry as { factory?: unknown }).factory).toBe("function");
  });

  it("mirrors the replaceable gate instead of hard-coding it", () => {
    expect(workflowBuiltinFactory(resolution({ replaceable: false }))).toMatchObject({
      replaceable: false,
    });
  });

  it("returns null when the artifact is missing, invalid or safe-moded", () => {
    expect(workflowBuiltinFactory(resolveWorkflowBuiltin({}))).toBeNull();
    expect(
      workflowBuiltinFactory(
        resolveWorkflowBuiltin({
          bundleDir: join("C:", "gone"),
          exists: () => false,
        }),
      ),
    ).toBeNull();
    expect(workflowBuiltinFactory(resolveWorkflowBuiltin({ safeMode: true }))).toBeNull();
  });

  it("delegates only to the artifact's default export with the SDK's own pi", async () => {
    const pi = { registerCommand: vi.fn(), on: vi.fn() };
    const register = vi.fn();
    const load = vi.fn(async () => ({ default: register }));
    const entry = workflowBuiltinFactory(resolution(), load);
    await (entry as { factory: (api: unknown) => Promise<void> }).factory(pi);
    expect(load).toHaveBeenCalledWith(
      join("C:", "resources", "extensions", "workflow", "index.ts"),
    );
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(pi);
  });

  it("fails loudly when the staged artifact is not a factory", async () => {
    const entry = workflowBuiltinFactory(resolution(), async () => ({}));
    await expect(
      (entry as { factory: (api: unknown) => Promise<void> }).factory({}),
    ).rejects.toThrow(/no default factory function/);
  });
});

describe("workflowBuiltinExtensions / workflowBuiltinLoaderOptions", () => {
  it("hands the SDK exactly one builtin entry, or nothing at all", () => {
    const enabled = workflowBuiltinExtensions(resolution());
    expect(enabled).toHaveLength(1);
    expect(enabled[0]).toMatchObject({ name: "workflow", builtin: true });
    expect(workflowBuiltinExtensions(resolveWorkflowBuiltin({}))).toEqual([]);
  });

  it("omits extensionFactories entirely when the builtin is not registered", () => {
    // An empty array would still tell the loader "there are builtins"; omitting
    // the key keeps a safe-mode/absent install identical to a plain Pi loader.
    expect(workflowBuiltinLoaderOptions(null)).toEqual({});
    expect(workflowBuiltinLoaderOptions(resolveWorkflowBuiltin({}))).toEqual({});
  });

  it("registers the same path the hub and the opt-out entry name", () => {
    const options = workflowBuiltinLoaderOptions(resolution());
    expect(options.extensionFactories).toHaveLength(1);
    const entry = options.extensionFactories?.[0] as { name: string; builtin?: boolean };
    expect(entry.builtin).toBe(true);
    // The SDK derives `builtin:<name>`; it must be the frozen resource path.
    expect(`${"builtin:"}${entry.name}`).toBe(WORKFLOW_BUILTIN_PATH);
    // And the metadata file name stays the staged contract's name.
    expect(WORKFLOW_BUNDLE_METADATA).toBe("workflow-bundle.json");
  });
});

describe("WorkflowBuiltinResolution typing", () => {
  it("exposes the fields the capacity/hello surface needs", () => {
    const resolved: WorkflowBuiltinResolution = resolution();
    expect(resolved).toMatchObject({
      registered: true,
      version: "0.13.0",
      source: "bundled",
      replaceable: true,
      disabledBy: null,
    });
  });
});
