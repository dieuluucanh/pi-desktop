/**
 * Types for `scripts/workflow-bundle.mjs` (plan step 26).
 *
 * The staging/verification CLIs and the packaging tests share these rules; the
 * types describe the pinned lock, the staged metadata and the pure gates.
 */

export const WORKFLOW_PACKAGE_NAME: string;
export const WORKFLOW_ENTRY: string;
export const WORKFLOW_LOCK_FILE: string;
export const WORKFLOW_STAGE_DIR: string;
export const WORKFLOW_DEV_STAGE_DIR: string;
export const BUNDLE_METADATA_FILE: string;
export const BUNDLE_LICENSE_FILES: readonly string[];
export const REQUIRED_BUNDLE_FILES: readonly string[];
export const HOST_PEER_PREFIX: string;
export const HOST_PEER_EXTRA: readonly string[];
export const LIFECYCLE_SCRIPTS: readonly string[];
export const BUNDLE_SCHEMA: number;

export interface WorkflowFileHash {
  path: string;
  sha256: string;
}

export interface WorkflowSource {
  kind: "release" | "tarball";
  tarball: string;
  integrity: string;
  path?: string;
  url?: string;
  tag?: string;
}

export interface WorkflowManifest {
  name?: string;
  version?: string;
  private?: boolean;
  type?: string;
  license?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  pi?: { extensions?: string[] };
  files?: string[];
  [key: string]: unknown;
}

export interface WorkflowLock {
  $comment?: string;
  schema: number;
  package: string;
  version: string;
  entry: string;
  license: string;
  hostPeers: string[];
  source: WorkflowSource;
  files: WorkflowFileHash[];
  generatedBy?: string;
}

export interface WorkflowBundleMetadata {
  schema: number;
  package: string;
  version: string;
  entry: string;
  license: string;
  integrity: string;
  source: WorkflowSource;
  hostPeers: string[];
  sourceFiles: WorkflowFileHash[];
  files: WorkflowFileHash[];
  removedScripts: string[];
  manifest: WorkflowManifest;
  generatedAt?: string;
  generator?: string;
}

export function sha512Integrity(buffer: Buffer): string;
export function sha256Hex(buffer: Buffer | string): string;
export function isIntegrity(value: unknown): boolean;
export function integrityMatches(expected: string, buffer: Buffer): boolean;

export function extractTarball(buffer: Buffer): Map<string, Buffer>;

export function isHostPeer(specifier: string): boolean;
export function isBuiltin(specifier: string): boolean;
export function isModuleSpecifier(specifier: string): boolean;
export function collectSpecifiers(source: string): string[];
export function isRelativeSpecifier(specifier: string): boolean;
export function resolvePackedTarget(
  fromFile: string,
  specifier: string,
  packed: Set<string>,
): string | null;
export function findMissingPackedImports(
  files: Iterable<string>,
  read: (file: string) => string,
): { from: string; specifier: string }[];
export function findForeignSpecifiers(
  files: Iterable<string>,
  read: (file: string) => string,
): { from: string; specifier: string }[];

export function unexpectedLifecycleScripts(manifest: WorkflowManifest): string[];
export function sanitizeWorkflowManifest(manifest: WorkflowManifest): {
  manifest: WorkflowManifest;
  removedScripts: string[];
};
export function validateWorkflowManifest(
  manifest: WorkflowManifest | null | undefined,
  lock?: WorkflowLock | null,
  options?: { allowScripts?: boolean },
): string[];
export function validatePackedFiles(files: Iterable<string>): string[];

export function isSafeLockPath(value: unknown): boolean;
export function validateWorkflowLock(lock: unknown): string[];
export function normalizeFileHashes(
  files: Iterable<string>,
  read: (file: string) => string,
): WorkflowFileHash[];
export function hashesEqual(left: unknown, right: unknown): boolean;
export function localTarballPath(source: WorkflowSource): string | null;

export function compareTarballToLock(buffer: Buffer, lock: WorkflowLock): string[];
export function buildWorkflowLock(args: {
  buffer: Buffer;
  manifest: WorkflowManifest;
  files: Map<string, Buffer>;
  source: Partial<WorkflowSource> & { kind: "release" | "tarball" };
  generatedBy?: string;
}): WorkflowLock;

export function buildBundleMetadata(args: {
  lock: WorkflowLock;
  manifest: WorkflowManifest;
  sourceFiles: Iterable<string>;
  stagedFiles: Iterable<string>;
  sourceRead: (file: string) => Buffer;
  stagedRead: (file: string) => Buffer;
}): WorkflowBundleMetadata;

export function isValidMetadata(value: unknown): boolean;
export function validateBundleMetadata(metadata: unknown, lock: WorkflowLock): string[];
export function checkStagedFiles(args: {
  lock: WorkflowLock;
  metadata: unknown;
  exists: (file: string) => boolean;
  read: (file: string) => string;
  list: () => string[];
}): string[];
export function findCheckoutReferences(
  files: Iterable<string>,
  read: (file: string) => string,
  markers?: string[],
): { file: string; needle: string }[];
export function hostPeerNames(lock: WorkflowLock): string[];
