/**
 * Step 2 of the Pi for Office setup wizard: install and pin the bridge package.
 *
 * The bridge (`@dieulc/pi-office-bridge`) is an ordinary Pi package, so the app
 * installs it the way Pi does — an entry in settings.json `packages` plus an
 * `npm install` inside the Pi npm root — and then *verifies* the result by
 * reading the installed manifest and checking its declared extension entry
 * exists. Nothing is reported as installed until that verification passes.
 */

import * as path from "node:path";

import { satisfies as semverSatisfies } from "semver";

import { PI_OFFICE_BRIDGE } from "../../shared/office";
import type { FsPort } from "../fs-port";
import { tailLog, type PackageInstaller } from "../packages/installer";
import {
  ensureNpmRoot,
  npmRootPaths,
  syncNpmRootManifest,
  type NpmRootPaths,
} from "../packages/npm-root";
import {
  readPackageEntries,
  readSettingsDocument,
  SettingsParseError,
  upsertPackageSource,
  writeSettingsDocument,
  backupFile,
} from "../packages/settings";
import { withPinnedVersion } from "../packages/spec";

export type BridgeInstallStatus = "already-installed" | "installed" | "updated" | "failed";

export interface BridgePackageState {
  installed: boolean;
  version: string | null;
  packageDir: string;
  packageJsonPath: string;
  /** Absolute path of the extension entry declared by the package (`pi.extensions[0]`). */
  extensionEntry: string | null;
  problems: string[];
}

export interface BridgeInstallStep {
  name: "settings" | "npm-root" | "install" | "verify";
  ok: boolean;
  detail: string;
}

export interface BridgeInstallProgress {
  phase: "settings" | "install" | "verify" | "done";
  message: string;
}

export interface BridgeInstallDeps {
  fs: FsPort;
  installer: PackageInstaller;
  agentDir: string;
  cwd: string;
  scope?: "user" | "project";
  /** Defaults to `<agentDir>/settings.json` (user) or `<cwd>/.pi/settings.json` (project). */
  settingsPath?: string;
  packageName?: string;
  versionRange?: string;
  /** When set, the original settings.json is copied here before the first write. */
  backupDir?: string;
  onProgress?: (event: BridgeInstallProgress) => void;
  now?: () => Date;
  semverSatisfies?: (version: string, range: string) => boolean;
}

export interface BridgeInstallResult {
  status: BridgeInstallStatus;
  spec: string;
  previousSpec: string | null;
  settingsChanged: boolean;
  settingsPath: string;
  paths: NpmRootPaths;
  steps: BridgeInstallStep[];
  installLog: string;
  state: BridgePackageState;
  error: string | null;
}

export function defaultBridgeSettingsPath(
  agentDir: string,
  cwd: string,
  scope: "user" | "project" = "user",
): string {
  return scope === "project"
    ? path.join(cwd, ".pi", "settings.json")
    : path.join(agentDir, "settings.json");
}

export function bridgePackageDir(npmRoot: string, packageName: string): string {
  return path.join(npmRoot, "node_modules", ...packageName.split("/"));
}

export async function readBridgePackageState(
  fs: FsPort,
  npmRoot: string,
  packageName: string = PI_OFFICE_BRIDGE.packageName,
): Promise<BridgePackageState> {
  const packageDir = bridgePackageDir(npmRoot, packageName);
  const packageJsonPath = path.join(packageDir, "package.json");
  const problems: string[] = [];

  const text = await fs.readTextFile(packageJsonPath);
  if (text === null) {
    return {
      installed: false,
      version: null,
      packageDir,
      packageJsonPath,
      extensionEntry: null,
      problems: [`${packageName} is not installed in ${npmRoot}`],
    };
  }

  let manifest: {
    version?: unknown;
    pi?: { extensions?: unknown };
  };
  try {
    manifest = JSON.parse(text) as typeof manifest;
  } catch {
    return {
      installed: false,
      version: null,
      packageDir,
      packageJsonPath,
      extensionEntry: null,
      problems: [`${packageJsonPath} is not valid JSON`],
    };
  }

  const version = typeof manifest.version === "string" ? manifest.version : null;
  if (version === null) problems.push(`${packageName} has no version field`);

  const declared = manifest.pi?.extensions;
  const firstEntry =
    Array.isArray(declared) && typeof declared[0] === "string" ? (declared[0] as string) : null;

  let extensionEntry: string | null = null;
  if (firstEntry === null) {
    problems.push(`${packageName} does not declare pi.extensions in its manifest`);
  } else {
    const resolved = path.join(packageDir, firstEntry);
    if ((await fs.pathKind(resolved)) === "file") {
      extensionEntry = resolved;
    } else {
      problems.push(`Declared extension entry is missing: ${resolved}`);
    }
  }

  return {
    installed: problems.length === 0,
    version,
    packageDir,
    packageJsonPath,
    extensionEntry,
    problems,
  };
}

