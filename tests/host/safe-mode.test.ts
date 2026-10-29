import { describe, expect, it } from "vitest";
import {
  SAFE_MODE_PACKAGE_REFUSAL,
  SAFE_MODE_RESOURCE_LOADER_OPTIONS,
  checkpointExtensionEnabled,
  checkpointExtensionLoaderOptions,
  safeModeResourceLoaderOptions,
} from "../../src/host/safe-mode";

/**
 * Safe mode's promise is "zero third-party code" (plan step 22). These tests pin
 * the loader options that enforce it and the refusal message the package handlers
 * throw, so the guarantee cannot silently regress to a prose claim.
 */
describe("safe mode resource loader options", () => {
  it("disables every collection a DefaultResourceLoader would sweep up", () => {
    expect(SAFE_MODE_RESOURCE_LOADER_OPTIONS).toEqual({
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
  });

  it("returns the options only when safe mode is on", () => {
    expect(safeModeResourceLoaderOptions(true)).toBe(SAFE_MODE_RESOURCE_LOADER_OPTIONS);
    expect(safeModeResourceLoaderOptions(false)).toBeUndefined();
    expect(safeModeResourceLoaderOptions(undefined)).toBeUndefined();
  });

  it("names the reason a package mutation is refused", () => {
    expect(SAFE_MODE_PACKAGE_REFUSAL).toMatch(/Safe mode is on/);
    expect(SAFE_MODE_PACKAGE_REFUSAL).toMatch(/package changes are disabled/);
  });
});

/**
 * The checkpoint extension's loader options (git-checkpoint plan step 24).
 *
 * This suite exists because the obvious implementation is wrong: `noExtensions`
 * does **not** gate `additionalExtensionPaths` in the SDK's resource loader
 * (`extensionPaths = noExtensions ? cliEnabledExtensions : merge(...)`, where
 * `cliEnabledExtensions` *is* the extra-path list). Asserting the two branches as
 * values — not as prose — is what keeps the "zero third-party code in safe mode"
 * promise honest.
 */
describe("checkpoint extension loader options", () => {
  const PATH = "/app/out/host/pi-checkpoints.mjs";

  it("loads the extra path when safe mode is off", () => {
    expect(checkpointExtensionLoaderOptions({ safeMode: false, extensionPath: PATH })).toEqual({
      additionalExtensionPaths: [PATH],
    });
  });

  it("never loads it when safe mode is on, and keeps the disable set", () => {
    const options = checkpointExtensionLoaderOptions({ safeMode: true, extensionPath: PATH });
    expect(options).toEqual(SAFE_MODE_RESOURCE_LOADER_OPTIONS);
    // The crucial assertion: the extra path is *absent*, not merely ignored.
    expect(options).not.toHaveProperty("additionalExtensionPaths");
  });

  it("returns the plain disable set when safe mode is undefined-but-truthy-ish", () => {
    // `undefined` means "not safe mode", which is the app's default.
    expect(checkpointExtensionLoaderOptions({ safeMode: undefined, extensionPath: PATH })).toEqual({
      additionalExtensionPaths: [PATH],
    });
  });

  it("returns no options at all when there is no extension to load", () => {
    expect(checkpointExtensionLoaderOptions({ safeMode: false, extensionPath: null })).toEqual({});
    expect(checkpointExtensionLoaderOptions({ safeMode: false, extensionPath: "" })).toEqual({});
    expect(checkpointExtensionLoaderOptions({ safeMode: false, extensionPath: undefined })).toEqual(
      {},
    );
  });

  it("reports whether the extension would be live", () => {
    expect(checkpointExtensionEnabled({ safeMode: false, extensionPath: PATH })).toBe(true);
    expect(checkpointExtensionEnabled({ safeMode: true, extensionPath: PATH })).toBe(false);
    expect(checkpointExtensionEnabled({ safeMode: false, extensionPath: null })).toBe(false);
  });
});
