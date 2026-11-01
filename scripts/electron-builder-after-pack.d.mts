/**
 * Types for `scripts/electron-builder-after-pack.mjs`.
 *
 * `tsconfig.node.json` typechecks `tests/**` but does not include `scripts/**`,
 * so a test that imports the hook needs this declaration (same convention as
 * `extension-package.d.mts`). Keep it in step with the implementation.
 */

/** The subset of electron-builder's `AfterPackContext` the hook reads. */
export interface AfterPackContext {
  /** `context.electronPlatformName`, e.g. `win32`, `linux`, `darwin`. */
  electronPlatformName: string;
  /** `Arch` enum value from `builder-util` (0 ia32, 1 x64, 2 armv7l, 3 arm64). */
  arch: number;
  /** The directory electron-builder packed this target into. */
  appOutDir: string;
  packager: {
    projectDir: string;
    /** `<appOutDir>/resources` on every platform this app ships for. */
    getResourcesDir(appOutDir: string): string;
  };
}

/**
 * Deletes every runtime directory under `nodeDir` except `target`
 * (`<platform>-<arch>`), and returns the removed names sorted.
 */
export function pruneForeignRuntimes(nodeDir: string, target: string): string[];

/** Prunes foreign runtimes, then rewrites the packaged runtime shims. */
export default function afterPack(context: AfterPackContext): Promise<void>;
