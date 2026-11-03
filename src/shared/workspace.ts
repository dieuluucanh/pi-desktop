/**
 * Workspace wire types and path rules.
 *
 * This module is shared by the main process, the preload, the renderer and the
 * pure `src/workspace` engines. It must therefore stay free of Node and DOM
 * dependencies: paths are strings, sorting is pure, and the result envelope is
 * plain JSON.
 *
 * The path rule is deliberately strict. A renderer path is *project-relative
 * POSIX*; absolute paths, drive letters, backslashes, `.`/`..`, empty segments
 * and `.git` are rejected here, before main resolves the path again with the
 * realpath guard. The two checks are intentionally redundant.
 */

export const MAX_WORKSPACE_PATH_LENGTH = 4_096;

export const MAX_ENTRY_NAME_LENGTH = 255;
export const MAX_TRANSFER_SOURCES = 100;
export const MAX_TRANSFER_ENTRIES = 10_000;
export const MAX_TRANSFER_BYTES = 2_000_000_000;

export const MAX_DIRECTORY_ENTRIES = 2_000;
export const MAX_QUICK_OPEN_FILES = 20_000;
export const DEFAULT_WORKSPACE_SEARCH_LIMIT = 200;
export const MAX_WORKSPACE_SEARCH_LIMIT = 500;
export const MAX_WORKSPACE_SEARCH_QUERY_LENGTH = 512;
export const MAX_EDITOR_READ_BYTES = 5_000_000;
export const MAX_EDITOR_WRITE_BYTES = 2_000_000;
export const MAX_BACKUP_BYTES = 4_000_000;
export const MAX_BACKUP_AGE_MS = 30 * 24 * 60 * 60_000;

export type WorkspaceEntryKind = "file" | "directory";

/** One directory entry, as returned by `workspace:list-directory`. */
export interface WorkspaceEntry {
  /** Base name, for display. */
  name: string;
  /** Project-relative POSIX path. */
  path: string;
  kind: WorkspaceEntryKind;
  /** Bytes for files; null for directories and unknown stats. */
  size: number | null;
  mtimeMs: number | null;
  /** Dotfile/dot-directory. */
  hidden: boolean;
  /** Matched by git's ignore rules. */
  ignored: boolean;
  /** The entry itself is a symbolic link. */
  symlink: boolean;
  /** A symlink whose target escapes the project root; never openable. */
  outside: boolean;
}

export interface WorkspaceListing {
  root: string;
  /** The requested directory, project-relative; "" is the root. */
  path: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
}

export interface WorkspaceFileList {
  root: string;
  /** Project-relative POSIX paths, sorted. */
  files: string[];
  truncated: boolean;
}

/** One `workspace:search-files` request. */
export interface WorkspaceSearchRequest {
  projectPath: string;
  /** The user's query; matched against file names and paths. */
  query: string;
  /** Dotfiles/dot-directories are included (default true). */
  includeHidden?: boolean;
  /** Git-ignored files are included (default false). */
  includeIgnored?: boolean;
  /** Maximum matches to return (default 200, capped at 500). */
  limit?: number;
}

/** One ranked search result. */
export interface WorkspaceSearchMatch {
  /** Project-relative POSIX path. */
  path: string;
  /** Base name, for display. */
  name: string;
  /** Parent directory, or "" for a root-level file. */
  directory: string;
}

export interface WorkspaceSearchResult {
  root: string;
  query: string;
  matches: WorkspaceSearchMatch[];
  /** A scan or result cap cut the list; the UI must say so. */
  truncated: boolean;
  /** Candidate files considered before ranking. */
  scanned: number;
}

export type FileContentKind = "text" | "binary" | "too_large" | "unsupported_encoding";
export type FileEncoding = "utf8" | "utf16le" | "utf16be" | "binary";
export type FileEol = "lf" | "crlf";

export interface WorkspaceFileContent {
  /** Absolute path, for Diagnostics only; never render this in the tree. */
  path: string;
  relativePath: string;
  kind: FileContentKind;
  text: string | null;
  bytes: number;
  size: number;
  mtimeMs: number;
  truncated: boolean;
  eol: FileEol;
  /** UTF-8 BOM present; the text has already had the BOM stripped. */
  bom: boolean;
  encoding: FileEncoding;
}

export interface WorkspaceStat {
  path: string;
  relativePath: string;
  kind: WorkspaceEntryKind;
  size: number;
  mtimeMs: number;
}

