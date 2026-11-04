/**
 * Workspace file listing for `@` completion, `files.list` and Explorer search.
 *
 * Two strategies, in order:
 *  1. `git ls-files -co --exclude-standard -z` when the runtime has git and the
 *     root is a repository: exact gitignore semantics, instant on large trees.
 *  2. A pruning walk with the `.gitignore` matcher for everything else
 *     (including a repo with no git on `PATH`).
 *
 * Both paths skip `.git` and `node_modules` unconditionally — the same
 * exclusions Pi's own file tool passes to `fd` — cap the result, and report
 * `truncated` so the UI can say the list is partial instead of quietly lying.
 *
 * `includeIgnored` is deliberately backed by the walk only. `git ls-files -co`
 * also returns ignored files, but a large build tree can exceed the runner's
 * stdout cap; the walk can stop at the same file limit and report truncation.
 *
 * All filesystem access goes through `FileListingIo`, so the module is pure
 * enough to test against an in-memory tree (AGENTS.md rule 2).
 */

import { isIgnored, parseGitignore, type IgnoreRule } from "./gitignore";

export interface DirectoryEntry {
  name: string;
  directory: boolean;
}

export interface FileListingIo {
  /** Directory entries with their kind; empty when the directory is unreadable. */
  readDirectory(directory: string): Promise<DirectoryEntry[]>;
  /** File text, or null when it is missing or unreadable. */
  readTextFile(target: string): Promise<string | null>;
  /** `git ls-files -co --exclude-standard -z` in the root; null without git. */
  runGit?(root: string, args: readonly string[]): Promise<string | null>;
}

export interface FileListingOptions {
  limit?: number;
  maxDepth?: number;
  /** Include dotfiles/dot-directories (default true). */
  includeHidden?: boolean;
  /** Include git-ignored files (default false). */
  includeIgnored?: boolean;
}

export interface FileListing {
  /** Relative POSIX paths, sorted; files only (directories are implied by `/`). */
  files: string[];
  truncated: boolean;
}

export const DEFAULT_FILE_LIMIT = 2000;
export const MAX_FILE_LIMIT = 20_000;
export const MAX_WALK_DEPTH = 16;
/** Bounds traversal, not just output, on pathological trees. */
export const MAX_WALK_DIRECTORIES = 5000;

/** Always excluded, matching the `--exclude` set Pi's find tool uses. */
export const ALWAYS_IGNORED = [".git", "node_modules"] as const;

export async function listWorkspaceFiles(
  io: FileListingIo,
  root: string,
  options: FileListingOptions = {},
): Promise<FileListing> {
  const limit = clampLimit(options.limit);
  const includeHidden = options.includeHidden ?? true;
  const includeIgnored = options.includeIgnored ?? false;

  // Ignored-inclusive listings use the walk: git would emit every ignored file
  // (including a huge build tree) before we could cap it.
  if (!includeIgnored) {
    const fromGit = await listFromGit(io, root, limit, includeHidden);
    if (fromGit) return fromGit;
  }
  return walkWorkspace(io, root, {
    limit,
    maxDepth: Math.max(1, options.maxDepth ?? MAX_WALK_DEPTH),
    includeHidden,
    includeIgnored,
  });
}

/** The git fast path; null means "git could not answer, walk instead". */
async function listFromGit(
  io: FileListingIo,
  root: string,
  limit: number,
  includeHidden: boolean,
): Promise<FileListing | null> {
  if (!io.runGit) return null;
  const args = [
    "ls-files",
    "-co",
    "-z",
    "--exclude-standard",
    "--exclude=node_modules",
    "--exclude=.git",
  ];
  const output = await io.runGit(root, args);
  if (output === null) return null;

  const files = output
    .split("\0")
    .map((entry) => entry.replace(/\\/g, "/").trim())
    .filter(
      (entry) =>
        entry.length > 0 &&
        !hasAlwaysIgnoredSegment(entry) &&
        (includeHidden || !hasHiddenSegment(entry)),
    )
    .sort(comparePaths);

  const truncated = files.length > limit;
  return { files: truncated ? files.slice(0, limit) : files, truncated };
}

interface WalkState {
  path: string;
  depth: number;
  rules: readonly IgnoreRule[];
}

async function walkWorkspace(
  io: FileListingIo,
  root: string,
  options: { limit: number; maxDepth: number; includeHidden: boolean; includeIgnored: boolean },
): Promise<FileListing> {
  const files: string[] = [];
  let truncated = false;
  let directories = 0;

  const queue: WalkState[] = [
    {
      path: "",
      depth: 0,
      rules: options.includeIgnored ? [] : await readIgnoreRules(io, root, ""),
    },
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;
    directories += 1;
    if (directories > MAX_WALK_DIRECTORIES) {
      truncated = true;
      break;
    }

    const directory =
      current.path.length === 0 ? root : `${root.replace(/\/+$/, "")}/${current.path}`;
    const entries = await io.readDirectory(directory);
    if (entries.length === 0) continue;

    // A nested .gitignore adds to the rules inherited from its parents. An
    // ignored-inclusive search skips the matcher entirely (and its file reads).
    const rules =
      options.includeIgnored || current.path.length === 0
        ? current.rules
        : [...current.rules, ...(await readIgnoreRules(io, root, current.path))];

    const ordered = [...entries].sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of ordered) {
      if (hasAlwaysIgnoredSegment(entry.name)) continue;
      if (!options.includeHidden && entry.name.startsWith(".")) continue;
      const path = current.path.length === 0 ? entry.name : `${current.path}/${entry.name}`;
      if (!options.includeIgnored && isIgnored(rules, path, entry.directory)) continue;

      if (entry.directory) {
        if (current.depth + 1 <= options.maxDepth) {
          queue.push({ path, depth: current.depth + 1, rules });
        }
        continue;
      }

      files.push(path);
      if (files.length > options.limit) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  files.sort(comparePaths);
  return { files: truncated ? files.slice(0, options.limit) : files, truncated };
}

async function readIgnoreRules(
  io: FileListingIo,
  root: string,
  relativeDirectory: string,
): Promise<IgnoreRule[]> {
  const target =
    relativeDirectory.length === 0
      ? `${root.replace(/\/+$/, "")}/.gitignore`
      : `${root.replace(/\/+$/, "")}/${relativeDirectory}/.gitignore`;
  const contents = await io.readTextFile(target);
  return contents === null ? [] : parseGitignore(contents);
}

function hasAlwaysIgnoredSegment(path: string): boolean {
  return path.split("/").some((segment) => (ALWAYS_IGNORED as readonly string[]).includes(segment));
}

function hasHiddenSegment(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."));
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_FILE_LIMIT;
  return Math.min(Math.floor(limit), MAX_FILE_LIMIT);
}

/** Stable, case-insensitive-then-case-sensitive ordering for deterministic output. */
function comparePaths(left: string, right: string): number {
  const lowerLeft = left.toLowerCase();
  const lowerRight = right.toLowerCase();
  if (lowerLeft !== lowerRight) return lowerLeft < lowerRight ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
