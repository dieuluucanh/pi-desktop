/**
 * Safe mode (plan step 22): the app-wide "no third-party code" switch.
 *
 * Keeping the policy in one pure module means the promise the UI makes — "safe
 * mode starts with zero third-party code" — is a value a test can assert, not a
 * claim spread across two adapters. `src/host/sdk/index.ts` (session runtime) and
 * `src/host/sdk/resources.ts` (Extensions hub) both feed the same object to Pi's
 * `DefaultResourceLoader`.
 */

/** Every collection a `DefaultResourceLoader` would otherwise sweep up. */
export interface SafeModeResourceLoaderOptions {
  noExtensions: true;
  noSkills: true;
  noPromptTemplates: true;
  noThemes: true;
  noContextFiles: true;
}

export const SAFE_MODE_RESOURCE_LOADER_OPTIONS: SafeModeResourceLoaderOptions = {
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
};

/** The options to pass Pi, or `undefined` when safe mode is off. */
export function safeModeResourceLoaderOptions(
  safeMode: boolean | undefined,
): SafeModeResourceLoaderOptions | undefined {
  return safeMode ? SAFE_MODE_RESOURCE_LOADER_OPTIONS : undefined;
}

/** The reason every package mutation is refused while safe mode is on. */
export const SAFE_MODE_PACKAGE_REFUSAL =
  "Safe mode is on: package changes are disabled. Restart without --safe-mode to install or remove packages.";
