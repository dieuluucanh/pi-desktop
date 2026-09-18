/**
 * Step 1 of the Pi for Office setup wizard: detect the environment.
 *
 * Answers three questions without touching anything:
 *   1. Which OS are we on (and are we inside WSL)?
 *   2. Which Office desktop apps are installed, and where?
 *   3. Is the Pi for Office add-in already sideloaded, and is that manifest current?
 *
 * Every OS interaction goes through `DetectDeps`, so this module is fully
 * unit-testable on any platform and reusable for the diagnostics bundle.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

import {
  OFFICE_HOST_DESCRIPTORS,
  OFFICE_REGISTRY_VERSIONS,
  PI_FOR_OFFICE,
  type OfficeHost,
} from "../../shared/office";
import { createCommandRunner, type CommandRunner } from "./exec";
import {
  macOfficeBundleCandidates,
  macWefLocations,
  windowsDeveloperRegistryKeys,
  windowsExeCandidates,
  windowsWefDirectories,
} from "./locations";
import {
  manifestHostsToOfficeHosts,
  manifestMatchesPiForOffice,
  manifestSourceMatchesProd,
  parseManifest,
} from "./manifest";
import { queryRegistryKey, queryRegistryTree, readRegistryValue, type RegistryValue } from "./registry";
import type {
  DetectedOfficeInstall,
  OfficeAppInfo,
  OfficeDetectionResult,
  OfficeOs,
  OfficeSideloadState,
  SideloadChannel,
  SideloadEntry,
} from "./types";

export const MAX_MANIFEST_BYTES = 512 * 1024;

const CLICK_TO_RUN_KEYS = [
  "HKLM\\SOFTWARE\\Microsoft\\Office\\ClickToRun\\Configuration",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Office\\ClickToRun\\Configuration",
] as const;

/** Office product ids that imply the full app suite. */
const SUITE_PRODUCT_HINTS = [
  "proplus",
  "professional",
  "standard",
  "o365",
  "m365",
  "office",
  "homebusiness",
  "personal",
  "business",
] as const;

const HOST_PRODUCT_HINTS: Record<OfficeHost, readonly string[]> = {
  excel: ["excel"],
  word: ["word"],
  powerpoint: ["powerpoint", "powerpnt"],
};

export type PathKind = "file" | "directory" | "other";

export interface DirectoryEntry {
  name: string;
  kind: PathKind;
}

export interface DetectDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
  homedir: string;
  pathKind(target: string): Promise<PathKind | null>;
  readFileText(target: string): Promise<string | null>;
  listDirectory(dir: string): Promise<DirectoryEntry[]>;
  now(): Date;
}

export function createDefaultDetectDeps(overrides: Partial<DetectDeps> = {}): DetectDeps {
  const base: DetectDeps = {
    platform: process.platform,
    env: process.env,
    runner: createCommandRunner(),
    homedir: homedir(),
    async pathKind(target) {
      try {
        const info = await stat(target);
        if (info.isDirectory()) return "directory";
        if (info.isFile()) return "file";
        return "other";
      } catch {
        return null;
      }
    },
    async readFileText(target) {
      try {
        return await readFile(target, "utf8");
      } catch {
        return null;
      }
    },
    async listDirectory(dir) {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries.map((entry) => ({
          name: entry.name,
          kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
        }));
      } catch {
        return [];
      }
    },
    now: () => new Date(),
  };
  return { ...base, ...overrides };
}

export async function detectOfficeEnvironment(
  overrides: Partial<DetectDeps> = {},
): Promise<OfficeDetectionResult> {
  return detectOfficeWith(createDefaultDetectDeps(overrides));
}

export async function detectOfficeWith(deps: DetectDeps): Promise<OfficeDetectionResult> {
  const os = toOfficeOs(deps.platform);
  const supported = os !== "linux";
  const isWsl = await detectWsl(deps);

  let apps: OfficeAppInfo[] = [];
  let office: DetectedOfficeInstall = { version: null, platform: null, products: [], source: null };
  let sideload: OfficeSideloadState = {
    installed: false,
    entries: [],
    searched: [],
    problems: [],
  };

  if (os === "windows") {
    const install = await detectWindowsInstall(deps);
    apps = install.apps;
    office = install.office;
    sideload = await detectWindowsSideload(deps);
  } else if (os === "macos") {
    apps = await detectMacInstall(deps);
    sideload = await detectMacSideload(deps);
  }

  const anyAppInstalled = apps.some((app) => app.installed);

  return {
    os,
    supported,
    isWsl,
    apps,
    anyAppInstalled,
    office,
    sideload,
    officeOnTheWeb: {
      url: PI_FOR_OFFICE.officeOnTheWebUrl,
      recommended: !supported || !anyAppInstalled,
    },
    notes: buildNotes({ supported, isWsl, anyAppInstalled, office, sideload }),
    checkedAt: deps.now().toISOString(),
  };
}

