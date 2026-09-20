import { describe, expect, it } from "vitest";
import {
  SAFE_MODE_PACKAGE_REFUSAL,
  SAFE_MODE_RESOURCE_LOADER_OPTIONS,
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
