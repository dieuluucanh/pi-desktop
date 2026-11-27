/**
 * Where the bundled Workflow extension lives (plan step 26).
 *
 * The artifact is staged outside the asar by `scripts/stage-workflow-bundle.mjs`
 * under two names:
 *
 *   packaged:  <resources>/app.asar.unpacked/out/extensions/workflow
 *              <resources>/extensions/workflow          (extraResources copy)
 *   dev:       <appRoot>/resources/extensions/workflow    (stage source)
 *              <appRoot>/out/extensions/workflow        (unpacked host-build copy)
 *
 * The packaged order matters (plan step 39): the extension imports the Pi SDK
 * family and `typebox`, which live in `<resources>/app.asar.unpacked/node_modules`.
 * Node resolves a bare import by walking up from the importing file, so the
 * `app.asar.unpacked/out/extensions/workflow` copy can find them while
 * `<resources>/extensions/workflow` cannot — on a developer machine the latter
 * only appeared to work because the repo's own `node_modules` was above the
 * build output. The `extraResources` copy stays as a fallback for a package that
 * does not carry the unpacked `out/` tree.
 *
 * Resolution is injected (`resourcesPath`, `appRoot`, `exists`) so this module
 * never imports `electron` and stays unit-testable. It deliberately contains no
 * reference to the `@dieulc/workflow` developer checkout: the app loads the
 * staged copy, offline, from whatever layout it was installed in. Loading the
 * artifact itself is step 27's `builtin:workflow` configuration; this module
 * answers only "which staged directory, and does it look like the pinned
 * bundle?".
 */

import { join } from "node:path";

import {
  WORKFLOW_BUNDLE_DIR,
  WORKFLOW_BUNDLE_ENTRY,
  WORKFLOW_BUNDLE_METADATA,
  WORKFLOW_BUNDLE_OVERRIDE_ENV,
  parseWorkflowBundleMetadata,
  type WorkflowBundleMetadata,
  type WorkflowBundleResolution,
  type WorkflowBundleSource,
} from "../../shared/workflow-bundle";

// Re-exported so every existing importer of this module keeps one entry point.
// The document contract itself lives in `src/shared/workflow-bundle.ts` because
// the Pi host process reads the same document (plan step 27) and must not import
// `src/main` to do it.
export {
  WORKFLOW_BUNDLE_DIR,
  WORKFLOW_BUNDLE_ENTRY,
  WORKFLOW_BUNDLE_METADATA,
  WORKFLOW_BUNDLE_OVERRIDE_ENV,
  WORKFLOW_BUNDLE_SCHEMA,
  WORKFLOW_PACKAGE_NAME,
  isUsableWorkflowBundle,
  parseWorkflowBundleMetadata,
} from "../../shared/workflow-bundle";
export type {
  WorkflowBundleFileHash,
  WorkflowBundleMetadata,
  WorkflowBundleResolution,
  WorkflowBundleSource,
} from "../../shared/workflow-bundle";

export interface WorkflowBundleEnvironment {
  isPackaged: boolean;
  /** Electron `process.resourcesPath` (production). */
  resourcesPath: string;
  /** Repository root in development. */
  appRoot: string;
  env: Record<string, string | undefined>;
  exists(target: string): boolean;
  /** Optional reader: when present, the metadata document is parsed here. */
  readFile?(target: string): string;
}

/** Candidate directories, most specific first. Pure. */
export function workflowBundleCandidates(
  env: Pick<WorkflowBundleEnvironment, "isPackaged" | "resourcesPath" | "appRoot" | "env">,
): { source: WorkflowBundleSource; dir: string; explicit: boolean }[] {
  const candidates: { source: WorkflowBundleSource; dir: string; explicit: boolean }[] = [];
  const override = env.env[WORKFLOW_BUNDLE_OVERRIDE_ENV]?.trim();
  if (override) candidates.push({ source: "override", dir: override, explicit: true });
  if (env.isPackaged) {
    // Prefer the unpacked host-build copy: it sits beside `app.asar.unpacked/
    // node_modules`, so the extension's host-peer imports resolve on an installed
    // machine (see the module comment).
    candidates.push({
      source: "packaged",
      dir: join(env.resourcesPath, "app.asar.unpacked", "out", "extensions", WORKFLOW_BUNDLE_DIR),
      explicit: false,
    });
    candidates.push({
      source: "packaged",
      dir: join(env.resourcesPath, "extensions", WORKFLOW_BUNDLE_DIR),
      explicit: false,
    });
  } else {
    candidates.push({
      source: "dev-resources",
      dir: join(env.appRoot, "resources", "extensions", WORKFLOW_BUNDLE_DIR),
      explicit: false,
    });
    candidates.push({
      source: "dev-out",
      dir: join(env.appRoot, "out", "extensions", WORKFLOW_BUNDLE_DIR),
      explicit: false,
    });
  }
  return candidates;
}

export function resolveWorkflowBundle(env: WorkflowBundleEnvironment): WorkflowBundleResolution {
  const problems: string[] = [];
  for (const candidate of workflowBundleCandidates(env)) {
    const metadataPath = join(candidate.dir, WORKFLOW_BUNDLE_METADATA);
    if (!env.exists(candidate.dir)) {
      if (candidate.explicit)
        problems.push(`the override directory does not exist: ${candidate.dir}`);
      continue;
    }
    if (!env.exists(metadataPath)) {
      problems.push(`the bundle at ${candidate.dir} has no ${WORKFLOW_BUNDLE_METADATA}`);
      continue;
    }
    const entryPath = join(candidate.dir, WORKFLOW_BUNDLE_ENTRY);
    if (!env.exists(entryPath)) {
      problems.push(`the bundle at ${candidate.dir} has no ${WORKFLOW_BUNDLE_ENTRY}`);
      continue;
    }
    let metadata: WorkflowBundleMetadata | null = null;
    if (env.readFile) {
      try {
        metadata = parseWorkflowBundleMetadata(JSON.parse(env.readFile(metadataPath)));
      } catch {
        metadata = null;
      }
      if (metadata === null) {
        problems.push(`the bundle at ${candidate.dir} has an invalid ${WORKFLOW_BUNDLE_METADATA}`);
        continue;
      }
    }
    return {
      ok: true,
      source: candidate.source,
      dir: candidate.dir,
      metadataPath,
      entryPath,
      metadata,
      problems,
      hint: null,
    };
  }
  return {
    ok: false,
    source: null,
    dir: null,
    metadataPath: null,
    entryPath: null,
    metadata: null,
    problems,
    hint: "run `npm run workflow:stage` before packaging; the app never loads Workflow from a developer checkout",
  };
}