export function toOfficeOs(platform: NodeJS.Platform): OfficeOs {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  return "linux";
}

async function detectWsl(deps: DetectDeps): Promise<boolean> {
  if (deps.env.WSL_DISTRO_NAME || deps.env.WSL_INTEROP) return true;
  if (deps.platform !== "linux") return false;
  const procVersion = await deps.readFileText("/proc/version");
  return typeof procVersion === "string" && /microsoft|wsl/i.test(procVersion);
}

/* ------------------------------------------------------------------ Windows */

interface WindowsInstallDetection {
  apps: OfficeAppInfo[];
  office: DetectedOfficeInstall;
}

async function detectWindowsInstall(deps: DetectDeps): Promise<WindowsInstallDetection> {
  const office: DetectedOfficeInstall = {
    version: null,
    platform: null,
    products: [],
    source: null,
  };

  for (const key of CLICK_TO_RUN_KEYS) {
    const registryKey = await queryRegistryKey(deps.runner, key);
    if (!registryKey) continue;
    office.version = readRegistryValue(registryKey, "VersionToReport");
    office.platform = readRegistryValue(registryKey, "Platform");
    const rawProducts = readRegistryValue(registryKey, "ProductReleaseIds");
    office.products = rawProducts
      ? rawProducts
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : [];
    office.source = key;
    break;
  }

  let installRoot: string | null = null;
  let installRootSource: string | null = null;
  for (const version of OFFICE_REGISTRY_VERSIONS) {
    const key = `HKCU\\SOFTWARE\\Microsoft\\Office\\${version}\\Common\\InstallRoot`;
    const registryKey = await queryRegistryKey(deps.runner, key);
    const value = readRegistryValue(registryKey, "Path");
    if (value) {
      installRoot = value;
      installRootSource = key;
      break;
    }
  }
  if (!office.source) office.source = installRootSource;

  const programFiles = envValue(deps.env, "ProgramFiles", "PROGRAMFILES", "ProgramW6432");
  const programFilesX86 = envValue(deps.env, "ProgramFiles(x86)", "PROGRAMFILES(X86)");

  const apps: OfficeAppInfo[] = [];
  for (const descriptor of OFFICE_HOST_DESCRIPTORS) {
    const info: OfficeAppInfo = {
      host: descriptor.host,
      label: descriptor.label,
      installed: false,
    };

    const candidates = windowsExeCandidates(descriptor.winExe, {
      programFiles,
      programFilesX86,
      installRoot,
    });
    for (const candidate of candidates) {
      if ((await deps.pathKind(candidate)) === "file") {
        info.installed = true;
        info.executablePath = candidate;
        info.evidence =
          installRoot && normalize(candidate).startsWith(normalize(installRoot))
            ? "install-root"
            : "filesystem";
        break;
      }
    }

    // Secondary signal: Click-to-Run product ids (no usable executable path).
    if (!info.installed && productsAllowHost(office.products, descriptor.host)) {
      info.installed = true;
      info.evidence = "click-to-run";
    }

    apps.push(info);
  }

  return { apps, office };
}

export function productsAllowHost(products: readonly string[], host: OfficeHost): boolean {
  if (products.length === 0) return false;
  const hints = HOST_PRODUCT_HINTS[host];
  return products.some((product) => {
    const normalized = product.toLowerCase();
    if (hints.some((hint) => normalized.includes(hint))) return true;
    return SUITE_PRODUCT_HINTS.some((hint) => normalized.includes(hint));
  });
}

async function detectWindowsSideload(deps: DetectDeps): Promise<OfficeSideloadState> {
  const searched: string[] = [];
  const problems: string[] = [];
  const entries: SideloadEntry[] = [];

  for (const key of windowsDeveloperRegistryKeys()) {
    searched.push(key);
    const registryKeys = await queryRegistryTree(deps.runner, key);
    for (const registryKey of registryKeys) {
      for (const value of registryKey.values) {
        const manifestPath = manifestPathFromRegistryValue(value);
        if (!manifestPath) continue;
        entries.push(
          await buildSideloadEntry(
            deps,
            {
              channel: "registry",
              location: registryKey.path,
              slot: value.name,
              manifestPath,
            },
            problems,
          ),
        );
      }
    }
  }

  for (const dir of windowsWefDirectories(deps.env)) {
    searched.push(dir);
    for (const file of await deps.listDirectory(dir)) {
      if (file.kind !== "file" || !isManifestFileName(file.name)) continue;
      entries.push(
        await buildSideloadEntry(
          deps,
          { channel: "wef-folder", location: dir, manifestPath: path.join(dir, file.name) },
          problems,
        ),
      );
    }
  }

  return finalizeSideload(entries, searched, problems);
}