export interface WorkspaceWriteInput {
  projectPath: string;
  path: string;
  text: string;
  eol?: FileEol;
  bom?: boolean;
  /**
   * The mtime the editor loaded. `null` means "the file did not exist when I
   * opened it"; a numeric value is compared with a 1 ms tolerance. Omit to skip
   * the check (only used by explicit overwrite flows).
   */
  expectedMtimeMs?: number | null;
  /** Overwrite despite a changed mtime (the user chose "Overwrite"). */
  force?: boolean;
}

export interface WorkspaceWriteResult {
  path: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
  bytes: number;
}

export interface ResolvedEditorConfig {
  indentStyle: "space" | "tab";
  indentSize: number;
  tabWidth: number;
  endOfLine: FileEol;
  insertFinalNewline: boolean;
  trimTrailingWhitespace: boolean;
}

/** A backup record written to `<userData>/editor-backups/<tabId>.json`. */
export interface EditorBackup {
  version: 1;
  tabId: string;
  projectPath: string;
  path: string;
  /** CodeMirror text (always LF-normalized). */
  text: string;
  updatedAt: number;
  /** The on-disk mtime the buffer was based on, or null for a new file. */
  baselineMtimeMs: number | null;
  eol: FileEol;
  bom: boolean;
}

export type WorkspaceFailureCode =
  | "bad_request"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "too_large"
  | "unsupported_encoding"
  | "not_configured"
  | "formatter_failed"
  | "unavailable";

export interface WorkspaceFailure {
  code: WorkspaceFailureCode;
  message: string;
  /** Present on `conflict`: what the disk looked like when the write was refused. */
  current?: { mtimeMs: number; size: number };
}

/**
 * IPC results use an envelope instead of a rejected promise: Electron's IPC
 * boundary drops custom Error fields, so a `conflict` code and its current stat
 * have to travel as data.
 */
export type WorkspaceResult<T> = { ok: true; value: T } | { ok: false; error: WorkspaceFailure };

export function workspaceOk<T>(value: T): WorkspaceResult<T> {
  return { ok: true, value };
}

export function workspaceFailure(
  code: WorkspaceFailureCode,
  message: string,
  current?: { mtimeMs: number; size: number },
): WorkspaceResult<never> {
  return { ok: false, error: current ? { code, message, current } : { code, message } };
}

export interface WorkspaceDirectoryRequest {
  projectPath: string;
  /** "" for the root. */
  path: string;
  /** Display order; defaults to name. */
  sort?: WorkspaceSort;
}

export interface WorkspaceListRequest {
  projectPath: string;
  limit?: number;
}

export interface WorkspacePathRequest {
  projectPath: string;
  path: string;
}

export type WorkspaceReadRequest = WorkspacePathRequest;
export type WorkspaceRevealRequest = WorkspacePathRequest;
export type WorkspaceEditorConfigRequest = WorkspacePathRequest;
export type WorkspaceWriteRequest = WorkspaceWriteInput;

export interface WorkspaceFormatRequest {
  projectPath: string;
  path: string;
  languageId: string;
  text: string;
}

export interface WorkspaceFormatResult {
  text: string;
  formatter: "prettier" | "command";
}

export interface WorkspaceCreateInput {
  projectPath: string;
  /** Project-relative path including the new entry's name. */
  path: string;
  kind: WorkspaceEntryKind;
}

export interface WorkspaceRenameInput {
  projectPath: string;
  /** Existing project-relative path. */
  path: string;
  /** New project-relative path; the parent must not change. */
  toPath: string;
}

export interface WorkspaceDeleteInput {
  projectPath: string;
  path: string;
}

export interface WorkspaceTransferInput {
  sourceProjectPath: string;
  targetProjectPath: string;
  /** Project-relative paths under the source project. */
  sources: string[];
  /** "" for the target project root. */
  targetDirectory: string;
  operation: "copy" | "move";
}

export interface WorkspaceMutationResult {
  /** Project-relative path of the entry after the operation. */
  path: string;
  /** Absolute path, for diagnostics and reveal only. */
  absolutePath: string;
  kind: WorkspaceEntryKind;
  /** Present on rename/move: the project-relative path before the operation. */
  previousPath?: string;
}

export interface WorkspaceTransferResult {
  operation: "copy" | "move";
  transferred: Array<{
    sourcePath: string;
    targetPath: string;
    kind: WorkspaceEntryKind;
  }>;
}

