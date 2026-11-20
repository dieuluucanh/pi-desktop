/**
 * Types for `scripts/fix-node-pty-permissions.mjs`.
 *
 * Same convention as `scripts/lib/node-pty-artifact.d.mts`: the scripts are
 * plain ESM outside `tsconfig.node.json`'s include list, so a test that imports
 * them needs a declaration. Keep this in step with the implementation.
 */

/** The helper locations node-pty uses: the prebuild and a source build. */
export function nodePtyHelperCandidates(root?: string): string[];

/** chmods every existing candidate to 0755 and returns the ones it changed. */
export function ensureExecutable(
  paths: readonly string[],
  chmod?: (path: string, mode: number) => void,
  exists?: (path: string) => boolean,
): string[];
