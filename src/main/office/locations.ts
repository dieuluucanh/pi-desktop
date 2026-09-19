/**
 * Canonical Office filesystem/registry locations.
 *
 * Single source of truth shared by detection (step 1), sideloading (step 3) and
 * "open the Office host" (step 4), so reads and writes always agree.
 */

import * as path from "node:path";

import {
  OFFICE_HOST_DESCRIPTORS,
  OFFICE_REGISTRY_VERSIONS,
  type OfficeHost,
} from "../../shared/office";

export interface WindowsPathContext {
  programFiles?: string | null;
  programFilesX86?: string | null;
  /** Value of HKCU\...\Office\<ver>\Common\InstallRoot\Path when present. */
  installRoot?: string | null;
}

export function dedupePaths(
  paths: readonly string[],
  caseInsensitive = process.platform === "win32",
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of paths) {
    const key = caseInsensitive ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

/** Candidate locations of an Office executable, most specific first. */
export function windowsExeCandidates(exe: string, ctx: WindowsPathContext): string[] {
  const roots: string[] = [];
  if (ctx.installRoot) roots.push(ctx.installRoot);
  for (const programFiles of [ctx.programFiles, ctx.programFilesX86]) {
    if (!programFiles) continue;
    roots.push(path.join(programFiles, "Microsoft Office", "root", "Office16"));
    roots.push(path.join(programFiles, "Microsoft Office", "Office16"));
    roots.push(path.join(programFiles, "Microsoft Office", "root", "Office15"));
  }
  return dedupePaths(roots.map((root) => path.join(root, exe)));
}

/** The Office version whose data folder modern Office reads. */
export const PRIMARY_OFFICE_REGISTRY_VERSION = "16.0";

/** The single wef folder we write to on Windows (`%LOCALAPPDATA%\Microsoft\Office\16.0\Wef`). */
export function primaryWindowsWefDirectory(env: NodeJS.ProcessEnv): string | null {
  const base = env.LOCALAPPDATA ?? env.APPDATA;
  if (!base) return null;
  return path.join(base, "Microsoft", "Office", PRIMARY_OFFICE_REGISTRY_VERSION, "Wef");
}

/** Folders Office scans for task-pane manifests on Windows. */
export function windowsWefDirectories(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const version of OFFICE_REGISTRY_VERSIONS) {
    for (const base of [env.LOCALAPPDATA, env.APPDATA]) {
      if (!base) continue;
      out.push(path.join(base, "Microsoft", "Office", version, "Wef"));
    }
  }
  return dedupePaths(out);
}

/** The developer ("sideload") registry keys Office reads on Windows. */
export function windowsDeveloperRegistryKeys(): string[] {
  return OFFICE_REGISTRY_VERSIONS.map(
    (version) => `HKCU\\SOFTWARE\\Microsoft\\Office\\${version}\\WEF\\Developer`,
  );
}

export function macOfficeBundleCandidates(home: string, macApp: string): string[] {
  return [path.join("/Applications", macApp), path.join(home, "Applications", macApp)];
}

export interface MacWefLocation {
  host: OfficeHost;
  container: string;
  dir: string;
}

export function macWefLocations(home: string): MacWefLocation[] {
  return OFFICE_HOST_DESCRIPTORS.map((descriptor) => ({
    host: descriptor.host,
    container: descriptor.macContainer,
    dir: path.join(
      home,
      "Library",
      "Containers",
      descriptor.macContainer,
      "Data",
      "Documents",
      "wef",
    ),
  }));
}