/* -------------------------------------------------------------------- macOS */

async function detectMacInstall(deps: DetectDeps): Promise<OfficeAppInfo[]> {
  const apps: OfficeAppInfo[] = [];
  for (const descriptor of OFFICE_HOST_DESCRIPTORS) {
    const info: OfficeAppInfo = {
      host: descriptor.host,
      label: descriptor.label,
      installed: false,
    };
    for (const bundle of macOfficeBundleCandidates(deps.homedir, descriptor.macApp)) {
      if ((await deps.pathKind(bundle)) === "directory") {
        info.installed = true;
        info.executablePath = bundle;
        info.evidence = "app-bundle";
        break;
      }
    }
    apps.push(info);
  }
  return apps;
}

async function detectMacSideload(deps: DetectDeps): Promise<OfficeSideloadState> {
  const searched: string[] = [];
  const problems: string[] = [];
  const entries: SideloadEntry[] = [];

  for (const location of macWefLocations(deps.homedir)) {
    searched.push(location.dir);
    for (const file of await deps.listDirectory(location.dir)) {
      if (file.kind !== "file" || !isManifestFileName(file.name)) continue;
      entries.push(
        await buildSideloadEntry(
          deps,
          { channel: "wef-folder", location: location.dir, manifestPath: path.join(location.dir, file.name) },
          problems,
        ),
      );
    }
  }

  return finalizeSideload(entries, searched, problems);
}

/* ------------------------------------------------------------------ shared */

async function buildSideloadEntry(
  deps: DetectDeps,
  input: {
    channel: SideloadChannel;
    location: string;
    slot?: string;
    manifestPath: string;
  },
  problems: string[],
): Promise<SideloadEntry> {
  const xml = await readManifestText(deps, input.manifestPath, problems);
  const manifest = xml ? parseManifest(xml) : null;

  const entry: SideloadEntry = {
    channel: input.channel,
    location: input.location,
    manifestPath: input.manifestPath,
    manifestExists: xml !== null,
    manifestId: manifest?.id ?? null,
    manifestDisplayName: manifest?.displayName ?? null,
    manifestSourceLocations: manifest?.sourceLocations ?? [],
    hosts: manifest ? manifestHostsToOfficeHosts(manifest) : [],
    matchesPiForOffice: manifest ? manifestMatchesPiForOffice(manifest) : false,
    matchesProdSource: manifest ? manifestSourceMatchesProd(manifest) : false,
  };
  if (input.slot) entry.slot = input.slot;
  return entry;
}

async function readManifestText(
  deps: DetectDeps,
  manifestPath: string,
  problems: string[],
): Promise<string | null> {
  const kind = await deps.pathKind(manifestPath);
  if (kind !== "file") {
    problems.push(`Sideload entry points at a missing manifest file: ${manifestPath}`);
    return null;
  }
  const xml = await deps.readFileText(manifestPath);
  if (xml === null) {
    problems.push(`Could not read sideloaded manifest: ${manifestPath}`);
    return null;
  }
  if (xml.length > MAX_MANIFEST_BYTES) {
    problems.push(`Sideloaded manifest is unexpectedly large (${xml.length} bytes): ${manifestPath}`);
    return null;
  }
  return xml;
}

