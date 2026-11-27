/**
 * Types for `scripts/verify-packaged-terminal.mjs`.
 *
 * The smoke runs in the release workflow (and inside the glibc-floor container);
 * its pure path/argument helpers are unit-tested here.
 */

export const MARKER: string;

export interface VerifyOptions {
  resources: string | null;
  dir: string | null;
  node: string | null;
  shell: string | null;
  cwd: string;
  platform: string;
  arch: string;
  timeoutMs: number;
}

export function parseVerifyArgs(argv: string[]): VerifyOptions;

/** Accepts a `resources` dir or electron-builder's `<app>-unpacked` dir. */
export function resourcesDirFor(target: string): string;

export function runtimeTarget(platform: string, arch: string): string;

export function hostPaths(
  resourcesDir: string,
  platform?: string,
  arch?: string,
): { hostBundle: string; nodePath: string };

/** The executable node-pty spawns to allocate a PTY (`darwin` only). */
export function spawnHelperPath(
  resourcesDir: string,
  platform: string,
  arch: string,
): string | null;

export interface ExecutableState {
  exists: boolean;
  executable: boolean;
  mode: string | null;
}

/** File evidence for a failed spawn, without throwing. */
export function describeExecutable(target: string): ExecutableState;

/** Opens a real PTY through the packaged host; throws with the evidence. */
export function verifyPackagedTerminal(
  options: VerifyOptions,
): Promise<{ binary: string | null; nodePath: string; shell: string }>;

export function shellQuote(value: string): string;
