/**
 * Text content for the editor (read, stat, write).
 *
 * This is the UI-facing superset of `workspace-files.ts` (which remains the
 * agent-facing `files.read`/`files.write` contract). It adds what an editor
 * needs and a tool call does not: BOM/EOL detection, binary and UTF-16
 * recognition, an expected-mtime conflict check, and an atomic write that
 * preserves the file's mode.
 *
 * Sizes are capped in both directions. A read never streams a multi-gigabyte
 * log into the frame protocol; a write never replaces a source file with a
 * payload the UI did not mean to produce. Both rules live here, not in the IPC
 * layer, so every caller (main, tests, future tools) gets them.
 */

import { Buffer } from "node:buffer";

import {
  MAX_EDITOR_READ_BYTES,
  MAX_EDITOR_WRITE_BYTES,
  isWorkspaceRelativePath,
  type FileEncoding,
  type FileEol,
  type WorkspaceFileContent,
  type WorkspaceStat,
  type WorkspaceWriteInput,
  type WorkspaceWriteResult,
} from "../shared/workspace";
import { resolveInsideRoot, type RealPathIo } from "./path-guard";

export interface FileContentIo extends RealPathIo {
  statFile(
    target: string,
  ): Promise<{ kind: "file" | "directory"; size: number; mtimeMs: number; mode: number } | null>;
  /** Reads at most `maxBytes`; `truncated` when the file was longer. */
  readBytes(
    target: string,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; truncated: boolean } | null>;
  /** Atomic replace; `mode` is passed through to the platform writer. */
  writeAtomic(target: string, text: string, mode?: number): Promise<void>;
}

export type FileContentErrorCode =
  "bad_request" | "forbidden" | "not_found" | "conflict" | "too_large" | "unsupported_encoding";

export class FileContentError extends Error {
  readonly code: FileContentErrorCode;
  readonly current?: { mtimeMs: number; size: number };

  constructor(
    message: string,
    code: FileContentErrorCode,
    current?: { mtimeMs: number; size: number },
  ) {
    super(message);
    this.name = "FileContentError";
    this.code = code;
    if (current) this.current = current;
  }
}

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  return true;
}

function hasNulByte(bytes: Uint8Array, limit = 8_192): boolean {
  const end = Math.min(bytes.length, limit);
  for (let index = 0; index < end; index += 1) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const found = text.indexOf(needle, from);
    if (found === -1) return count;
    count += 1;
    from = found + needle.length;
  }
}

/** Detects the dominant line ending. No newlines means LF. */
export function detectEol(text: string): FileEol {
  const crlf = countOccurrences(text, "\r\n");
  if (crlf === 0) return "lf";
  const totalLf = countOccurrences(text, "\n");
  const lfOnly = totalLf - crlf;
  return crlf > lfOnly ? "crlf" : "lf";
}

/** Normalizes any of CRLF/CR/LF to LF, for editor text. */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Applies a chosen EOL to LF-normalized editor text. */
export function applyEol(text: string, eol: FileEol): string {
  const normalized = normalizeEol(text);
  return eol === "crlf" ? normalized.replace(/\n/g, "\r\n") : normalized;
}

/** Rejects any path through a `.git` directory (write and read guard). */
const HIDDEN_GIT_SEGMENT = /(?:^|\/)\.git(?:\/|$)/i;

function assertPath(value: unknown): asserts value is string {
  if (!isWorkspaceRelativePath(value)) {
    throw new FileContentError("that path is not inside the project", "forbidden");
  }
  if (HIDDEN_GIT_SEGMENT.test(value)) {
    throw new FileContentError("the .git directory is not editable", "forbidden");
  }
}

