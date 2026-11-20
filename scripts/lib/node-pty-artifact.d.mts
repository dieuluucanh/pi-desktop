/**
 * Types for `scripts/lib/node-pty-artifact.mjs`.
 *
 * Same convention as `scripts/electron-builder-after-pack.d.mts`: the scripts
 * are plain ESM outside `tsconfig.node.json`'s include list, so a test that
 * imports them needs a declaration. Keep this in step with the implementation.
 */

/** The oldest runtime a package may require (Debian 11 / Ubuntu 20.04). */
export const NATIVE_FLOOR: Readonly<{ glibc: string; glibcxx: string }>;

/** Where node-pty's loader looks, in its order. */
export function nativeCandidatePaths(moduleDir: string, target: string): string[];

/** True for a non-empty regular file. */
export function isUsableBinary(target: string): boolean;

export interface ReadelfVersionNeeds {
  glibc: string[];
  glibcxx: string[];
  cxxabi: string[];
}

/** Reads the `Name: GLIBC_*` columns out of `readelf --version-info` output. */
export function parseReadelfVersionNeeds(text: string): ReadelfVersionNeeds;

/** Numeric dotted-version comparison. */
export function compareVersions(left: string, right: string): -1 | 0 | 1;

/** The numerically greatest version, or null for an empty list. */
export function maxVersion(versions: readonly string[]): string | null;

/** Throws when `needs` exceeds the floor; returns the measured maxima. */
export function assertNativeFloor(
  needs: ReadelfVersionNeeds,
  floor?: Readonly<{ glibc: string; glibcxx: string }>,
): { glibc: string | null; glibcxx: string | null };

/** The provenance written next to a Linux prebuild (`BUILD-INFO.json`). */
export interface PtyBuildInfoDocument {
  nodePty: string;
  node: string;
  image: string;
  imageDigest: string | null;
  floor: { glibc: string; glibcxx: string };
  builtAt: string;
}

/** Builds the provenance document; `builtAt` defaults to now. */
export function ptyBuildInfo(input: {
  nodePtyVersion: string;
  nodeVersion: string;
  image: string;
  imageDigest?: string | null;
  floor?: Readonly<{ glibc: string; glibcxx: string }>;
  builtAt?: string;
}): PtyBuildInfoDocument;

/** True when an existing artifact was built for exactly this toolchain. */
export function isPtyPrebuildFresh(
  existing: Partial<PtyBuildInfoDocument> | null | undefined,
  expected: PtyBuildInfoDocument,
): boolean;

/** The docker invocation for one Linux architecture. */
export function linuxPtyContainer(input: {
  arch: "x64" | "arm64";
  repoDir: string;
  image: string;
  moduleDir: string;
  nodePath: string;
  nodeGyp: string;
  nodeVersion: string;
  outputDir: string;
}): { platform: string; args: string[]; script: string };