export async function ensureBridgePackage(deps: BridgeInstallDeps): Promise<BridgeInstallResult> {
  const scope = deps.scope ?? "user";
  const packageName = deps.packageName ?? PI_OFFICE_BRIDGE.packageName;
  const versionRange = deps.versionRange ?? PI_OFFICE_BRIDGE.pinnedVersion;
  const settingsPath =
    deps.settingsPath ?? defaultBridgeSettingsPath(deps.agentDir, deps.cwd, scope);
  const paths = npmRootPaths({ agentDir: deps.agentDir, cwd: deps.cwd, scope });
  const spec = withPinnedVersion(`npm:${packageName}`, versionRange);
  const satisfies = deps.semverSatisfies ?? defaultSatisfies;
  const steps: BridgeInstallStep[] = [];
  const progress = (phase: BridgeInstallProgress["phase"], message: string): void =>
    deps.onProgress?.({ phase, message });

  const fail = (error: string, state: BridgePackageState): BridgeInstallResult => {
    steps.push({ name: "verify", ok: false, detail: error });
    progress("done", error);
    return {
      status: "failed",
      spec,
      previousSpec: null,
      settingsChanged: false,
      settingsPath,
      paths,
      steps,
      installLog: "",
      state,
      error,
    };
  };

  // 1. Pin the package in settings.json.
  progress("settings", `Ensuring ${spec} is configured`);
  let previousSpec: string | null = null;
  let settingsChanged = false;
  let configuredSources: string[] = [];
  try {
    const doc = await readSettingsDocument(deps.fs, settingsPath);
    const before = readPackageEntries(doc);
    const outcome = upsertPackageSource(before, spec);
    previousSpec = outcome.previousSource;
    settingsChanged = outcome.action !== "unchanged";
    configuredSources = outcome.packages
      .map((entry) => (typeof entry === "string" ? entry : entry.source))
      .filter((source): source is string => typeof source === "string");

    if (settingsChanged) {
      if (deps.backupDir) {
        const stamp = (deps.now?.() ?? new Date())
          .toISOString()
          .replace(/[:.]/g, "-");
        await backupFile(deps.fs, settingsPath, deps.backupDir, stamp);
      }
      await writeSettingsDocument(deps.fs, settingsPath, { ...doc, packages: outcome.packages });
    }

    steps.push({
      name: "settings",
      ok: true,
      detail:
        outcome.action === "unchanged"
          ? `${settingsPath} already pins ${spec}`
          : `${outcome.action === "added" ? "Added" : "Updated"} ${spec} in ${settingsPath}`,
    });
  } catch (error) {
    const message =
      error instanceof SettingsParseError
        ? error.message
        : `Could not update ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`;
    return fail(message, await readBridgePackageState(deps.fs, paths.root, packageName));
  }

  // 2. Decide whether an install is actually needed.
  const before = await readBridgePackageState(deps.fs, paths.root, packageName);
  const versionOk = before.version !== null && safeSatisfies(satisfies, before.version, versionRange);
  const needsInstall = !before.installed || !versionOk || settingsChanged;

  if (!needsInstall) {
    steps.push({ name: "install", ok: true, detail: `${packageName}@${before.version} already installed` });
    steps.push({ name: "verify", ok: true, detail: `Extension entry: ${before.extensionEntry}` });
    progress("done", `${packageName}@${before.version} is ready`);
    return {
      status: "already-installed",
      spec,
      previousSpec,
      settingsChanged,
      settingsPath,
      paths,
      steps,
      installLog: "",
      state: before,
      error: null,
    };
  }

  // 3. Materialize the npm root manifest and run npm install.
  let installLog = "";
  try {
    await ensureNpmRoot(deps.fs, paths);
    await syncNpmRootManifest(deps.fs, paths, configuredSources);
    steps.push({ name: "npm-root", ok: true, detail: `npm root: ${paths.root}` });
  } catch (error) {
    const message = `Could not prepare the npm root at ${paths.root}: ${
      error instanceof Error ? error.message : String(error)
    }`;
    steps.push({ name: "npm-root", ok: false, detail: message });
    return fail(message, before);
  }

  progress("install", `Installing ${spec} with ${deps.installer.description}`);
  const install = await deps.installer.installAll(paths.root);
  installLog = tailLog([install.stdout, install.stderr].filter(Boolean).join("\n"));

  if (!install.ok) {
    const detail = install.missingRuntime
      ? `The bundled Node/npm runtime could not be launched (${install.command}).`
      : `npm install failed with exit code ${install.code}.`;
    steps.push({ name: "install", ok: false, detail });
    const state = await readBridgePackageState(deps.fs, paths.root, packageName);
    return {
      status: "failed",
      spec,
      previousSpec,
      settingsChanged,
      settingsPath,
      paths,
      steps,
      installLog,
      state,
      error: installLog.trim().length > 0 ? `${detail}\n${installLog}` : detail,
    };
  }
  steps.push({
    name: "install",
    ok: true,
    detail: `Installed in ${paths.root} (${install.durationMs} ms)`,
  });

  // 4. Verify what actually landed on disk.
  progress("verify", "Verifying the installed bridge package");
  const after = await readBridgePackageState(deps.fs, paths.root, packageName);
  if (!after.installed) {
    steps.push({ name: "verify", ok: false, detail: after.problems.join("; ") });
    progress("done", "Verification failed");
    return {
      status: "failed",
      spec,
      previousSpec,
      settingsChanged,
      settingsPath,
      paths,
      steps,
      installLog,
      state: after,
      error: after.problems.join("; "),
    };
  }

  steps.push({ name: "verify", ok: true, detail: `Extension entry: ${after.extensionEntry}` });
  progress("done", `${packageName}@${after.version} is ready`);

  return {
    status: before.installed ? "updated" : "installed",
    spec,
    previousSpec,
    settingsChanged,
    settingsPath,
    paths,
    steps,
    installLog,
    state: after,
    error: null,
  };
}

function safeSatisfies(
  satisfies: (version: string, range: string) => boolean,
  version: string,
  range: string,
): boolean {
  try {
    return satisfies(version, range);
  } catch {
    return false;
  }
}

function defaultSatisfies(version: string, range: string): boolean {
  return semverSatisfies(version, range, { includePrerelease: true });
}
