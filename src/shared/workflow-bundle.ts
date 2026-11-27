/**
 * The staged Workflow bundle's identity document (plan steps 26–27).
 *
 * `scripts/stage-workflow-bundle.mjs` writes `workflow-bundle.json` next to the
 * pinned artifact. This module is the **pure** half of the reader: constants,
 * the document types and one structural parser. It imports nothing (no
 * `node:path`, no `node:fs`), so both the Electron main process (which resolves
 * the directory layout) and the Pi host process (which turns the staged copy
 * into `builtin:workflow`) agree on what a usable bundle is without the host
 * reaching into `src/main`.
 *
 * The parser is deliberately strict and returns `null` for anything that is not
 * the pinned schema, so a truncated or hand-edited document can never be
 * mistaken for a usable bundle.
 */

/** Directory name of the staged copy (`<resources>/extensions/workflow`). */
export const WORKFLOW_BUNDLE_DIR = "workflow";
/** The identity document inside that directory. */
export const WORKFLOW_BUNDLE_METADATA = "workflow-bundle.json";
/** The artifact's entry module (a factory, like any Pi extension). */
export const WORKFLOW_BUNDLE_ENTRY = "index.ts";
/** The npm name the lock pins; the staged copy is always this package. */
export const WORKFLOW_PACKAGE_NAME = "@dieulc/workflow";
/** Bumped only with a document the old readers cannot understand. */
export const WORKFLOW_BUNDLE_SCHEMA = 1;
/** Explicit staged-directory override (development, tests, support). */
export const WORKFLOW_BUNDLE_OVERRIDE_ENV = "PI_DESKTOP_WORKFLOW_BUNDLE";

export type WorkflowBundleSource = "override" | "packaged" | "dev-resources" | "dev-out";

export interface WorkflowBundleFileHash {
  path: string;
  sha256: string;
}

export interface WorkflowBundleMetadata {
  schema: number;
  package: string;
  version: string;
  entry: string;
  license: string;
  integrity: string;
  hostPeers: string[];
  files: WorkflowBundleFileHash[];
}

export interface WorkflowBundleResolution {
  ok: boolean;
  source: WorkflowBundleSource | null;
  dir: string | null;
  metadataPath: string | null;
  entryPath: string | null;
  /** Parsed and structurally validated metadata, when readable. */
  metadata: WorkflowBundleMetadata | null;
  problems: string[];
  hint: string | null;
}

const SAFE_RELATIVE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;

function isSafeRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && SAFE_RELATIVE.test(value);
}

/**
 * Parse the staged `workflow-bundle.json`. Returns null for anything that is
 * not the pinned schema, so a hand-edited or truncated document cannot be
 * mistaken for a usable bundle.
 */
export function parseWorkflowBundleMetadata(value: unknown): WorkflowBundleMetadata | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const metadata = value as Record<string, unknown>;
  if (metadata.schema !== WORKFLOW_BUNDLE_SCHEMA) return null;
  if (metadata.package !== WORKFLOW_PACKAGE_NAME) return null;
  if (typeof metadata.version !== "string" || metadata.version.length === 0) return null;
  if (metadata.entry !== WORKFLOW_BUNDLE_ENTRY) return null;
  if (typeof metadata.license !== "string" || metadata.license.length === 0) return null;
  if (typeof metadata.integrity !== "string" || !metadata.integrity.startsWith("sha512-"))
    return null;
  if (!Array.isArray(metadata.hostPeers) || metadata.hostPeers.length === 0) return null;
  if (!metadata.hostPeers.every((peer) => typeof peer === "string" && peer.length > 0)) return null;
  if (!Array.isArray(metadata.files) || metadata.files.length === 0) return null;
  for (const file of metadata.files) {
    if (file === null || typeof file !== "object") return null;
    const record = file as Record<string, unknown>;
    if (!isSafeRelativePath(record.path)) return null;
    if (typeof record.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.sha256)) return null;
  }
  if (
    !metadata.files.some((file) => (file as WorkflowBundleFileHash).path === WORKFLOW_BUNDLE_ENTRY)
  ) {
    return null;
  }
  return {
    schema: WORKFLOW_BUNDLE_SCHEMA,
    package: metadata.package,
    version: metadata.version,
    entry: metadata.entry,
    license: metadata.license,
    integrity: metadata.integrity,
    hostPeers: [...(metadata.hostPeers as string[])],
    files: (metadata.files as WorkflowBundleFileHash[]).map((file) => ({
      path: file.path,
      sha256: file.sha256,
    })),
  };
}

/** True only for a resolution whose metadata document parses and names the entry. */
export function isUsableWorkflowBundle(
  resolution: WorkflowBundleResolution,
  metadata: unknown = resolution.metadata,
): boolean {
  if (!resolution.ok || !resolution.entryPath) return false;
  const parsed = parseWorkflowBundleMetadata(metadata);
  return parsed !== null && parsed.entry === WORKFLOW_BUNDLE_ENTRY;
}
