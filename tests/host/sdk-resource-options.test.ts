import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { SAFE_MODE_RESOURCE_LOADER_OPTIONS } from "../../src/host/safe-mode";
import { resolveCheckpointExtensionPath } from "../../src/host/index";

/**
 * Host wiring for the checkpoint extension (git-checkpoint plan step 24).
 *
 * Two invariants:
 *
 *  1. **Safe mode never loads it.** The SDK's `noExtensions` does not gate
 *     `additionalExtensionPaths` (see `tests/host/safe-mode.test.ts`), so the
 *     options object is the guarantee, not the flag name.
 *  2. **The loader path matches the emitted file.** `vite.host.config.ts` names
 *     the input `pi-checkpoints` precisely so `[name].mjs` produces
 *     `out/host/pi-checkpoints.mjs` — the name this resolver looks for. A rename
 *     in one place with no change in the other would make run snapshots silently
 *     disappear.
 */

/** A real absolute URL, built from the cwd so it works on every platform. */
function bundleUrl(...segments: string[]): string {
  return pathToFileURL(join(process.cwd(), ...segments)).href;
}

const HOST_BUNDLE = bundleUrl("out", "host", "index.mjs");

/** Normalises Windows separators so one regex can assert both platforms. */
function slashed(target: string): string {
  return target.replace(/\\/g, "/");
}

describe("resolveCheckpointExtensionPath", () => {
  it("finds the sibling file next to the host bundle", () => {
    const seen: string[] = [];
    const resolved = resolveCheckpointExtensionPath(HOST_BUNDLE, (target) => {
      seen.push(target);
      return true;
    });
    expect(resolved).not.toBeNull();
    expect(slashed(resolved ?? "")).toMatch(/\/out\/host\/pi-checkpoints\.mjs$/);
    // It looked up exactly the bundle's sibling, not the cwd or a package path.
    expect(seen).toHaveLength(1);
  });

  it("returns null when the sibling does not exist (a dev tree before a build)", () => {
    expect(resolveCheckpointExtensionPath(HOST_BUNDLE, () => false)).toBeNull();
  });

  it("resolves relative to the host module, not the process cwd", () => {
    const elsewhere = bundleUrl("somewhere", "else", "out", "host", "index.mjs");
    const resolved = resolveCheckpointExtensionPath(elsewhere, () => true);
    expect(slashed(resolved ?? "")).toMatch(/\/somewhere\/else\/out\/host\/pi-checkpoints\.mjs$/);
  });
});

describe("the loader-options decision", () => {
  it("cannot be reached at all in safe mode (the host never resolves the path)", () => {
    // The composition root guards the *resolution*, so safe mode passes `null`
    // and the loader helper's safe branch is belt-and-braces. Both must agree.
    expect(SAFE_MODE_RESOURCE_LOADER_OPTIONS.noExtensions).toBe(true);
    expect(SAFE_MODE_RESOURCE_LOADER_OPTIONS).not.toHaveProperty("additionalExtensionPaths");
  });
});
