import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  bundledCheckpointExtensionPath,
  packageCheckpointExtensionPath,
  profileCheckpointExtensionPath,
  resolveCheckpointExtension,
} from "../../src/host/checkpoint-extension";

/**
 * The installed-copy precedence (2026-10-30 plan step 12).
 *
 * The app ships a bundled extension, but a profile clone or an npm install must
 * win so `/rewind` is not registered twice. Only the bundled fallback is passed
 * through `additionalExtensionPaths`; the other two are discovered by Pi.
 */

const HOST_BUNDLE = pathToFileURL(join(process.cwd(), "out", "host", "index.mjs")).href;
const AGENT = join(process.cwd(), "profile");

function slashed(target: string | null): string {
  return (target ?? "").replace(/\\/g, "/");
}

describe("resolveCheckpointExtension", () => {
  it("prefers a profile clone over an npm package and the bundle", () => {
    const exists = (target: string): boolean =>
      target === profileCheckpointExtensionPath(AGENT) ||
      target === packageCheckpointExtensionPath(AGENT) ||
      target === bundledCheckpointExtensionPath(HOST_BUNDLE);
    const resolved = resolveCheckpointExtension({
      hostModuleUrl: HOST_BUNDLE,
      agentDir: AGENT,
      exists,
    });
    expect(resolved.source).toBe("profile");
    expect(resolved.path).toBeNull();
    expect(slashed(resolved.resolvedPath)).toMatch(
      /\/profile\/extensions\/checkpoints\/index\.mjs$/,
    );
  });

  it("prefers an npm package over the bundle", () => {
    const exists = (target: string): boolean =>
      target === packageCheckpointExtensionPath(AGENT) ||
      target === bundledCheckpointExtensionPath(HOST_BUNDLE);
    const resolved = resolveCheckpointExtension({
      hostModuleUrl: HOST_BUNDLE,
      agentDir: AGENT,
      exists,
    });
    expect(resolved.source).toBe("package");
    expect(resolved.path).toBeNull();
    expect(slashed(resolved.resolvedPath)).toMatch(
      /\/profile\/npm\/node_modules\/@dieulc\/checkpoints\/index\.mjs$/,
    );
  });

  it("falls back to the bundled sibling, which is the only path passed to Pi", () => {
    const resolved = resolveCheckpointExtension({
      hostModuleUrl: HOST_BUNDLE,
      agentDir: AGENT,
      exists: (target) => target === bundledCheckpointExtensionPath(HOST_BUNDLE),
    });
    expect(resolved.source).toBe("bundled");
    expect(slashed(resolved.path)).toMatch(/\/out\/host\/pi-checkpoints\.mjs$/);
  });

  it("reports nothing when no copy exists", () => {
    expect(
      resolveCheckpointExtension({
        hostModuleUrl: HOST_BUNDLE,
        agentDir: AGENT,
        exists: () => false,
      }),
    ).toEqual({ path: null, source: null, resolvedPath: null });
  });

  it("never resolves anything in safe mode", () => {
    expect(
      resolveCheckpointExtension({
        hostModuleUrl: HOST_BUNDLE,
        agentDir: AGENT,
        exists: () => true,
        safeMode: true,
      }),
    ).toEqual({ path: null, source: null, resolvedPath: null });
  });

  it("uses the scoped npm package path, not the taken unscoped name", () => {
    expect(slashed(packageCheckpointExtensionPath(AGENT))).toContain(
      "/npm/node_modules/@dieulc/checkpoints/index.mjs",
    );
    expect(slashed(profileCheckpointExtensionPath(AGENT))).toContain(
      "/extensions/checkpoints/index.mjs",
    );
  });
});
