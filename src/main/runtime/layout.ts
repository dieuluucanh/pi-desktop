/**
 * Pure path and version rules for the bundled runtime.
 *
 * Kept free of `electron` and of filesystem access so the resolution logic can
 * be unit tested and shared with the packaging scripts (`scripts/gen-shims.mjs`
 * mirrors these rules; `tests/runtime/layout.test.ts` pins them down).
 */

import { join } from "node:path";
import semver from "semver";

/** The Pi coding agent requires `node >= 22.19.0`; the bundled runtime is Node 24 LTS. */
export const MINIMUM_NODE_VERSION = "22.19.0";

export type RuntimeSource = "bundled" | "override" | "system";

export const SUPPORTED_RUNTIME_TARGETS: readonly string[] = [
  "win32-x64",
  "win32-arm64",
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
] as const;

/** `<platform>-<arch>` as used for the runtime directory and by the lockfile. */
export function runtimeTarget(platform: string, arch: string): string {
  return `${platform}-${arch === "arm64" ? "arm64" : "x64"}`;
}

export function isSupportedRuntimeTarget(target: string): boolean {
  return SUPPORTED_RUNTIME_TARGETS.includes(target);
}

/** `node.exe` on Windows, `bin/node` elsewhere — relative to the runtime root. */
export function nodeBinaryRelativePath(platform: string): string {
  return platform === "win32" ? "node.exe" : join("bin", "node");
}

/** The npm CLI shipped inside the Node distribution. */
export function npmCliRelativePath(platform: string): string {
  return platform === "win32"
    ? join("node_modules", "npm", "bin", "npm-cli.js")
    : join("lib", "node_modules", "npm", "bin", "npm-cli.js");
}

export function npxCliRelativePath(platform: string): string {
  return platform === "win32"
    ? join("node_modules", "npm", "bin", "npx-cli.js")
    : join("lib", "node_modules", "npm", "bin", "npx-cli.js");
}

export type ShimName = "pi" | "node" | "npm" | "npx";

/**
 * The shim a shell uses on `platform`.
 *
 * Windows uses `.cmd` for `pi`/`npm`/`npx`. `node` is deliberately **not** a
 * `.cmd` shim: the real `node.exe` is put on PATH instead, so cmd, PowerShell
 * and `spawn("node")` all get an executable rather than a batch file that can
 * only be started through a shell. The extensionless `node` script still ships
 * on Windows for Git Bash.
 */
export function shimFileName(name: ShimName, platform: string): string {
  if (platform !== "win32") return name;
  return name === "node" ? name : `${name}.cmd`;
}

/** `"v24.22.2\n"` → `"24.22.2"`; anything unparseable → `null`. */
export function parseNodeVersion(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^v/i, "");
  return semver.valid(trimmed) ? trimmed : null;
}

/** True when the runtime satisfies the Pi engine requirement. */
export function meetsMinimumNodeVersion(
  version: string | null,
  minimum: string = MINIMUM_NODE_VERSION,
): boolean {
  const parsed = parseNodeVersion(version);
  if (!parsed) return false;
  return semver.gte(parsed, minimum);
}

/**
 * Joins PATH entries with the target platform's separator, dropping empty ones.
 *
 * Callers pass the app's directories first so they win over whatever the user's
 * shell already had; the inherited PATH stays last as one entry.
 */
export function joinPathEntries(
  entries: readonly (string | null | undefined)[],
  platform: string,
): string {
  const separator = platform === "win32" ? ";" : ":";
  return entries
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .join(separator);
}
