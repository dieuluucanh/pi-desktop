/**
 * The bundled Workflow extension as `builtin:workflow` (plan step 27).
 *
 * Pi's resource loader already knows how to treat a **named builtin** extension:
 * it loads by default, `pi config` lists it, `-builtin:<name>` in the
 * `extensions` setting (or `noExtensions`) disables it, and a `replaceable`
 * builtin steps aside when an installed extension registers an overlapping
 * command/tool/flag. The app therefore does not load Workflow through
 * `additionalExtensionPaths` (that would make it un-disableable and invisible to
 * `pi config`); it registers the staged artifact under that name.
 *
 * This module is the **pure decision**: which staged copy, is it usable, is the
 * loader allowed to run it, and what do we report. It never imports the SDK and
 * never writes a file, so `src/host/sdk/workflow-builtin.ts` can turn the answer
 * into loader options and `src/host/index.ts` can report it on `host.hello`.
 *
 * Invariants (from the plan):
 *
 *  - Safe mode registers nothing and touches nothing ("zero third-party code").
 *  - A missing/invalid artifact is reported, never replaced by a developer
 *    checkout, an npm install or a runtime download.
 *  - `-builtin:workflow` stays the user's opt-out; the app never rewrites the
 *    settings arrays to force the builtin on.
 *  - An installed npm/git/profile copy may be older and may lack a capability;
 *    it replaces the builtin rather than both loading, and the losing copy must
 *    be registration-only (subtracted in Workflow plan step 25).
 */

import { join } from "node:path";

import {
  WORKFLOW_BUNDLE_ENTRY,
  WORKFLOW_BUNDLE_METADATA,
  WORKFLOW_PACKAGE_NAME,
  parseWorkflowBundleMetadata,
} from "../shared/workflow-bundle";

/** The `builtin:<name>` resource path the SDK resolves. */
export const WORKFLOW_BUILTIN_NAME = "workflow";
export const WORKFLOW_BUILTIN_PATH = `builtin:${WORKFLOW_BUILTIN_NAME}`;
/** The exact settings entry a user writes to opt out. */
export const WORKFLOW_BUILTIN_DISABLE_ENTRY = `-${WORKFLOW_BUILTIN_PATH}`;

/**
 * Whether the builtin steps aside for an installed Workflow (plan step 25 gate).
 *
 * `replaceable: true` is only safe once the builtin factory is *registration
 * only*: the SDK still runs a losing factory, so an artifact that scans files,
 * starts timers or subscribes on the shared bus during load would leak work for
 * an extension that is not part of the session. Workflow plan step 25 subtracted
 * exactly that, and its `extension-factory-safety.test.ts` proves a losing
 * factory performs no I/O, timer, subprocess or bus/listener work. The staged
 * artifact is pinned to a Workflow tree that contains that change
 * (`npm run workflow:verify` checks every byte).
 *
 * If the pin is ever moved back before step 25, set this to `false`: two
 * Workflow implementations would then load and report a conflict instead of the
 * builtin silently vanishing, which is the lesser evil only for un-subtracted
 * factories.
 */
export const WORKFLOW_BUILTIN_REPLACEABLE = true;

/** Why the loader did not receive the builtin (never a silent absence). */
export type WorkflowBuiltinDisabledBy = "safe-mode" | "missing-bundle" | "invalid-bundle";

export interface WorkflowBuiltinResolution {
  name: string;
  /** `builtin:workflow`, the resource path Pi reports. */
  path: string;
  packageName: string;
  /** True only when the loader should be given the builtin factory. */
  registered: boolean;
  /** Pinned package version from the staged metadata, when readable. */
  version: string | null;
  /** Where the artifact came from. `null` when nothing was staged. */
  source: "bundled" | null;
  dir: string | null;
  entryPath: string | null;
  integrity: string | null;
  replaceable: boolean;
  disabledBy: WorkflowBuiltinDisabledBy | null;
  problems: string[];
  hint: string | null;
}

export interface ResolveWorkflowBuiltinOptions {
  /** Safe mode (plan step 22): register nothing and read nothing. */
  safeMode?: boolean;
  /**
   * The staged directory main resolved, from {@link WORKFLOW_BUNDLE_DIR_ENV}.
   * `null`/empty means no staged artifact on this install.
   */
  bundleDir?: string | null;
  exists?(target: string): boolean;
  readFile?(target: string): string;
  /** Test seam for the plan-step-25 gate; defaults to the proven value. */
  replaceable?: boolean;
}

const DEFAULT_HINT =
  "run `npm run workflow:stage` before packaging; the app never loads Workflow from a developer checkout or installs it at runtime";

function baseResolution(options: {
  replaceable: boolean;
  disabledBy: WorkflowBuiltinDisabledBy | null;
}): WorkflowBuiltinResolution {
  return {
    name: WORKFLOW_BUILTIN_NAME,
    path: WORKFLOW_BUILTIN_PATH,
    packageName: WORKFLOW_PACKAGE_NAME,
    registered: false,
    version: null,
    source: null,
    dir: null,
    entryPath: null,
    integrity: null,
    replaceable: options.replaceable,
    disabledBy: options.disabledBy,
    problems: [],
    hint: null,
  };
}

