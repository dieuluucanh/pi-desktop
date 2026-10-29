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

/**
 * The resource-loader options for the app's own checkpoint extension
 * (git-checkpoint plan step 24).
 *
 * **Safe mode does not disable `additionalExtensionPaths`.** The SDK builds its
 * list as
 *
 * ```js
 * // node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js
 * extensionPaths = this.noExtensions
 *   ? cliEnabledExtensions
 *   : this.mergePaths(cliEnabledExtensions, enabledExtensions);
 * ```
 *
 * where `cliEnabledExtensions` *is* `additionalExtensionPaths`. Merging our path
 * into {@link SAFE_MODE_RESOURCE_LOADER_OPTIONS} would therefore keep loading it
 * in safe mode and quietly break the "zero third-party code" promise this module
 * exists to keep. The two branches are mutually exclusive on purpose, and this
 * function is the only place that decision is made.
 */
export function checkpointExtensionLoaderOptions(options: {
  safeMode: boolean | undefined;
  extensionPath: string | null | undefined;
}): { noExtensions?: true } & { additionalExtensionPaths?: string[] } {
  if (options.safeMode) return { ...SAFE_MODE_RESOURCE_LOADER_OPTIONS };
  if (!options.extensionPath) return {};
  return { additionalExtensionPaths: [options.extensionPath] };
}

/** True when the checkpoint extension would be loaded under these options. */
export function checkpointExtensionEnabled(options: {
  safeMode: boolean | undefined;
  extensionPath: string | null | undefined;
}): boolean {
  return (
    !options.safeMode &&
    typeof options.extensionPath === "string" &&
    options.extensionPath.length > 0
  );
}
