/**
 * Rebuilding a single-hunk patch (git-checkpoint plan step 14).
 *
 * The diff viewer's *Stage hunk* button has to hand `git apply --cached` a patch
 * that git accepts verbatim. That means the `diff --git` header, the exact
 * `---`/`+++` names git wrote, and the **original** hunk header — recomputing
 * `@@ -a,b +c,d @@` from the line numbers is how a patch lands in the wrong
 * place.
 *
 * Shared rather than living in `src/git/**`: the renderer needs it, and the git
 * engine module imports `node:child_process` for its runner. Keeping this pure
 * means the viewer can build a patch without pulling Node into the bundle.
 */

import type { GitDiffFile, GitDiffHunk, GitDiffLine } from "./git";

/** The raw prefixed text for one line, as it must appear in a patch. */
function hunkLineText(line: GitDiffLine): string {
  if (line.kind === "add") return `+${line.text}`;
  if (line.kind === "remove") return `-${line.text}`;
  // The "no newline" marker is stored with its backslash already in `text`.
  if (line.text.startsWith("\\")) return line.text;
  return ` ${line.text}`;
}

/** `a/src/x.ts` → `src/x.ts`; `/dev/null` is left alone. */
function headerPath(name: string): string {
  return name === "/dev/null" ? name : name.replace(/^[ab]\//, "");
}

/**
 * One file + one hunk → a patch containing exactly that hunk.
 *
 * `file.patchOldPath`/`patchNewPath` come from the parsed diff, so the result
 * matches what git printed (including `/dev/null` for a created or deleted
 * file). A caller that synthesised a file falls back to `a/<path>`/`b/<path>`.
 */
export function buildHunkPatch(file: GitDiffFile, hunk: GitDiffHunk): string {
  const oldName = file.patchOldPath ?? `a/${file.origPath ?? file.path}`;
  const newName = file.patchNewPath ?? `b/${file.path}`;
  const gitOld = headerPath(oldName);
  const gitNew = headerPath(newName);
  const body = hunk.lines.map((line) => hunkLineText(line)).join("\n");
  return [
    `diff --git a/${gitOld} b/${gitNew}`,
    `--- ${oldName}`,
    `+++ ${newName}`,
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    body,
    "",
  ].join("\n");
}
