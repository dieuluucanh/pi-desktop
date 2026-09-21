/**
 * The Pi npm root.
 *
 * Terminal Pi installs user-scoped npm packages under `~/.pi/agent/npm/` with a
 * generated `package.json` named `pi-extensions`, a lockfile, `node_modules/`
 * and a `.gitignore` containing `*` + `!.gitignore`. Project-scoped packages use
 * `<cwd>/.pi/npm/`. The app reproduces that layout exactly so both clients share
 * one dependency tree.
 */

import * as path from "node:path";

import type { FsPort } from "../fs-port";
import { tryParsePackageSource } from "./spec";

export const NPM_ROOT_PACKAGE_NAME = "pi-extensions";
export const NPM_ROOT_GITIGNORE = "*\n!.gitignore\n";

export interface NpmRootPaths {
  root: string;
  packageJsonPath: string;
  lockfilePath: string;
  nodeModulesPath: string;
  gitignorePath: string;
}

export function npmRootPaths(options: {
  agentDir: string;
  cwd: string;
  scope: "user" | "project";
}): NpmRootPaths {
  const root =
    options.scope === "project"
      ? path.join(options.cwd, ".pi", "npm")
      : path.join(options.agentDir, "npm");
  return {
    root,
    packageJsonPath: path.join(root, "package.json"),
    lockfilePath: path.join(root, "package-lock.json"),
    nodeModulesPath: path.join(root, "node_modules"),
    gitignorePath: path.join(root, ".gitignore"),
  };
}

export interface NpmRootPackageJson {
  name: string;
  private: true;
  dependencies: Record<string, string>;
}

export class NpmRootManifestError extends Error {
  constructor(readonly filePath: string) {
    super(`Invalid JSON in the Pi npm root manifest: ${filePath}`);
    this.name = "NpmRootManifestError";
  }
}

/** Only npm sources can live in the npm root manifest; git/path stay in settings. */
export function buildNpmRootPackageJson(specs: readonly string[]): NpmRootPackageJson {
  const dependencies: Record<string, string> = {};
  for (const spec of specs) {
    const parsed = tryParsePackageSource(spec);
    if (!parsed || parsed.kind !== "npm") continue;
    dependencies[parsed.name] = parsed.version ?? "latest";
  }
  return { name: NPM_ROOT_PACKAGE_NAME, private: true, dependencies };
}

export function serializeNpmRootPackageJson(doc: Record<string, unknown>): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export async function ensureNpmRoot(
  fs: FsPort,
  paths: NpmRootPaths,
): Promise<{ created: boolean }> {
  const existed = (await fs.pathKind(paths.root)) === "directory";
  await fs.ensureDir(paths.root);
  if ((await fs.pathKind(paths.gitignorePath)) === null) {
    await fs.writeTextFile(paths.gitignorePath, NPM_ROOT_GITIGNORE);
  }
  return { created: !existed };
}

/**
 * Merges the configured npm specs into the root manifest, preserving unrelated
 * keys (Pi itself keeps `devDependencies` there).
 */
export async function syncNpmRootManifest(
  fs: FsPort,
  paths: NpmRootPaths,
  specs: readonly string[],
): Promise<{ changed: boolean; packageJson: Record<string, unknown> }> {
  const existingText = await fs.readTextFile(paths.packageJsonPath);
  let existing: Record<string, unknown> = {};

  if (existingText !== null && existingText.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existingText);
    } catch {
      throw new NpmRootManifestError(paths.packageJsonPath);
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    } else {
      throw new NpmRootManifestError(paths.packageJsonPath);
    }
  }

  const generated = buildNpmRootPackageJson(specs);
  const currentDependencies = existing.dependencies;
  const merged: Record<string, string> = {};
  if (
    currentDependencies &&
    typeof currentDependencies === "object" &&
    !Array.isArray(currentDependencies)
  ) {
    for (const [name, version] of Object.entries(currentDependencies as Record<string, unknown>)) {
      if (typeof version === "string") merged[name] = version;
    }
  }
  for (const [name, version] of Object.entries(generated.dependencies)) merged[name] = version;

  const next: Record<string, unknown> = {
    ...existing,
    name:
      typeof existing.name === "string" && existing.name.length > 0
        ? existing.name
        : generated.name,
    private: true,
    dependencies: merged,
  };

  const nextText = serializeNpmRootPackageJson(next);
  if (existingText !== null && existingText.trim() === nextText.trim()) {
    return { changed: false, packageJson: next };
  }

  // Atomic, so a crash cannot truncate the manifest and force a reinstall of
  // every extension (plan step 27).
  const temporary = `${paths.packageJsonPath}.${process.pid}.tmp`;
  await fs.writeTextFile(temporary, nextText);
  await fs.rename(temporary, paths.packageJsonPath);
  return { changed: true, packageJson: next };
}
