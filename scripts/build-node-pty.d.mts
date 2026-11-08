/**
 * Types for `scripts/build-node-pty.mjs` (`npm run pty:linux`).
 *
 * `tsconfig.node.json` typechecks `tests/**` but not `scripts/**`, so the CLI
 * helpers a test imports need this declaration. Keep it in step with the script.
 */

export type PtyArch = "x64" | "arm64";

export interface BuildNodePtyOptions {
  arches: PtyArch[];
  force: boolean;
  checkOnly: boolean;
  printPlan: boolean;
  image: string;
}

/** Parses `npm run pty:linux -- …`; rejects an unsupported arch. */
export function parseBuildArgs(argv: string[]): BuildNodePtyOptions;

/** The locked node-pty version; throws when the lock and install disagree. */
export function resolveNodePtyVersion(repoDir?: string): string;

/** The bundled Node for a Linux target (requires `runtime:fetch`). */
export function resolveBundledNode(
  repoDir: string,
  arch: PtyArch,
): { path: string; version: string };

export interface PtyPrebuildInfo {
  nodePty: string;
  node: string;
  image: string;
  imageDigest: string | null;
  floor: { glibc: string; glibcxx: string };
  builtAt: string;
}

/** Verifies an existing artifact + provenance without running Docker. */
export function checkPrebuild(
  repoDir: string,
  arch: PtyArch,
): { binary: string; info: PtyPrebuildInfo };