/** True when a character is a C0/C1 control/format character we never accept. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * True when a value is a usable project-relative POSIX path.
 *
 * Rejects: non-strings, empty/oversized values, control characters, leading
 * slash, backslashes, drive letters/UNC prefixes, empty segments, `.`/`..`,
 * trailing slashes and anything under `.git`.
 */
export function isWorkspaceRelativePath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_WORKSPACE_PATH_LENGTH) return false;
  if (hasControlCharacter(value)) return false;
  if (value.includes("\\")) return false;
  if (value.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(value)) return false;

  const segments = value.split("/");
  for (const segment of segments) {
    if (segment.length === 0) return false;
    if (segment === "." || segment === "..") return false;
  }
  if ((segments[0] ?? "").toLowerCase() === ".git") return false;
  return true;
}

/** The last path segment of a project-relative POSIX path. */
export function workspaceBasename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/** The parent of a project-relative POSIX path; "" for a root-level entry. */
export function workspaceDirname(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash <= 0 ? "" : trimmed.slice(0, slash);
}

/** Joins path segments with `/` without resolving `..` (the caller validates). */
export function workspaceJoin(...parts: readonly string[]): string {
  return parts
    .flatMap((part) => part.split("/"))
    .filter((part) => part.length > 0)
    .join("/");
}

/** True when two project-relative paths name the same entry. */
export function sameWorkspacePath(left: string, right: string, caseInsensitive = false): boolean {
  return caseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right;
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const INVALID_ENTRY_CHARACTER = /[<>:"/\\|?*]/;

/**
 * True when a value can be used as one project entry name.
 *
 * The rules are stricter than the host platform on purpose: a project can be
 * moved between Windows and POSIX, so names that Windows refuses are refused
 * everywhere. Leading dots are allowed (`.env`, `.gitignore`); `.`/`..` and
 * `.git` are not entry names.
 */
export function isWorkspaceEntryName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_ENTRY_NAME_LENGTH) return false;
  if (value === "." || value === "..") return false;
  if (value.toLowerCase() === ".git") return false;
  if (hasControlCharacter(value)) return false;
  if (INVALID_ENTRY_CHARACTER.test(value)) return false;
  if (/[. ]$/.test(value)) return false;
  return !WINDOWS_RESERVED_NAME.test(value);
}

/** The absolute path of a project-relative entry, using the project's separators. */
export function workspaceAbsolutePath(projectPath: string, relativePath: string): string {
  const root = projectPath.replace(/[\\/]+$/, "");
  const separator = projectPath.includes("\\") ? "\\" : "/";
  return `${root}${separator}${relativePath.split("/").join(separator)}`;
}

/** A project-relative path rendered with the platform separators of its root. */
export function workspaceDisplayRelativePath(projectPath: string, relativePath: string): string {
  const separator = projectPath.includes("\\") ? "\\" : "/";
  return relativePath.split("/").join(separator);
}

/**
 * True when `path` is `prefix` (a file rename) or lives under it (a directory
 * rename/delete). The prefix boundary is always a `/`, so `src/a` does not match
 * `src/ab`.
 */
export function isWorkspacePathWithin(
  path: string,
  prefix: string,
  kind: WorkspaceEntryKind,
  caseInsensitive = false,
): boolean {
  const left = caseInsensitive ? path.toLowerCase() : path;
  const right = caseInsensitive ? prefix.toLowerCase() : prefix;
  if (kind === "file") return left === right;
  return left === right || left.startsWith(`${right}/`);
}

/** Lower-case extension without the dot, or "" for a name without one. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

export type WorkspaceSort = "name" | "type" | "modified";

const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Sorts directory entries for display. Directories always come first, then the
 * chosen key. A stable name tie-breaker keeps the order deterministic.
 */
export function sortWorkspaceEntries(
  entries: readonly WorkspaceEntry[],
  sort: WorkspaceSort = "name",
): WorkspaceEntry[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    if (sort === "modified") {
      const byTime = (right.mtimeMs ?? 0) - (left.mtimeMs ?? 0);
      if (byTime !== 0) return byTime;
    } else if (sort === "type") {
      const byType = NAME_COLLATOR.compare(extensionOf(left.name), extensionOf(right.name));
      if (byType !== 0) return byType;
    }
    return NAME_COLLATOR.compare(left.name, right.name);
  });
}
