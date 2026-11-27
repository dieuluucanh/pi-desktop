/**
 * Types for `scripts/release-assets.mjs`.
 *
 * `tsconfig.node.json` typechecks `tests/**` but not `scripts/**`, so the guard
 * test needs this declaration (same convention as `extension-package.d.mts`).
 */

export type ReleasePlatform = "win" | "linux" | "mac";

/** Linux is built one architecture per matrix job; `--arch` scopes the guard. */
export type ReleaseArch = "x64" | "arm64";

export const RELEASE_PLATFORMS: readonly ReleasePlatform[];

/** The artefacts a platform's job must leave in `release/`. */
export function expectedAssets(
  platform: ReleasePlatform,
  version: string,
  arch?: ReleaseArch,
): string[];

/** The `electron-updater` manifests a platform owns. */
export function platformManifests(platform: ReleasePlatform, arch?: ReleaseArch): string[];

export interface ParsedManifest {
  version: string | null;
  /** Every download url the manifest names, including `path`. */
  urls: string[];
}

export function parseManifest(text: string): ParsedManifest;

export interface ReleaseInspection {
  ok: boolean;
  missing: string[];
  problems: string[];
  manifests: Record<string, ParsedManifest>;
}

export function inspectRelease(input: {
  dir: string;
  platform: ReleasePlatform;
  version: string;
  arch?: ReleaseArch;
}): ReleaseInspection;
