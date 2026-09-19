/**
 * Step 3 of the Pi for Office setup wizard: sideload the add-in manifest.
 *
 * Windows (no admin required):
 *   - `HKCU\Software\Microsoft\Office\16.0\WEF\Developer` value (name and data
 *     are the manifest path) — the "developer catalog" Office reads on start.
 *   - a copy of the manifest in `%LOCALAPPDATA%\Microsoft\Office\16.0\Wef\`.
 * macOS:
 *   - a copy in `~/Library/Containers/com.microsoft.<App>/Data/Documents/wef`
 *     for each selected host (Excel / Word / PowerPoint).
 *
 * A plan can be produced first (`planSideload`) so the wizard can show exactly
 * what it will touch, and every write is verified afterwards with the step 1
 * detector rather than assumed to have worked.
 */

import * as path from "node:path";

import {
  OFFICE_HOST_DESCRIPTORS,
  PI_FOR_OFFICE,
  officeHostLabel,
  type OfficeHost,
} from "../../shared/office";
import { createNodeFsPort, type FsPort } from "../fs-port";
import { createDefaultDetectDeps, detectOfficeWith, toOfficeOs } from "./detect";
import type { DetectDeps } from "./detect";
import type { CommandRunner } from "./exec";
import {
  macWefLocations,
  PRIMARY_OFFICE_REGISTRY_VERSION,
  primaryWindowsWefDirectory,
  windowsDeveloperRegistryKeys,
} from "./locations";
import { manifestMatchesPiForOffice, parseManifest } from "./manifest";
import { addRegistryValue, deleteRegistryValue } from "./registry";
import type { OfficeDetectionResult, OfficeOs } from "./types";

export const SIDELOAD_MANIFEST_FILE_NAME = "manifest.prod.xml";
export const SIDELOAD_REGISTRY_VERSIONS: readonly string[] = [PRIMARY_OFFICE_REGISTRY_VERSION];

export interface SideloadDeps {
  /** Filesystem used for writing the manifest copies. */
  fs: FsPort;
  /** Detection dependencies: platform, env, homedir and the registry reader. */
  detect: DetectDeps;
}

export function createDefaultSideloadDeps(
  overrides: { fs?: FsPort; detect?: DetectDeps } = {},
): SideloadDeps {
  return {
    fs: overrides.fs ?? createNodeFsPort(),
    detect: overrides.detect ?? createDefaultDetectDeps(),
  };
}

export interface SideloadOptions {
  /** Absolute path of the manifest to install (bundled app resource). */
  manifestPath: string;
  /** macOS containers to populate. Default: every Office host. */
  hosts?: readonly OfficeHost[];
  /** Windows Office registry versions to register. Default: ["16.0"]. */
  registryVersions?: readonly string[];
  /** Write the `WEF\Developer` registry entry. Default: true on Windows. */
  useRegistry?: boolean;
  /** Copy the manifest into the Office wef folder(s). Default: true. */
  copyToWefFolder?: boolean;
  /** File name used for the copied manifest. Default: manifest.prod.xml. */
  fileName?: string;
  /** Re-run detection after writing to confirm the add-in is visible. Default: true. */
  verify?: boolean;
}

export interface SideloadPlanEntry {
  key: string;
  valueName: string;
  manifestPath: string;
}

export interface SideloadPlan {
  platform: OfficeOs;
  supported: boolean;
  fileName: string;
  copyTargets: string[];
  registryEntries: SideloadPlanEntry[];
  /** Shown in the wizard so the user knows exactly what will be written. */
  notes: string[];
  manualFallback: string | null;
}

export interface SideloadAction {
  kind: "registry" | "file-copy";
  target: string;
  ok: boolean;
  detail: string;
}

export interface SideloadResult {
  ok: boolean;
  platform: OfficeOs;
  manifestPath: string;
  manifestId: string | null;
  manifestDisplayName: string | null;
  plan: SideloadPlan;
  actions: SideloadAction[];
  verification: OfficeDetectionResult | null;
  verified: boolean;
  nextSteps: string[];
  manualFallback: string | null;
  error: string | null;
}

export interface UnsideloadResult {
  ok: boolean;
  actions: SideloadAction[];
  verification: OfficeDetectionResult | null;
  verified: boolean;
  error: string | null;
}