/** Reads one file for the editor, with text metadata. */
export async function readWorkspaceContent(
  io: FileContentIo,
  root: string,
  requested: string,
): Promise<WorkspaceFileContent> {
  assertPath(requested);
  const target = await resolveInsideRoot(io, root, requested);
  if (target === null) {
    throw new FileContentError("that path is outside the project", "forbidden");
  }

  const stat = await io.statFile(target);
  if (stat === null) {
    throw new FileContentError(`no such file: ${requested}`, "not_found");
  }
  if (stat.kind !== "file") {
    throw new FileContentError(`not a file: ${requested}`, "bad_request");
  }

  const base = {
    path: target,
    relativePath: requested,
    bytes: stat.size,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    truncated: false,
    eol: "lf" as FileEol,
    bom: false,
    encoding: "utf8" as FileEncoding,
  };

  if (stat.size > MAX_EDITOR_READ_BYTES) {
    return { ...base, kind: "too_large", text: null };
  }

  const read = await io.readBytes(target, MAX_EDITOR_READ_BYTES + 1);
  if (read === null) {
    throw new FileContentError(`could not read: ${requested}`, "not_found");
  }
  const bytes = read.bytes;

  if (startsWith(bytes, [0xff, 0xfe])) {
    return {
      ...base,
      kind: "unsupported_encoding",
      text: null,
      encoding: "utf16le",
      truncated: read.truncated,
    };
  }
  if (startsWith(bytes, [0xfe, 0xff])) {
    return {
      ...base,
      kind: "unsupported_encoding",
      text: null,
      encoding: "utf16be",
      truncated: read.truncated,
    };
  }

  const bom = startsWith(bytes, UTF8_BOM);
  const body = bom ? bytes.subarray(UTF8_BOM.length) : bytes;

  if (hasNulByte(body)) {
    return { ...base, kind: "binary", text: null, encoding: "binary", truncated: read.truncated };
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return { ...base, kind: "binary", text: null, encoding: "binary", truncated: read.truncated };
  }

  return {
    ...base,
    kind: "text",
    text,
    eol: detectEol(text),
    bom,
    encoding: "utf8",
    bytes: bytes.byteLength,
    truncated: read.truncated,
  };
}

/** Stats one project file without reading it. */
export async function statWorkspaceFile(
  io: FileContentIo,
  root: string,
  requested: string,
): Promise<WorkspaceStat> {
  assertPath(requested);
  const target = await resolveInsideRoot(io, root, requested);
  if (target === null) {
    throw new FileContentError("that path is outside the project", "forbidden");
  }
  const stat = await io.statFile(target);
  if (stat === null) {
    throw new FileContentError(`no such file: ${requested}`, "not_found");
  }
  return {
    path: target,
    relativePath: requested,
    kind: stat.kind,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

/**
 * Writes one file. The renderer passes LF-normalized text plus the file's EOL
 * and BOM; this function is the only place that re-encodes them.
 */
export async function writeWorkspaceContent(
  io: FileContentIo,
  root: string,
  input: Omit<WorkspaceWriteInput, "projectPath">,
): Promise<WorkspaceWriteResult> {
  assertPath(input.path);
  if (typeof input.text !== "string") {
    throw new FileContentError("write requires text", "bad_request");
  }
  if (input.text.length > MAX_EDITOR_WRITE_BYTES) {
    throw new FileContentError(
      `the file is larger than the ${MAX_EDITOR_WRITE_BYTES}-byte write limit`,
      "too_large",
    );
  }

  const target = await resolveInsideRoot(io, root, input.path);
  if (target === null) {
    throw new FileContentError("that path is outside the project", "forbidden");
  }

  const current = await io.statFile(target);
  if (current !== null && current.kind !== "file") {
    throw new FileContentError(`not a file: ${input.path}`, "bad_request");
  }

  if (!input.force) {
    if (input.expectedMtimeMs === null) {
      if (current !== null) {
        throw new FileContentError(`the file already exists: ${input.path}`, "conflict", {
          mtimeMs: current.mtimeMs,
          size: current.size,
        });
      }
    } else if (typeof input.expectedMtimeMs === "number") {
      if (current === null) {
        throw new FileContentError(`the file no longer exists: ${input.path}`, "conflict");
      }
      if (Math.abs(current.mtimeMs - input.expectedMtimeMs) > 1) {
        throw new FileContentError(`the file changed on disk: ${input.path}`, "conflict", {
          mtimeMs: current.mtimeMs,
          size: current.size,
        });
      }
    }
  }

  const eol = input.eol ?? "lf";
  const encoded = applyEol(input.text, eol);
  const withBom = input.bom ? `\uFEFF${encoded}` : encoded;
  if (Buffer.byteLength(withBom, "utf8") > MAX_EDITOR_WRITE_BYTES) {
    throw new FileContentError(
      `the file is larger than the ${MAX_EDITOR_WRITE_BYTES}-byte write limit`,
      "too_large",
    );
  }

  const mode = current?.mode ?? 0o644;
  await io.writeAtomic(target, withBom, mode);
  const after = await io.statFile(target);
  if (after === null) {
    throw new FileContentError(`could not verify the write: ${input.path}`, "not_found");
  }
  return {
    path: target,
    relativePath: input.path,
    size: after.size,
    mtimeMs: after.mtimeMs,
    bytes: Buffer.byteLength(withBom, "utf8"),
  };
}
