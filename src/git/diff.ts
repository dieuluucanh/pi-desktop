/**
 * Structured diffs and single-hunk patches (git-checkpoint plan step 5).
 *
 * Two audiences, one parser:
 *
 *  - the **diff viewer** needs hunks with line numbers and add/remove counts;
 *  - **hunk staging** needs to hand `git apply` a patch containing exactly one
 *    hunk, with the file headers git itself wrote.
 *
 * `diff@9`'s `parsePatch` is the parser because it understands git's dialect
 * (rename/copy/create/delete/binary extended headers), so the app does not
 * re-implement unified-diff parsing. It keeps the `a/`/`b/` prefixes on the file
 * names, which is why every file carries `patchOldPath`/`patchNewPath`: a
 * rebuilt patch must be byte-compatible with what git expects, and guessing the
 * prefix back is how a staging bug is born.
 */

import { parsePatch } from "diff";
import {
  MAX_DIFF_BYTES,
  MAX_DIFF_FILES,
  type GitDiff,
  type GitDiffFile,
  type GitDiffHunk,
  type GitDiffLine,
  type GitDiffRequest,
  type GitFileStatus,
} from "../shared/git";
import type { GitRunner } from "./runner";
import { GIT_WRITE_TIMEOUT_MS } from "./runner";

/** Which side of the repository to diff. */
/**
 * A diff request from the rail. The wire shape lives in `src/shared/git.ts`
 * (`GitDiffRequest`) so the preload never imports the engine; this alias keeps
 * the engine's own call sites reading naturally.
 */
export type DiffRequest = GitDiffRequest;

export interface ReadDiffOptions {
  timeoutMs?: number;
  /** Context lines; 3 matches git's default and the viewer's needs. */
  context?: number;
}

