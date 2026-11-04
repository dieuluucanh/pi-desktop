/**
 * Workspace drag payloads and mention formatting.
 *
 * The Explorer and the session composer live in the same renderer, but a drag
 * travels through Chromium's DataTransfer, so the contract is a string. This
 * module owns that string and the pure text insertion around it. It stays free
 * of DOM and Electron imports so main, the renderer and the tests can share it
 * (the renderer-specific DataTransfer helpers live beside the Explorer).
 *
 * `@path` is deliberately plain text: the Pi host does not expand it, the agent
 * reads the file with its normal tools. The format mirrors Pi's own file
 * mentions, including `@"path with spaces"`.
 */

import {
  MAX_WORKSPACE_PATH_LENGTH,
  isWorkspaceRelativePath,
  type WorkspaceEntryKind,
} from "./workspace";

/** Custom MIME set by Explorer drags. Kept lowercase: browsers normalise it. */
export const WORKSPACE_PATH_DRAG_MIME = "application/x-pi-workspace-path";

export const WORKSPACE_PATH_DRAG_VERSION = 1 as const;

export interface WorkspaceDragPayload {
  version: typeof WORKSPACE_PATH_DRAG_VERSION;
  /** Absolute folder the relative path is resolved against. */
  projectPath: string;
  /** Project-relative POSIX path. */
  path: string;
  kind: WorkspaceEntryKind;
}

/** True for the one project-relative entry kind a drag can carry. */
function isWorkspaceEntryKind(value: unknown): value is WorkspaceEntryKind {
  return value === "file" || value === "directory";
}

/** Serialises a drag payload for `DataTransfer.setData`. */
export function serializeWorkspaceDrag(payload: WorkspaceDragPayload): string {
  return JSON.stringify(payload);
}

/**
 * Parses an untrusted drag payload. Returns null for anything malformed: a drag
 * is external input, so this never throws and never repairs a bad path.
 */
export function parseWorkspaceDrag(raw: string | null | undefined): WorkspaceDragPayload | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== WORKSPACE_PATH_DRAG_VERSION) return null;
  if (!isWorkspaceEntryKind(record.kind)) return null;
  const projectPath = record.projectPath;
  if (typeof projectPath !== "string") return null;
  const trimmedRoot = projectPath.trim();
  if (trimmedRoot.length === 0 || trimmedRoot.length > MAX_WORKSPACE_PATH_LENGTH) return null;
  if (!isWorkspaceRelativePath(record.path)) return null;
  return {
    version: WORKSPACE_PATH_DRAG_VERSION,
    projectPath,
    path: record.path,
    kind: record.kind,
  };
}

/**
 * Formats a project-relative path as a Pi-style mention. Directories keep a
 * trailing slash so the agent (and a human) can tell them apart; a path with
 * whitespace is quoted the way Pi's own editor quotes it.
 *
 * A literal `"` inside a name is not escaped: such names fall back to the
 * unquoted form, which a human can still correct in the composer.
 */
export function workspaceMention(path: string, kind: WorkspaceEntryKind): string {
  const withSlash = kind === "directory" && !path.endsWith("/") ? `${path}/` : path;
  if (/\s/.test(withSlash) && !withSlash.includes('"')) return `@"${withSlash}"`;
  return `@${withSlash}`;
}

export interface MentionInsertion {
  text: string;
  caret: number;
}

/**
 * Splices a mention into a buffer at a selection, keeping the surrounding words
 * separated. Returns the new caret at the end of the inserted mention (after its
 * trailing space) so the composer can restore the DOM selection.
 */
export function insertWorkspaceMention(
  text: string,
  start: number,
  end: number,
  mention: string,
): MentionInsertion {
  const safeStart = Math.max(0, Math.min(start, text.length));
  const safeEnd = Math.max(safeStart, Math.min(end, text.length));
  const before = text.slice(0, safeStart);
  const after = text.slice(safeEnd);
  const leading = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const trailing = after.length === 0 || !/^\s/.test(after) ? " " : "";
  const insertion = `${leading}${mention}${trailing}`;
  return {
    text: `${before}${insertion}${after}`,
    caret: safeStart + insertion.length,
  };
}