/**
 * Resolve the builtin from the staged directory main handed over.
 *
 * The document is parsed with the same strict reader the main process uses, so
 * a truncated/hand-edited `workflow-bundle.json` is reported instead of being
 * trusted. Nothing is installed, downloaded or written at any point.
 */
export function resolveWorkflowBuiltin(
  options: ResolveWorkflowBuiltinOptions = {},
): WorkflowBuiltinResolution {
  const replaceable = options.replaceable ?? WORKFLOW_BUILTIN_REPLACEABLE;

  // Safe mode is checked first: it must not even read the staged document.
  if (options.safeMode) {
    return baseResolution({ replaceable, disabledBy: "safe-mode" });
  }

  const dir = options.bundleDir?.trim() || null;
  if (!dir) {
    return {
      ...baseResolution({ replaceable, disabledBy: "missing-bundle" }),
      problems: ["no staged Workflow bundle was found for this install"],
      hint: DEFAULT_HINT,
    };
  }

  const exists = options.exists;
  const readFile = options.readFile;
  const metadataPath = join(dir, WORKFLOW_BUNDLE_METADATA);
  const entryPath = join(dir, WORKFLOW_BUNDLE_ENTRY);
  const problems: string[] = [];

  if (!exists || !exists(dir)) {
    return {
      ...baseResolution({ replaceable, disabledBy: "missing-bundle" }),
      dir,
      entryPath,
      problems: [`the staged Workflow directory does not exist: ${dir}`],
      hint: DEFAULT_HINT,
    };
  }
  if (!exists(metadataPath)) {
    problems.push(`the staged Workflow copy has no ${WORKFLOW_BUNDLE_METADATA}`);
  } else if (!exists(entryPath)) {
    problems.push(`the staged Workflow copy has no ${WORKFLOW_BUNDLE_ENTRY}`);
  }

  let metadata = null;
  if (problems.length === 0 && readFile) {
    try {
      metadata = parseWorkflowBundleMetadata(JSON.parse(readFile(metadataPath)));
    } catch {
      metadata = null;
    }
    if (metadata === null) {
      problems.push(`the staged Workflow copy has an invalid ${WORKFLOW_BUNDLE_METADATA}`);
    }
  }

  if (problems.length > 0 || metadata === null) {
    if (!readFile) problems.push("the staged Workflow copy could not be verified");
    return {
      ...baseResolution({ replaceable, disabledBy: "invalid-bundle" }),
      dir,
      entryPath,
      problems,
      hint: DEFAULT_HINT,
    };
  }

  return {
    ...baseResolution({ replaceable, disabledBy: null }),
    registered: true,
    version: metadata.version,
    source: "bundled",
    dir,
    entryPath,
    integrity: metadata.integrity,
    hint: null,
  };
}

/** What the loader actually did with the builtin, for the hub/diagnostics. */
export type WorkflowBuiltinLoadState = "loaded" | "replaced" | "disabled" | "safe-mode" | "absent";

export interface WorkflowBuiltinLoadReport {
  state: WorkflowBuiltinLoadState;
  /** The extension path the loader reported as the winner, when replaced. */
  replacedBy: string | null;
  /** Pi's own sentence about why the builtin was not loaded, when replaced. */
  message: string | null;
}

export interface DescribeWorkflowBuiltinLoadOptions {
  /** Every `extension.path` the loader returned. */
  loadedPaths: readonly string[];
  /** Pi's loader warnings (`{ path, warning }`); replacement rides here. */
  warnings?: readonly { path: string; warning: string }[];
}

/**
 * Distinguish "loaded", "replaced by an installed copy", "disabled by the
 * user's `extensions` setting" and "not registered at all".
 *
 * The loader does not report a builtin it disabled through settings, so the
 * difference between user-disabled and replaced is read from Pi's own warning
 * (which names the installed extension that registered an overlapping name).
 * That keeps the app from re-implementing the SDK's conflict rules.
 */
export function describeWorkflowBuiltinLoad(
  resolution: WorkflowBuiltinResolution,
  options: DescribeWorkflowBuiltinLoadOptions,
): WorkflowBuiltinLoadReport {
  if (!resolution.registered) {
    return {
      state: resolution.disabledBy === "safe-mode" ? "safe-mode" : "absent",
      replacedBy: null,
      message: resolution.disabledBy === "safe-mode" ? null : (resolution.problems[0] ?? null),
    };
  }
  if (options.loadedPaths.includes(WORKFLOW_BUILTIN_PATH)) {
    return { state: "loaded", replacedBy: null, message: null };
  }
  const replacement = (options.warnings ?? []).find(
    (warning) => warning.path === WORKFLOW_BUILTIN_PATH && typeof warning.warning === "string",
  );
  if (replacement) {
    // Pi's sentence names the winning extension; keep it verbatim for the hub.
    return { state: "replaced", replacedBy: replacement.warning, message: replacement.warning };
  }
  return { state: "disabled", replacedBy: null, message: null };
}