/** `a/src/app.ts` → `src/app.ts`; `/dev/null` stays `/dev/null`. */
function stripPrefix(name: string | undefined): string | null {
  if (!name) return null;
  if (name === "/dev/null") return "/dev/null";
  return name.replace(/^[ab]\//, "");
}

/** True when the header name means "this side does not exist". */
function isNullSide(name: string | undefined): boolean {
  return name === undefined || name === "/dev/null";
}

/**
 * Parses unified diff text into the wire model.
 *
 * Pure: no git, no filesystem. Throws `DiffParseError` when the text is
 * non-empty but yields nothing, because "no changes" and "we could not read
 * git's answer" must not look the same to the user.
 */
export class DiffParseError extends Error {
  readonly code = "bad_request";

  constructor(message: string) {
    super(message);
    this.name = "DiffParseError";
  }
}

export function parseDiffText(
  text: string,
  scope: GitDiff["scope"],
  options: { maxFiles?: number } = {},
): GitDiff {
  const maxFiles = options.maxFiles ?? MAX_DIFF_FILES;
  if (text.length > MAX_DIFF_BYTES) {
    return { scope, files: [], tooLarge: true, truncated: false };
  }
  if (text.trim().length === 0) {
    return { scope, files: [], tooLarge: false, truncated: false };
  }

  let patches: ReturnType<typeof parsePatch>;
  try {
    patches = parsePatch(text);
  } catch (error) {
    throw new DiffParseError(
      `could not parse the diff: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (patches.length === 0) {
    throw new DiffParseError("could not parse the diff: git produced no file sections");
  }

  const files: GitDiffFile[] = [];
  let truncated = false;
  for (const patch of patches) {
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
    files.push(toDiffFile(patch));
  }
  // `parsePatch` tolerates arbitrary prose and can return a nameless section for
  // it. A real file section always names a path, so a result with no path at all
  // means git's answer was not a patch the app understands — report that instead
  // of rendering an empty "no changes" viewer.
  if (
    files.length === 0 ||
    files.every((file) => file.path.length === 0 && file.hunks.length === 0)
  ) {
    throw new DiffParseError("could not parse the diff: no file paths in git's answer");
  }
  return { scope, files, tooLarge: false, truncated };
}

/**
 * The file's status, in priority order. `create`/`delete` win over everything
 * (git never reports both), then a rename or copy, then a plain modification.
 */
function statusOf(
  patch: ReturnType<typeof parsePatch>[number],
  flags: { created: boolean; deleted: boolean; renamed: boolean },
): GitFileStatus {
  if (flags.created) return "added";
  if (flags.deleted) return "deleted";
  if (flags.renamed) return "renamed";
  if (patch.isCopy === true) return "copied";
  return "modified";
}

/** One `parsePatch` result → the wire model, keeping the raw header names. */
function toDiffFile(patch: ReturnType<typeof parsePatch>[number]): GitDiffFile {
  const oldPath = stripPrefix(patch.oldFileName);
  const newPath = stripPrefix(patch.newFileName);
  const created = patch.isCreate === true || isNullSide(patch.oldFileName);
  const deleted = patch.isDelete === true || isNullSide(patch.newFileName);
  const renamed = patch.isRename === true;

  // A deleted file has no new side, so its name comes from `---`; everything
  // else is named by `+++`. A rename/copy reports the *new* path as `path` and
  // the old one as `origPath`, which is what both the viewer and the rail show.
  const path = deleted ? (oldPath ?? "") : (newPath ?? oldPath ?? "");
  const origPath = renamed || patch.isCopy === true ? oldPath : null;

  const status = statusOf(patch, { created, deleted, renamed });

  const binary = patch.isBinary === true;
  const hunks = binary ? [] : patch.hunks.map(toHunk);
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") added += 1;
      else if (line.kind === "remove") removed += 1;
    }
  }

  return {
    path,
    origPath,
    status,
    binary,
    added,
    removed,
    hunks,
    ...(patch.oldFileName === undefined ? {} : { patchOldPath: patch.oldFileName }),
    ...(patch.newFileName === undefined ? {} : { patchNewPath: patch.newFileName }),
  };
}

/** One hunk's raw lines (` `, `+`, `-`, `\`) → numbered lines. */
function toHunk(hunk: ReturnType<typeof parsePatch>[number]["hunks"][number]): GitDiffHunk {
  const lines: GitDiffLine[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const raw of hunk.lines) {
    const marker = raw[0] ?? " ";
    const text = raw.slice(1);
    if (marker === "+") {
      lines.push({ kind: "add", oldLine: null, newLine, text });
      newLine += 1;
    } else if (marker === "-") {
      lines.push({ kind: "remove", oldLine, newLine: null, text });
      oldLine += 1;
    } else if (marker === "\\") {
      // `\ No newline at end of file` belongs to the previous line; keep it as
      // context so the viewer can show it and `git apply` receives it back.
      lines.push({ kind: "context", oldLine: null, newLine: null, text: raw });
    } else {
      lines.push({ kind: "context", oldLine, newLine, text });
      oldLine += 1;
      newLine += 1;
    }
  }
  return {
    header: `-${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines}`,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines,
  };
}

/**
 * Rebuilds a one-hunk patch. The implementation lives in
 * `src/shared/git-patch.ts` so the renderer's diff viewer can build a patch
 * without pulling this module's Node runner into the bundle.
 */
export { buildHunkPatch } from "../shared/git-patch";

/** Which side a request asks for. One place, so the label cannot drift. */
function scopeOf(request: DiffRequest): GitDiff["scope"] {
  if (request.commit) return "commit";
  if (request.staged === true) return "staged";
  return "working";
}

/**
 * Reads a diff. `scope` is derived from the request so the caller never has to
 * remember which side it asked for.
 */
export async function readDiff(
  runner: GitRunner,
  root: string,
  request: DiffRequest = {},
  options: ReadDiffOptions = {},
): Promise<GitDiff> {
  const scope = scopeOf(request);
  const context = options.context ?? 3;
  const core = [
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    `-U${context}`,
    "--src-prefix=a/",
    "--dst-prefix=b/",
  ];

  let args: string[];
  if (request.commit) {
    // `show` also works for a root commit (it diffs against the empty tree),
    // where `diff <sha>^ <sha>` would fail. `--format=` keeps the commit message
    // out of the patch text.
    args = ["show", "--format=", ...core, request.commit];
  } else if (request.staged === true) {
    args = ["diff", "--cached", ...core];
  } else {
    args = ["diff", ...core];
  }
  if (request.path) args.push("--", request.path);

  const result = await runner.run(root, args, {
    timeoutMs: options.timeoutMs ?? GIT_WRITE_TIMEOUT_MS,
  });
  if (result.missing) {
    return { scope, files: [], tooLarge: false, truncated: false };
  }
  // `git diff --no-index` exits 1 on a difference; the plain forms exit 0.
  // Anything else with output on stderr is a real failure the caller classifies.
  if (result.code !== 0 && result.code !== 1) {
    throw new DiffParseError(
      `git diff failed: ${result.stderr.split(/\r?\n/)[0] ?? `exit code ${result.code}`}`,
    );
  }
  return parseDiffText(result.stdout, scope);
}

/**
 * Applies a single-hunk patch to the index. `reverse` unstages instead of
 * staging, which is how the rail's "unstage hunk" works without rewriting the
 * whole file.
 *
 * `--cached` is deliberate: staging must not touch the work tree, and unstaging
 * must not either.
 */
export async function applyHunkPatch(
  runner: GitRunner,
  root: string,
  patch: string,
  options: { reverse?: boolean; timeoutMs?: number } = {},
): Promise<{ ok: boolean; stderr: string }> {
  const args = ["apply", "--cached", "--unidiff-zero", "--whitespace=nowarn"];
  if (options.reverse) args.push("--reverse");
  args.push("-");
  const result = await runner.run(root, args, {
    input: patch,
    timeoutMs: options.timeoutMs ?? GIT_WRITE_TIMEOUT_MS,
  });
  return { ok: result.code === 0 && !result.missing, stderr: result.stderr };
}

/** The total added/removed line counts of a diff, for the rail's summary chip. */
export function diffTotals(diff: GitDiff | undefined): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const file of diff?.files ?? []) {
    added += file.added;
    removed += file.removed;
  }
  return { added, removed };
}

/** True when a diff has anything a viewer can draw. */
export function hasDiffContent(diff: GitDiff | undefined): boolean {
  if (!diff || diff.tooLarge) return false;
  return diff.files.some((file) => file.binary || file.hunks.length > 0);
}
