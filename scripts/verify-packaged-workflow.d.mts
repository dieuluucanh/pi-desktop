/**
 * Types for `scripts/verify-packaged-workflow.mjs` (plan step 39).
 *
 * The rows run against a real package in the release/acceptance flow; the pure
 * layout, environment and registration helpers are unit-tested from
 * `tests/packaging/packaged-workflow-acceptance.test.ts`.
 */

export const REQUIRED_REFINEMENT_COMMANDS: readonly string[];
export const REQUIRED_PARITY_COMMANDS: readonly string[];
export const PI_CLI_RELATIVE: string;

export interface VerifyPackagedOptions {
  help: boolean;
  resources: string | null;
  dir: string | null;
  root: string;
  platform: string;
  arch: string;
  node: string | null;
  timeoutMs: number;
  keep: boolean;
  json: boolean;
}

export function parseVerifyArgs(argv: string[]): VerifyPackagedOptions | { help: true };

/** Accepts a `resources` dir or electron-builder's `<app>-unpacked` dir. */
export function resourcesDirFor(target: string): string;

export interface PackagedPaths {
  resourcesDir: string;
  hostBundle: string;
  nodePath: string;
  piCliPath: string;
  extensionsDir: string;
  unpackedExtensionsDir: string;
}

export function packagedPaths(
  resourcesDir: string,
  platform?: string,
  arch?: string,
): PackagedPaths;

/** The staged directory a packaged main would hand the host. */
export function packagedBundleDir(paths: PackagedPaths): string;

export function sha256Of(file: string): string;

export interface PackagedEnvOptions {
  tempDir: string;
  agentDir: string;
  blobDir: string;
  bundleDir?: string;
  safeMode?: boolean;
  platform?: string;
}

/** A minimal env: no developer profile, no system toolchain, no network path. */
export function packagedEnv(options: PackagedEnvOptions): Record<string, string>;

export interface PackagedArtifactInput {
  extensionsDir: string;
  lock: unknown;
  metadata: unknown;
}

/** Every problem with the staged copy, or an empty array. */
export function checkPackagedArtifact(input: PackagedArtifactInput): string[];

/** Rows that count as a Workflow registration in a resources snapshot. */
export function workflowRegistrations(snapshot: unknown): Array<Record<string, unknown>>;

/** Command names a resource row advertises. */
export function contributedCommands(row: unknown): string[];

export const sep: string;

export function main(argv: string[]): Promise<number>;
