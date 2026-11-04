/**
 * Lazy directory listing for the file explorer.
 *
 * The explorer expands one directory at a time; this engine answers exactly
 * that request. It returns display metadata (kind, size, mtime, hidden,
 * ignored, symlink, outside) and never recurses, so a 50 000-file
 * `node_modules` costs nothing until the user opens it.
 *
 * Containment is the same realpath guard the host file handlers use: a symlink
 * that escapes the project is returned with `outside: true` and the UI refuses
 * to open it. `.git` is excluded from the tree (and refused for writes by the
 * content engine).
 *
 * `checkIgnored` is a batched git port. When git is unavailable the engine
 * falls back to the small `.gitignore` matcher used by `@` completion, which is
 * approximate for nested anchored patterns but never hides a file that is not
 * ignored by a rule read from the root-to-directory chain.
 */

import { join, relative } from "node:path";

import {
  MAX_DIRECTORY_ENTRIES,
  isWorkspaceRelativePath,
  sortWorkspaceEntries,
  type WorkspaceEntry,
  type WorkspaceSort,
} from "../shared/workspace";
import { isIgnored, parseGitignore, type IgnoreRule } from "./gitignore";
import { isPathInside, resolveInsideRoot, type RealPathIo } from "./path-guard";

export interface TreeDirectoryEntry {
  name: string;
  directory: boolean;
  /** `Dirent.isSymbolicLink()`. */
  symlink: boolean;
}

export interface TreeStat {
  kind: "file" | "directory";
  size: number;
  mtimeMs: number;
  symlink: boolean;
}

export interface WorkspaceTreeIo extends RealPathIo {
  readDirectory(target: string): Promise<TreeDirectoryEntry[]>;
  stat(target: string): Promise<TreeStat | null>;
  readTextFile(target: string): Promise<string | null>;
  /**
   * Batched `git check-ignore`. Returns null when git is unavailable or the
   * folder is not a repository; the engine then falls back to `.gitignore`.
   */
  checkIgnored?(root: string, relativePaths: readonly string[]): Promise<Set<string> | null>;
}

export type WorkspaceTreeErrorCode = "bad_request" | "forbidden" | "not_found";

export class WorkspaceTreeError extends Error {
  readonly code: WorkspaceTreeErrorCode;

  constructor(message: string, code: WorkspaceTreeErrorCode) {
    super(message);
    this.name = "WorkspaceTreeError";
    this.code = code;
  }
}

export interface ListDirectoryOptions {
  /** Visible entries per directory, after filtering. Defaults to 2 000. */
  limit?: number;
  sort?: WorkspaceSort;
}

export interface ListDirectoryResult {
  root: string;
  /** The requested directory, project-relative; "" is the root. */
  path: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
}

function asRelative(root: string, target: string): string {
  return relative(root, target).replace(/\\/g, "/");
}

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return MAX_DIRECTORY_ENTRIES;
  }
  return Math.min(MAX_DIRECTORY_ENTRIES, Math.floor(value));
}

function isGitSegment(name: string): boolean {
  return name.toLowerCase() === ".git";
}

/** Reads the `.gitignore` files from the root down to `directory`. */
async function loadIgnoreRules(
  io: WorkspaceTreeIo,
  root: string,
  directory: string,
): Promise<IgnoreRule[]> {
  const rules: IgnoreRule[] = [];
  const segments = directory.length === 0 ? [] : directory.split("/");
  // The root file first, then each nested directory in order.
  for (let count = 0; count <= segments.length; count += 1) {
    const base = segments.slice(0, count).join("/");
    const target = join(root, base, ".gitignore");
    const contents = await io.readTextFile(target).catch(() => null);
    if (contents !== null) rules.push(...parseGitignore(contents));
  }
  return rules;
}

/**
 * Lists one directory. `relativeDirectory` is `""` for the project root.
 *
 * Throws {@link WorkspaceTreeError} for a missing/forbidden/non-directory path;
 * the service maps that to a `WorkspaceResult` failure.
 */
export async function listWorkspaceDirectory(
  io: WorkspaceTreeIo,
  root: string,
  relativeDirectory: unknown,
  options: ListDirectoryOptions = {},
): Promise<ListDirectoryResult> {
  const requested = relativeDirectory === undefined ? "" : relativeDirectory;
  if (typeof requested !== "string") {
    throw new WorkspaceTreeError("a directory path must be a string", "bad_request");
  }
  if (requested.length > 0 && !isWorkspaceRelativePath(requested)) {
    throw new WorkspaceTreeError("that path is not inside the project", "forbidden");
  }

  const target = requested.length === 0 ? root : await resolveInsideRoot(io, root, requested);
  if (target === null) {
    throw new WorkspaceTreeError("that path is outside the project", "forbidden");
  }

  const directoryStat = await io.stat(target);
  if (directoryStat === null) {
    throw new WorkspaceTreeError(`no such directory: ${requested || "."}`, "not_found");
  }
  if (directoryStat.kind !== "directory") {
    throw new WorkspaceTreeError(`not a directory: ${requested}`, "bad_request");
  }

  const rawEntries = await io.readDirectory(target);
  const entries = rawEntries.filter((entry) => !isGitSegment(entry.name));
  const realRoot = (await io.realpath(root).catch(() => null)) ?? root;
  const relativePaths = entries.map((entry) =>
    requested.length === 0 ? entry.name : `${requested}/${entry.name}`,
  );

  let ignored: Set<string> | null = null;
  if (io.checkIgnored) {
    ignored = await io.checkIgnored(root, relativePaths).catch(() => null);
  }
  const fallbackRules = ignored === null ? await loadIgnoreRules(io, root, requested) : [];

  const listed: WorkspaceEntry[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const path = relativePaths[index]!;
    const absolute = join(target, entry.name);
    const stat = await io.stat(absolute).catch(() => null);
    const kind = stat?.kind ?? (entry.directory ? "directory" : "file");
    const symlink = entry.symlink || stat?.symlink === true;
    let outside = false;
    if (symlink) {
      const realTarget = await io.realpath(absolute).catch(() => null);
      outside = realTarget === null ? false : !isPathInside(realRoot, realTarget);
    }
    listed.push({
      name: entry.name,
      path,
      kind,
      size: kind === "file" ? (stat?.size ?? null) : null,
      mtimeMs: kind === "file" ? (stat?.mtimeMs ?? null) : null,
      hidden: entry.name.startsWith("."),
      ignored:
        ignored !== null
          ? ignored.has(path) || ignored.has(`${path}/`)
          : isIgnored(fallbackRules, path, kind === "directory"),
      symlink,
      outside,
    });
  }

  const sorted = sortWorkspaceEntries(listed, options.sort ?? "name");
  const limit = clampLimit(options.limit);
  const truncated = sorted.length > limit;
  return {
    root,
    path: requested,
    entries: truncated ? sorted.slice(0, limit) : sorted,
    truncated,
  };
}

/** True when a path is under the project's `.git` directory. */
export function isGitPath(value: string): boolean {
  const first = value.split("/")[0] ?? "";
  return first.toLowerCase() === ".git";
}

/** Re-exported so the content engine and tests share the base-name rule. */
export function displayRelativePath(root: string, absolutePath: string): string {
  return asRelative(root, absolutePath);
}