export function planSideload(deps: SideloadDeps, options: SideloadOptions): SideloadPlan {
  const platform = toOfficeOs(deps.detect.platform);
  const fileName = options.fileName ?? SIDELOAD_MANIFEST_FILE_NAME;
  const notes: string[] = [];

  if (platform === "linux") {
    return {
      platform,
      supported: false,
      fileName,
      copyTargets: [],
      registryEntries: [],
      notes: [
        "Desktop Office is not available on Linux, so there is nothing to sideload locally.",
        "Use Office on the web and upload the manifest from Insert → Add-ins → My Add-ins.",
      ],
      manualFallback: webUploadInstruction(options.manifestPath),
    };
  }

  const copyTargets: string[] = [];
  if (options.copyToWefFolder ?? true) {
    if (platform === "windows") {
      const wefDir = primaryWindowsWefDirectory(deps.detect.env);
      if (wefDir) copyTargets.push(wefDir);
      else notes.push("LOCALAPPDATA is not set; the manifest copy was skipped.");
    } else {
      const hosts =
        options.hosts && options.hosts.length > 0
          ? new Set(options.hosts)
          : new Set(OFFICE_HOST_DESCRIPTORS.map((descriptor) => descriptor.host));
      for (const location of macWefLocations(deps.detect.homedir)) {
        if (hosts.has(location.host)) copyTargets.push(location.dir);
      }
    }
  }

  const registryEntries: SideloadPlanEntry[] = [];
  const useRegistry = options.useRegistry ?? platform === "windows";
  if (platform === "windows" && useRegistry) {
    const versions = options.registryVersions ?? SIDELOAD_REGISTRY_VERSIONS;
    const knownKeys = new Set(windowsDeveloperRegistryKeys());
    for (const version of versions) {
      const key = `HKCU\\SOFTWARE\\Microsoft\\Office\\${version}\\WEF\\Developer`;
      if (!knownKeys.has(key)) {
        const supported = windowsDeveloperRegistryKeys()
          .map((k) => k.split("\\")[4])
          .join(", ");
        throw new Error(
          `Unsupported Office registry version "${version}" (expected one of: ${supported})`,
        );
      }
      // Register the stable wef-folder copy when we made one, so an app update
      // that relocates its bundled resource cannot break the entry.
      const manifestPath = copyTargets[0]
        ? path.join(copyTargets[0], fileName)
        : options.manifestPath;
      registryEntries.push({ key, valueName: manifestPath, manifestPath });
    }
  }

  if (registryEntries.length > 0) {
    notes.push(
      `Adds a developer-catalog entry under HKCU (no administrator rights required): ${registryEntries[0]?.key}`,
    );
  }
  for (const target of copyTargets) {
    notes.push(`Copies ${fileName} to ${target}`);
  }

  return {
    platform,
    supported: true,
    fileName,
    copyTargets,
    registryEntries,
    notes,
    manualFallback: platform === "windows" ? windowsUploadInstruction(options.manifestPath) : null,
  };
}