function finalizeSideload(
  entries: readonly SideloadEntry[],
  searched: readonly string[],
  problems: readonly string[],
): OfficeSideloadState {
  const seen = new Set<string>();
  const unique: SideloadEntry[] = [];
  for (const entry of entries) {
    const key = `${entry.channel}|${normalize(entry.manifestPath)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return {
    installed: unique.some((entry) => entry.matchesPiForOffice),
    entries: unique,
    searched: [...new Set(searched)],
    problems: [...new Set(problems)],
  };
}

/** A `WEF\Developer` value whose name or data is a manifest path. */
export function manifestPathFromRegistryValue(value: RegistryValue): string | null {
  const looksLikeManifestPath = (candidate: string): boolean =>
    /\.(xml|manifest)$/i.test(candidate) && /[\\/]/.test(candidate);

  const data = value.data.trim();
  if (looksLikeManifestPath(data)) return data;
  const name = value.name.trim();
  if (looksLikeManifestPath(name)) return name;
  return null;
}

export function isManifestFileName(name: string): boolean {
  return /\.(xml|manifest)$/i.test(name);
}

function buildNotes(input: {
  supported: boolean;
  isWsl: boolean;
  anyAppInstalled: boolean;
  office: DetectedOfficeInstall;
  sideload: OfficeSideloadState;
}): string[] {
  const notes: string[] = [];

  if (!input.supported) {
    notes.push(
      "Desktop Microsoft Office is not available on this platform. Use Office on the web and install the Pi for Office add-in there.",
    );
  }
  if (input.isWsl) {
    notes.push(
      "WSL detected: Office runs on Windows. The bridge must listen on the Windows host and Office must be able to reach 127.0.0.1 there.",
    );
  }
  if (input.supported && !input.anyAppInstalled) {
    notes.push("No Microsoft Office desktop apps were detected on this machine.");
  }
  if (input.office.version) {
    const platform = input.office.platform ? ` (${input.office.platform})` : "";
    notes.push(
      `Detected Office ${input.office.version}${platform} via ${input.office.source ?? "registry"}.`,
    );
  }

  if (input.sideload.installed) {
    notes.push("Pi for Office is already sideloaded.");
    const ours = input.sideload.entries.filter((entry) => entry.matchesPiForOffice);
    if (ours.length > 0 && ours.every((entry) => !entry.matchesProdSource)) {
      notes.push(
        "The sideloaded Pi for Office manifest does not point at the current hosted task pane; re-run the sideload step to update it.",
      );
    }
  } else if (input.supported) {
    notes.push("Pi for Office is not sideloaded yet.");
  }

  const stale = input.sideload.entries.filter((entry) => !entry.manifestExists);
  if (stale.length > 0) {
    notes.push(
      `${stale.length} stale sideload entr${stale.length === 1 ? "y" : "ies"} point at missing manifest files.`,
    );
  }

  const foreign = input.sideload.entries.filter(
    (entry) => entry.manifestExists && !entry.matchesPiForOffice,
  );
  if (foreign.length > 0) {
    notes.push(
      `${foreign.length} other sideloaded add-in manifest${foreign.length === 1 ? "" : "s"} found (left untouched).`,
    );
  }

  return notes;
}

/** Plain-text report used by "copy diagnostics" and the troubleshooting panel. */
export function formatDetectionReport(result: OfficeDetectionResult): string {
  const lines: string[] = [];
  lines.push("Pi Desktop — Office environment report");
  lines.push(`checked: ${result.checkedAt}`);
  lines.push(`os: ${result.os}${result.isWsl ? " (WSL)" : ""}`);
  lines.push(
    `office: ${result.office.version ?? "unknown"}${
      result.office.platform ? ` (${result.office.platform})` : ""
    }${result.office.source ? ` via ${result.office.source}` : ""}`,
  );
  if (result.office.products.length > 0) {
    lines.push(`products: ${result.office.products.join(", ")}`);
  }
  lines.push(
    `apps: ${result.apps
      .map((app) => `${app.label}=${app.installed ? (app.executablePath ?? app.evidence ?? "yes") : "no"}`)
      .join(", ")}`,
  );
  lines.push(`sideloaded: ${result.sideload.installed ? "yes" : "no"}`);
  for (const entry of result.sideload.entries) {
    lines.push(
      `  - ${entry.channel} ${entry.location}${entry.slot ? ` [${entry.slot}]` : ""} ` +
        `id=${entry.manifestId ?? "?"} prodSource=${entry.matchesProdSource ? "yes" : "no"} ` +
        `exists=${entry.manifestExists ? "yes" : "no"} path=${entry.manifestPath}`,
    );
  }
  if (result.sideload.problems.length > 0) {
    lines.push("problems:");
    for (const problem of result.sideload.problems) lines.push(`  - ${problem}`);
  }
  lines.push(`searched: ${result.sideload.searched.join(", ") || "(none)"}`);
  if (result.notes.length > 0) {
    lines.push("notes:");
    for (const note of result.notes) lines.push(`  - ${note}`);
  }
  return lines.join("\n");
}

function envValue(env: NodeJS.ProcessEnv, ...names: readonly string[]): string | null {
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

function normalize(candidate: string): string {
  return process.platform === "win32" ? candidate.toLowerCase() : candidate;
}
