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
  MAX_COMMIT_CONTEXT_BYTES,
  MAX_COMMIT_CONTEXT_FILES,
  MAX_DIFF_BYTES,
  MAX_DIFF_FILES,
  MAX_RECENT_COMMIT_SUBJECTS,
  type GitCommitContext,
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
  if (request.untracked) {
    throw new DiffParseError("git: an untracked diff is read from the work tree");
  }
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

/* ---------------------------------------------------------- commit context */

/**
 * Above this many changed lines the unified patch is not read at all.
 *
 * R9: this is a **line-count early-out only**, not the byte budget. A few
 * thousand very long lines can still be hundreds of KB, so the real bound is
 * {@link truncateCommitPatch}'s cap on the patch text; this threshold just keeps
 * a huge staged change out of the pipe in the first place.
 */
export const MAX_COMMIT_PATCH_LINES = 4_000;

/** The header that starts one file section of a unified diff. */
const DIFF_HEADER = "diff --git ";

export interface ReadCommitContextOptions {
  /** Byte cap applied to the unified patch text; defaults to the wire bound. */
  maxBytes?: number;
  /** Timeout for every git read; defaults to `GIT_WRITE_TIMEOUT_MS` (10 s). */
  timeoutMs?: number;
}

interface NumstatTotals {
  /** Number of rows, capped by the caller. */
  files: number;
  insertions: number;
  deletions: number;
}

/** A binary row's `-` count is zero, not a number. */
function numstatCount(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Parses `git diff --cached --numstat -z`.
 *
 * One normal row is `added\tdeleted\tpath\0`; with rename detection git writes
 * `added\tdeleted\t\0old\0new\0` instead, so an empty path field consumes the
 * next two NUL-separated fields. Binary rows report `-` for both counts.
 */
function readNumstat(stdout: string): NumstatTotals {
  const fields = stdout.split("\0");
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (!record) continue;
    const [added = "", deleted = "", path = ""] = record.split("\t");
    if (path === "") index += 2;
    files += 1;
    insertions += numstatCount(added);
    deletions += numstatCount(deleted);
  }
  return { files, insertions, deletions };
}

/** The index of the first `diff --git ` header that starts a line, or -1. */
function firstHeaderIndex(text: string): number {
  if (text.startsWith(DIFF_HEADER)) return 0;
  const index = text.indexOf(`\n${DIFF_HEADER}`);
  return index < 0 ? -1 : index + 1;
}

/** The last line-starting `diff --git ` header at or before `limit`, or -1. */
function lastHeaderIndex(text: string, limit: number): number {
  let found = -1;
  let from = 0;
  while (from <= limit) {
    const index = text.indexOf(DIFF_HEADER, from);
    if (index < 0 || index > limit) break;
    if (index === 0 || text[index - 1] === "\n") found = index;
    from = index + DIFF_HEADER.length;
  }
  return found;
}

/** Cuts at the last complete line that fits; "" when not even one line does. */
function cutAtLine(text: string, maxBytes: number): string {
  if (text.length <= maxBytes) return text;
  const window = text.slice(0, maxBytes);
  const lastBreak = window.lastIndexOf("\n");
  return (lastBreak >= 0 ? window.slice(0, lastBreak) : "").replace(/\s+$/, "");
}

/**
 * Bounds the unified patch to `maxBytes`.
 *
 * The cut is at a complete `diff --git ` boundary: everything kept is a full
 * file section. A leading partial block is possible because `runner.ts` keeps
 * the *tail* of an oversized stream, so the text can start mid-file; that block
 * is dropped. When not even one complete section fits (a single file larger
 * than the cap) the patch is cut at a line boundary instead, and `truncated`
 * still tells the prompt the truth.
 */
function truncateCommitPatch(
  patch: string,
  maxBytes: number,
): { patch: string; truncated: boolean } {
  const first = firstHeaderIndex(patch);
  if (first < 0) {
    // Not a unified patch at all; give the caller a bounded prefix anyway.
    return { patch: cutAtLine(patch, maxBytes), truncated: patch.length > maxBytes };
  }

  const text = first > 0 ? patch.slice(first) : patch;
  const droppedLead = first > 0;
  if (text.length <= maxBytes) return { patch: text, truncated: droppedLead };

  const last = lastHeaderIndex(text, maxBytes);
  if (last > 0) {
    return { patch: text.slice(0, last).replace(/\n+$/, ""), truncated: true };
  }
  return { patch: cutAtLine(text, maxBytes), truncated: true };
}

/**
 * Reads the bounded input for an AI commit message (2026-11-25 plan step 15).
 *
 * Staged only: every read is `git diff --cached`, so the generator can never
 * see — or accidentally include — un-staged work. The `--stat` summary and the
 * recent subjects are always read; the unified patch is read only below
 * {@link MAX_COMMIT_PATCH_LINES} and is then bounded by `maxBytes`. Every read
 * uses `GIT_WRITE_TIMEOUT_MS` (10 s) unless the caller names its own timeout.
 */
export async function readCommitContext(
  runner: GitRunner,
  root: string,
  options: ReadCommitContextOptions = {},
): Promise<Omit<GitCommitContext, "projectPath" | "branch">> {
  const timeoutMs = options.timeoutMs ?? GIT_WRITE_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_COMMIT_CONTEXT_BYTES;

  const [statResult, numstatResult, logResult] = await Promise.all([
    runner.run(root, ["diff", "--cached", "--stat"], { timeoutMs }),
    runner.run(root, ["diff", "--cached", "--numstat", "-z"], { timeoutMs }),
    runner.run(root, ["log", "-n", String(MAX_RECENT_COMMIT_SUBJECTS), "--format=%s"], {
      timeoutMs,
    }),
  ]);

  const recentSubjects =
    logResult.code === 0 && !logResult.missing
      ? logResult.stdout
          .split(/\r?\n/)
          .map((subject) => subject.trim())
          .filter((subject) => subject.length > 0)
          .slice(0, MAX_RECENT_COMMIT_SUBJECTS)
      : [];

  const totals =
    numstatResult.code === 0 && !numstatResult.missing
      ? readNumstat(numstatResult.stdout)
      : { files: 0, insertions: 0, deletions: 0 };

  if (totals.files === 0) {
    return {
      stat: "",
      patch: "",
      truncated: false,
      files: 0,
      insertions: 0,
      deletions: 0,
      recentSubjects,
    };
  }

  const stat = statResult.code === 0 && !statResult.missing ? statResult.stdout : "";
  const files = Math.min(totals.files, MAX_COMMIT_CONTEXT_FILES);
  const base = {
    stat,
    patch: "",
    truncated: false,
    files,
    insertions: totals.insertions,
    deletions: totals.deletions,
    recentSubjects,
  };

  if (totals.insertions + totals.deletions >= MAX_COMMIT_PATCH_LINES) {
    // The early-out is deliberate: `truncated` stays truthful even though the
    // patch was never read, because the prompt must not claim to show it all.
    return { ...base, truncated: true };
  }

  const patchResult = await runner.run(
    root,
    ["diff", "--cached", "-U3", "--no-color", "--no-ext-diff", "--no-textconv"],
    { timeoutMs },
  );
  if (patchResult.missing || patchResult.code !== 0) {
    return { ...base, truncated: true };
  }

  const bounded = truncateCommitPatch(patchResult.stdout, maxBytes);
  return { ...base, patch: bounded.patch, truncated: bounded.truncated };
}