export async function sideloadAddIn(
  deps: SideloadDeps,
  options: SideloadOptions,
): Promise<SideloadResult> {
  const platform = toOfficeOs(deps.detect.platform);
  const plan = planSideload(deps, options);

  const text = await deps.fs.readTextFile(options.manifestPath);
  if (text === null) {
    return failure(
      platform,
      options.manifestPath,
      null,
      null,
      plan,
      `Manifest not found: ${options.manifestPath}`,
    );
  }

  const manifest = parseManifest(text);
  if (!manifestMatchesPiForOffice(manifest)) {
    return failure(
      platform,
      options.manifestPath,
      manifest.id,
      manifest.displayName,
      plan,
      `Refusing to sideload an unrelated manifest (id ${manifest.id ?? "unknown"}, display name ${
        manifest.displayName ?? "unknown"
      }). Expected the ${PI_FOR_OFFICE.displayName} manifest (${PI_FOR_OFFICE.addInId}).`,
    );
  }

  if (!plan.supported) {
    return failure(
      platform,
      options.manifestPath,
      manifest.id,
      manifest.displayName,
      plan,
      "This platform has no desktop Office to sideload into.",
    );
  }

  const actions: SideloadAction[] = [];

  // 1. Manifest copies.
  for (const dir of plan.copyTargets) {
    const target = path.join(dir, plan.fileName);
    try {
      await deps.fs.writeTextFile(target, text);
      actions.push({ kind: "file-copy", target, ok: true, detail: `Wrote ${text.length} bytes` });
    } catch (error) {
      actions.push({
        kind: "file-copy",
        target,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 2. Registry developer catalog (Windows).
  for (const entry of plan.registryEntries) {
    const result = await addRegistryValue(
      deps.detect.runner,
      entry.key,
      entry.valueName,
      entry.manifestPath,
    );
    actions.push({
      kind: "registry",
      target: entry.key,
      ok: result.code === 0,
      detail:
        result.code === 0
          ? `Registered ${entry.manifestPath}`
          : result.stderr.trim() || `reg.exe exited with ${result.code}`,
    });
  }

  const failed = actions.filter((action) => !action.ok);
  const verification = options.verify === false ? null : await detectOfficeWith(deps.detect);
  const verified = verification?.sideload.installed ?? false;

  return {
    ok: failed.length === 0 && (options.verify === false || verified),
    platform,
    manifestPath: options.manifestPath,
    manifestId: manifest.id,
    manifestDisplayName: manifest.displayName,
    plan,
    actions,
    verification,
    verified,
    nextSteps: verified ? nextStepsFor(platform) : [],
    manualFallback: plan.manualFallback,
    error:
      failed.length > 0
        ? `Some writes failed: ${failed.map((action) => `${action.kind} ${action.target}: ${action.detail}`).join("; ")}`
        : !verified && options.verify !== false
          ? "Wrote the sideload entry but detection still does not see the add-in. Check the manifest copy and re-run detection."
          : null,
  };
}

/**
 * Removes only entries that detection identifies as Pi for Office, so unrelated
 * sideloaded add-ins are never touched.
 */
export async function unsideloadAddIn(
  deps: SideloadDeps,
  options: { verify?: boolean } = {},
): Promise<UnsideloadResult> {
  const before = await detectOfficeWith(deps.detect);
  const ours = before.sideload.entries.filter((entry) => entry.matchesPiForOffice);
  const actions: SideloadAction[] = [];

  for (const entry of ours) {
    if (entry.channel === "registry") {
      const valueName = entry.slot ?? entry.manifestPath;
      const result = await deleteRegistryValue(deps.detect.runner, entry.location, valueName);
      actions.push({
        kind: "registry",
        target: `${entry.location} [${valueName}]`,
        ok: result.code === 0,
        detail:
          result.code === 0
            ? "Removed registry entry"
            : result.stderr.trim() || `reg.exe exited with ${result.code}`,
      });
      continue;
    }

    const removed = await deps.fs.remove(entry.manifestPath);
    actions.push({
      kind: "file-copy",
      target: entry.manifestPath,
      ok: removed,
      detail: removed ? "Deleted manifest copy" : "Manifest copy was already gone",
    });
  }

  const verification = options.verify === false ? null : await detectOfficeWith(deps.detect);
  const verified = verification ? !verification.sideload.installed : true;

  return {
    ok: verified && actions.every((action) => action.ok),
    actions,
    verification,
    verified,
    error: verified
      ? null
      : "Pi for Office is still detected after removal; re-run detection or remove the entry manually.",
  };
}

function nextStepsFor(platform: OfficeOs): string[] {
  if (platform === "windows") {
    return [
      "Close every Excel/Word/PowerPoint window, then reopen the app (the add-in list is read at start-up).",
      "Open Insert → My Add-ins and pick “Pi for Office”, or use the Add-ins button on the Home ribbon.",
    ];
  }
  if (platform === "macos") {
    return [
      "Quit Excel (Cmd+Q) completely, then reopen it.",
      "Open Insert → My Add-ins and pick “Pi for Office”, then the Add-ins button on the Home ribbon.",
    ];
  }
  return [
    "Upload the manifest in Office on the web (Insert → Add-ins → More Add-ins → My Add-ins).",
  ];
}

function webUploadInstruction(manifestPath: string): string {
  return `Office on the web: open a document → Insert → Add-ins → More Add-ins → My Add-ins → Upload My Add-in → choose ${manifestPath}`;
}

function windowsUploadInstruction(manifestPath: string): string {
  return `Manual fallback: Insert → My Add-ins → Upload My Add-in… → choose ${manifestPath}`;
}

function failure(
  platform: OfficeOs,
  manifestPath: string,
  manifestId: string | null,
  manifestDisplayName: string | null,
  plan: SideloadPlan,
  error: string,
): SideloadResult {
  return {
    ok: false,
    platform,
    manifestPath,
    manifestId,
    manifestDisplayName,
    plan,
    actions: [],
    verification: null,
    verified: false,
    nextSteps: [],
    manualFallback: plan.manualFallback,
    error,
  };
}

/** Convenience for the wizard: describe the hosts a macOS sideload will cover. */
export function sideloadHostSummary(options: SideloadOptions): string {
  const hosts = options.hosts;
  if (!hosts || hosts.length === 0) return "all Office apps";
  return hosts.map((host) => officeHostLabel(host)).join(", ");
}

/** Runner type re-export so callers can construct deps without importing exec. */
export type SideloadCommandRunner = CommandRunner;
