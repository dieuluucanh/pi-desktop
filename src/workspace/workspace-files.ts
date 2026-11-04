/**
 * Workspace file access for `files.read` / `files.write` (plan step 23).
 *
 * The renderer can ask a session host to read or write a file, and the only
 * thing standing between that request and the user's whole disk is this module:
 * every path is resolved against the session's own cwd and must survive both the
 * lexical and the symlink containment checks in `path-guard.ts`. A path the
 * caller cannot justify is refused with `forbidden`, never silently clamped.
 *
 * The filesystem is an injected port (`WorkspaceFileIo`), so the rules are unit
 * tested against a real temp directory *and* an in-memory tree. Sizes are capped
 * on both directions: a read cannot stream a multi-gigabyte log into the frame
 * protocol, and a write cannot replace a source file with a payload the UI never
 * meant to produce.
 */

import { relative } from "node:path";

import { resolveInsideRoot, type RealPathIo } from "./path-guard";

export interface WorkspaceFileIo extends RealPathIo {
  /** File size in bytes, or null when the path is missing or is not a file. */
  statFile(target: string): Promise<{ size: number } | null>;
  /**
   * UTF-8 text, truncated at `maxBytes` (never a partial multi-byte character).
   * Null when the file is missing or unreadable.
   */
  readFile(target: string, maxBytes: number): Promise<{ text: string; truncated: boolean } | null>;
  /** Replaces the file atomically, creating it if absent. */
  writeFile(target: string, text: string): Promise<void>;
}

/** The read cap the renderer can raise up to; a file, not a database. */
export const DEFAULT_WORKSPACE_READ_BYTES = 512_000;
export const MAX_WORKSPACE_READ_BYTES = 5_000_000;
/** The write cap; large enough for a real edit, small enough to stay a file. */
export const MAX_WORKSPACE_WRITE_BYTES = 2_000_000;

/** A refused or impossible file operation, carrying a protocol error code. */
export class WorkspaceFileError extends Error {
  readonly code: string;

  constructor(message: string, code = "bad_request") {
    super(message);
    this.name = "WorkspaceFileError";
    this.code = code;
  }
}

export interface WorkspaceReadResult {
  /** Absolute resolved path (for Diagnostics, not for the transcript). */
  path: string;
  /** POSIX-style path relative to the session cwd, for display. */
  relativePath: string;
  text: string;
  bytes: number;
  truncated: boolean;
}

export interface WorkspaceReadOptions {
  limit?: number;
}

function clampReadLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_WORKSPACE_READ_BYTES;
  }
  return Math.min(Math.floor(limit), MAX_WORKSPACE_READ_BYTES);
}

function displayPath(root: string, target: string): string {
  const rel = relative(root, target).replace(/\\/g, "/");
  return rel.length === 0 ? "." : rel;
}

/** Reads one workspace file, refusing anything outside the session folder. */
export async function readWorkspaceFile(
  io: WorkspaceFileIo,
  cwd: string,
  requested: unknown,
  options: WorkspaceReadOptions = {},
): Promise<WorkspaceReadResult> {
  const target = await resolveInsideRoot(io, cwd, requested);
  if (target === null) {
    throw new WorkspaceFileError("that path is outside the session folder", "forbidden");
  }
  const info = await io.statFile(target);
  if (info === null) {
    throw new WorkspaceFileError(`no such file: ${String(requested)}`, "not_found");
  }
  const maxBytes = clampReadLimit(options.limit);
  const read = await io.readFile(target, maxBytes);
  if (read === null) {
    throw new WorkspaceFileError(`could not read: ${String(requested)}`, "not_found");
  }
  return {
    path: target,
    relativePath: displayPath(cwd, target),
    text: read.text,
    bytes: Buffer.byteLength(read.text, "utf8"),
    truncated: read.truncated,
  };
}

/** Writes one workspace file, refusing anything outside the session folder. */
export async function writeWorkspaceFile(
  io: WorkspaceFileIo,
  cwd: string,
  requested: unknown,
  text: unknown,
): Promise<{ path: string; relativePath: string; bytes: number }> {
  if (typeof text !== "string") {
    throw new WorkspaceFileError("files.write requires text", "bad_request");
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_WORKSPACE_WRITE_BYTES) {
    throw new WorkspaceFileError(
      `the file is larger than the ${MAX_WORKSPACE_WRITE_BYTES}-byte write limit`,
      "bad_request",
    );
  }
  const target = await resolveInsideRoot(io, cwd, requested);
  if (target === null) {
    throw new WorkspaceFileError("that path is outside the session folder", "forbidden");
  }
  await io.writeFile(target, text);
  return { path: target, relativePath: displayPath(cwd, target), bytes };
}
