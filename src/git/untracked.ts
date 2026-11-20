/**
 * The untracked-file diff (untracked-changes plan step 4).
 *
 * `git diff` has no index side for a file git does not track, so the rail's
 * "all lines added" view is synthesised from the work-tree bytes. The read is
 * the editor's own `readWorkspaceContent`: it realpath-contains the path, caps
 * the size, strips a UTF-8 BOM and decides binary/UTF-16 once, so the diff
 * viewer and the editor cannot disagree about what a file is.
 *
 * Pure apart from the injected `FileContentIo`; no Electron and no `node:fs`.
 */

import {
  FileContentError,
  readWorkspaceContent,
  type FileContentIo,
} from "../workspace/file-content";
import {
  MAX_DIFF_BYTES,
  type GitDiff,
  type GitDiffFile,
  type GitDiffHunk,
  type GitDiffLine,
} from "../shared/git";
import { DiffParseError } from "./diff";

/** What the work-tree read produced, in the four cases the viewer cares about. */
export type UntrackedRead =
  | { ok: true; text: string }
  | { ok: false; reason: "missing" | "forbidden" | "too_large" | "binary" };

/**
 * Reads one untracked work-tree file through the editor's containment guard.
 *
 * `MAX_DIFF_BYTES` is the product cap: the editor is allowed a larger read, but
 * a payload the diff surface would refuse must not be decoded first.
 */
export async function readUntrackedSource(
  io: FileContentIo,
  root: string,
  path: string,
): Promise<UntrackedRead> {
  let content;
  try {
    content = await readWorkspaceContent(io, root, path);
  } catch (error) {
    if (error instanceof FileContentError && error.code === "not_found") {
      return { ok: false, reason: "missing" };
    }
    // `forbidden` (outside the project, a symlink escape, `.git/`) and
    // `bad_request` (a directory, a path the workspace layer refuses) are both
    // "this is not showable" to the diff viewer.
    if (error instanceof FileContentError) return { ok: false, reason: "forbidden" };
    throw error;
  }

  if (content.kind === "too_large" || content.truncated || content.size > MAX_DIFF_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  if (content.kind !== "text" || content.text === null) {
    return { ok: false, reason: "binary" };
  }
  return { ok: true, text: content.text };
}

/** One untracked file section, with every line shown as an addition. */
function addedFile(path: string, text: string): GitDiffFile {
  if (text.length === 0) {
    return {
      path,
      origPath: null,
      status: "untracked",
      binary: false,
      added: 0,
      removed: 0,
      hunks: [],
    };
  }

  const endsWithNewline = text.endsWith("\n");
  const rawLines = text.split("\n");
  if (endsWithNewline) rawLines.pop();

  const lines: GitDiffLine[] = rawLines.map((line, index) => ({
    kind: "add",
    oldLine: null,
    newLine: index + 1,
    text: line,
  }));
  // `toHunk` stores git's own marker this way; a synthesised diff must render
  // and rebuild like a parsed one. It is not a content line, so it does not
  // increment the hunk's added count.
  if (!endsWithNewline) {
    lines.push({
      kind: "context",
      oldLine: null,
      newLine: null,
      text: "\\ No newline at end of file",
    });
  }

  const added = rawLines.length;
  const hunk: GitDiffHunk = {
    header: `-0,0 +1,${added}`,
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: added,
    lines,
  };
  return {
    path,
    origPath: null,
    status: "untracked",
    binary: false,
    added,
    removed: 0,
    hunks: [hunk],
  };
}

/** Turns one read outcome into the viewer's model. */
export function untrackedDiff(path: string, read: UntrackedRead): GitDiff {
  if (!read.ok) {
    if (read.reason === "too_large") {
      return { scope: "working", files: [], tooLarge: true, truncated: false };
    }
    if (read.reason === "binary") {
      return {
        scope: "working",
        files: [
          {
            path,
            origPath: null,
            status: "untracked",
            binary: true,
            added: 0,
            removed: 0,
            hunks: [],
          },
        ],
        tooLarge: false,
        truncated: false,
      };
    }
    throw new DiffParseError(
      read.reason === "missing"
        ? "The file is no longer there. Refresh the Changes list."
        : "That file is outside the project and cannot be shown.",
    );
  }

  // No patch paths: `GitDiffFile` documents them as absent on a synthesised
  // file, and an untracked diff offers no hunk staging to need them.
  return {
    scope: "working",
    files: [addedFile(path, read.text)],
    tooLarge: false,
    truncated: false,
  };
}
