/**
 * Types for `scripts/release-assets.mjs`.
 *
 * `tsconfig.node.json` typechecks `tests/**` but not `scripts/**`, so the guard
 * test needs this declaration (same convention as `extension-package.d.mts`).
 */

export type ReleasePlatform = "win" | "linux" | "mac";

export const RELEASE_PLATFORMS: readonly ReleasePlatform[];

/** The artefacts a platform's job must leave in `release/`. */
export function expectedAssets(platform: ReleasePlatform, version: string): string[];

/** The `electron-updater` manifests a platform owns. */
export function platformManifests(platform: ReleasePlatform): string[];

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
}): ReleaseInspection;
