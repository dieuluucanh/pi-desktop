/**
 * Reading and writing Pi's `settings.json`.
 *
 * The app shares the terminal Pi profile, so this file is the single most
 * sensitive thing the wizard touches: writes are atomic, malformed files are
 * never overwritten, and the two documented `packages` entry shapes (string and
 * filtered object) are both preserved.
 */

import type { FsPort } from "../fs-port";
import * as path from "node:path";

import { parsePackageSource, tryParsePackageSource } from "./spec";

export type PackageEntry = string | { source: string; [key: string]: unknown };
export type SettingsDocument = Record<string, unknown>;

export class SettingsParseError extends Error {
  constructor(
    readonly filePath: string,
    cause: unknown,
  ) {
    super(`Invalid JSON in ${filePath}; refusing to modify it.`, { cause });
    this.name = "SettingsParseError";
  }
}

export function readPackageEntries(doc: SettingsDocument): PackageEntry[] {
  const raw = doc.packages;
  if (!Array.isArray(raw)) return [];
  const out: PackageEntry[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      out.push(entry);
      continue;
    }
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as { source?: unknown }).source === "string"
    ) {
      out.push(entry as { source: string });
    }
  }
  return out;
}

export interface UpsertOutcome {
  packages: PackageEntry[];
  action: "added" | "replaced" | "unchanged";
  previousSource: string | null;
  nextSource: string;
}

/** Adds or re-pins a package, preserving any per-package filters. */
export function upsertPackageSource(
  packages: readonly PackageEntry[] | undefined,
  source: string,
): UpsertOutcome {
  const parsed = parsePackageSource(source);
  const list: PackageEntry[] = [...(packages ?? [])];

  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index];
    if (entry === undefined) continue;
    const entrySource = typeof entry === "string" ? entry : entry.source;
    const existing = tryParsePackageSource(entrySource);
    if (!existing || existing.identity !== parsed.identity) continue;

    if (entrySource === parsed.source) {
      return {
        packages: list,
        action: "unchanged",
        previousSource: entrySource,
        nextSource: parsed.source,
      };
    }

    list[index] = typeof entry === "string" ? parsed.source : { ...entry, source: parsed.source };
    return {
      packages: list,
      action: "replaced",
      previousSource: entrySource,
      nextSource: parsed.source,
    };
  }

  list.push(parsed.source);
  return { packages: list, action: "added", previousSource: null, nextSource: parsed.source };
}

export function removePackageSource(
  packages: readonly PackageEntry[] | undefined,
  source: string,
): { packages: PackageEntry[]; removed: string[] } {
  const target = tryParsePackageSource(source);
  const removed: string[] = [];
  const list: PackageEntry[] = [];

  for (const entry of packages ?? []) {
    const entrySource = typeof entry === "string" ? entry : entry.source;
    const existing = tryParsePackageSource(entrySource);
    if (target && existing && existing.identity === target.identity) {
      removed.push(entrySource);
      continue;
    }
    list.push(entry);
  }

  return { packages: list, removed };
}

export function hasPackageSource(
  packages: readonly PackageEntry[] | undefined,
  source: string,
): boolean {
  const target = tryParsePackageSource(source);
  if (!target) return false;
  return (packages ?? []).some((entry) => {
    const entrySource = typeof entry === "string" ? entry : entry.source;
    const existing = tryParsePackageSource(entrySource);
    return existing?.identity === target.identity;
  });
}

export async function readSettingsDocument(
  fs: FsPort,
  filePath: string,
): Promise<SettingsDocument> {
  const text = await fs.readTextFile(filePath);
  if (text === null || text.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SettingsParseError(filePath, new Error("settings root must be an object"));
    }
    return parsed as SettingsDocument;
  } catch (error) {
    if (error instanceof SettingsParseError) throw error;
    throw new SettingsParseError(filePath, error);
  }
}

export function serializeSettingsDocument(doc: SettingsDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Atomic write: temp file + rename, so a crash cannot truncate settings.json. */
export async function writeSettingsDocument(
  fs: FsPort,
  filePath: string,
  doc: SettingsDocument,
): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeTextFile(tempPath, serializeSettingsDocument(doc));
  await fs.rename(tempPath, filePath);
}

export interface AddPackageResult extends UpsertOutcome {
  settingsPath: string;
  changed: boolean;
}

export async function addPackageToSettings(
  fs: FsPort,
  filePath: string,
  source: string,
): Promise<AddPackageResult> {
  const doc = await readSettingsDocument(fs, filePath);
  const outcome = upsertPackageSource(readPackageEntries(doc), source);
  const changed = outcome.action !== "unchanged";
  if (changed) {
    await writeSettingsDocument(fs, filePath, { ...doc, packages: outcome.packages });
  }
  return { ...outcome, settingsPath: filePath, changed };
}

export async function removePackageFromSettings(
  fs: FsPort,
  filePath: string,
  source: string,
): Promise<{ removed: string[]; changed: boolean; settingsPath: string }> {
  const doc = await readSettingsDocument(fs, filePath);
  const outcome = removePackageSource(readPackageEntries(doc), source);
  const changed = outcome.removed.length > 0;
  if (changed) {
    await writeSettingsDocument(fs, filePath, { ...doc, packages: outcome.packages });
  }
  return { removed: outcome.removed, changed, settingsPath: filePath };
}

/** One-off backup of a settings/auth file before the app first rewrites it. */
export async function backupFile(
  fs: FsPort,
  filePath: string,
  backupDir: string,
  stamp: string,
): Promise<string | null> {
  const contents = await fs.readTextFile(filePath);
  if (contents === null) return null;
  const name = filePath.split(/[\\/]/).pop() ?? "settings.json";
  const target = path.join(backupDir, `${name}.${stamp}.bak`);
  await fs.writeTextFile(target, contents);
  return target;
}
