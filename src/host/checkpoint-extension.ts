/**
 * Which copy of the checkpoint extension the host should load
 * (2026-10-30 rail-shell-checkpoint plan).
 *
 * The app ships a bundled copy for zero-install Desktop use. A user may also
 * have installed `@dieulc/checkpoints` for terminal Pi, either as the `~/.pi`
 * clone (`<agentDir>/extensions/checkpoints`) or from npm
 * (`<agentDir>/npm/node_modules/@dieulc/checkpoints`). Loading both the bundled
 * and an installed copy would register `/rewind` and take snapshots twice, so
 * the host resolves **one** source:
 *
 *   profile clone  →  npm package  →  bundled fallback
 *
 * Only the bundled fallback is passed through `additionalExtensionPaths`;
 * profile/npm copies are discovered by Pi's own resource loader. Safe mode
 * resolves nothing, because `noExtensions` is the one promise that must hold.
 */

import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  CHECKPOINT_EXTENSION_DIR_NAME,
  CHECKPOINT_EXTENSION_ENTRY,
  CHECKPOINT_EXTENSION_PACKAGE_NAME,
} from "../shared/checkpoint-extension";

export type CheckpointExtensionSource = "profile" | "package" | "bundled";

export interface CheckpointExtensionResolution {
  /** The path to pass to `additionalExtensionPaths`, or null for discovery. */
  path: string | null;
  source: CheckpointExtensionSource | null;
  /** The path that was checked, for Diagnostics/tests. */
  resolvedPath: string | null;
}

export interface ResolveCheckpointExtensionOptions {
  /** The running host bundle's `import.meta.url`. */
  hostModuleUrl: string;
  /** The Pi profile (`PI_CODING_AGENT_DIR`). */
  agentDir: string;
  exists(target: string): boolean;
  safeMode?: boolean;
}

export function profileCheckpointExtensionPath(agentDir: string): string {
  return join(agentDir, "extensions", CHECKPOINT_EXTENSION_DIR_NAME, CHECKPOINT_EXTENSION_ENTRY);
}

export function packageCheckpointExtensionPath(agentDir: string): string {
  const scope = CHECKPOINT_EXTENSION_PACKAGE_NAME.split("/").filter(Boolean);
  return join(agentDir, "npm", "node_modules", ...scope, CHECKPOINT_EXTENSION_ENTRY);
}

export function bundledCheckpointExtensionPath(hostModuleUrl: string): string {
  return fileURLToPath(new URL("./pi-checkpoints.mjs", hostModuleUrl));
}

export function resolveCheckpointExtension(
  options: ResolveCheckpointExtensionOptions,
): CheckpointExtensionResolution {
  if (options.safeMode) return { path: null, source: null, resolvedPath: null };

  const profilePath = profileCheckpointExtensionPath(options.agentDir);
  if (options.exists(profilePath)) {
    return { path: null, source: "profile", resolvedPath: profilePath };
  }

  const packagePath = packageCheckpointExtensionPath(options.agentDir);
  if (options.exists(packagePath)) {
    return { path: null, source: "package", resolvedPath: packagePath };
  }

  const bundledPath = bundledCheckpointExtensionPath(options.hostModuleUrl);
  if (options.exists(bundledPath)) {
    return { path: bundledPath, source: "bundled", resolvedPath: bundledPath };
  }

  return { path: null, source: null, resolvedPath: null };
}
