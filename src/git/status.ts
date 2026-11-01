/**
 * `git status --porcelain=v2` parsing (git-checkpoint plan step 4).
 *
 * The rail needs two lists, not one: what the index differs by (staged) and what
 * the work tree differs by (unstaged). A file can be in both — stage an edit,
 * edit again — so a single status letter per path would lose information.
 *
 * `--porcelain=v2 -z` is the only format that survives real repositories:
 *
 *  - v1's two columns are positional and truncated for renames;
 *  - v2 names the index and work-tree states separately, which is exactly the
 *    two-group split;
 *  - `-z` NUL-terminates records and emits the original path as a *separate*
 *    NUL-terminated field for a rename, so a path containing a newline, a quote
 *    or CJK text needs no unescaping.
 *
 * The parser is pure: `parseStatus` takes the raw stdout and returns the
 * snapshot fields. Only {@link readStatus} runs a command.
 */

import {
  MAX_STATUS_PATHS,
  type GitFileEntry,
  type GitFileStatus,
  type GitStashEntry,
} from "../shared/git";
import type { GitRunner } from "./runner";
import { GIT_STATUS_TIMEOUT_MS } from "./runner";

/** The branch facts `--porcelain=v2 --branch` reports inline. */
export interface StatusBranchFacts {
  /** Branch name, or null when HEAD is detached. */
  head: string | null;
  ahead: number;
  behind: number;
}

/** The status fields a snapshot needs, without the repository header. */
export interface ParsedStatus {
  staged: GitFileEntry[];
  changed: GitFileEntry[];
  /** True when more paths existed than {@link MAX_STATUS_PATHS}. */
  truncated: boolean;
  /** Total paths git reported, before any cap. */
  total: number;
  /** Branch facts v2 reports inline (`branch.head`, `branch.ab`). */
  branch: StatusBranchFacts | null;
}

/** The two status characters v2 prints for an ordinary entry. */
interface XY {
  /** Index-vs-HEAD state (`X`): `.` means unchanged in the index. */
  index: string;
  /** Work-tree-vs-index state (`Y`): `.` means unchanged in the work tree. */
  workTree: string;
}

/**
 * Maps one `--porcelain=v2` status character to the model's status.
 *
 * v2 uses `.` for "unchanged" and the letters M/T/A/D/R/C/U for changes.
 * `T` is a type change (a file became a symlink) — reported as `modified`,
 * which is what a user sees and what `git diff` will show.
 */
function statusFromChar(char: string): GitFileStatus | null {
  switch (char) {
    case "M":
    case "T":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "U":
      return "conflicted";
    case ".":
    case " ":
      return null;
    default:
      // An unfamiliar letter is reported as modified rather than dropped: a
      // future git adding a state must not make a changed file invisible.
      return "modified";
  }
}

/**
 * Parses the NUL-separated status stream.
 *
 * Record kinds (the first character):
 *  - `1` ordinary change: `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
 *  - `2` rename/copy:     `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>`
 *  - `u` unmerged:        `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
 *  - `?` untracked path
 *  - `!` ignored path
 *  - `#` header (`branch.head`, `branch.ab`, `branch.upstream`)
 *
 * Because `-z` terminates *every* field, a rename's original path arrives as the
 * next array element rather than appended to the record.
 */
export function parseStatus(stdout: string): ParsedStatus {
  const fields = stdout.split("\u0000");
  const staged: GitFileEntry[] = [];
  const changed: GitFileEntry[] = [];
  let truncated = false;
  let total = 0;
  let branch: StatusBranchFacts | null = null;

  const push = (entry: GitFileEntry): void => {
    total += 1;
    if (staged.length + changed.length >= MAX_STATUS_PATHS) {
      truncated = true;
      return;
    }
    if (entry.staged) staged.push(entry);
    if (entry.unstaged) changed.push(entry);
    // A file that is only staged (or only changed) still belongs in one group;
    // `push` above adds it to whichever flags say so. A file with neither flag
    // (an ignored path) never reaches here.
  };

  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (record === undefined || record.length === 0) continue;

    const kind = record[0];

    if (kind === "#") {
      const text = record.slice(2);
      const [key, ...rest] = text.split(" ");
      const value = rest.join(" ");
      // Read the previous value into an explicitly typed local: an inline
      // `branch?.ahead` is circular for the compiler, whose flow type for
      // `branch` depends on this very assignment.
      const previous: StatusBranchFacts = branch ?? { head: null, ahead: 0, behind: 0 };
      if (key === "branch.head") {
        branch = {
          ...previous,
          // `(detached)` is v2's marker; keep it distinct from a real branch name.
          head: value === "(detached)" ? null : value,
        };
      } else if (key === "branch.ab") {
        const [ahead, behind] = value.split(/\s+/);
        branch = {
          ...previous,
          ahead: Number.parseInt((ahead ?? "").replace("+", ""), 10) || 0,
          behind: Number.parseInt((behind ?? "").replace("-", ""), 10) || 0,
        };
      }
      continue;
    }

    if (kind === "?") {
      // `? <path>` — untracked. It is work-tree-only.
      const path = record.slice(2);
      if (path.length === 0) continue;
      push({ path, origPath: null, status: "untracked", staged: false, unstaged: true });
      continue;
    }

    if (kind === "!") {
      // `! <path>` — ignored. Never shown: the rail is about what git would commit.
      continue;
    }

    if (kind === "u") {
      // `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
      const parts = record.split(" ");
      const path = parts.slice(10).join(" ");
      if (path.length === 0) continue;
      push({
        path,
        origPath: null,
        status: "conflicted",
        // A conflict is both: the index has stages and the work tree differs.
        staged: true,
        unstaged: true,
      });
      continue;
    }

    if (kind === "1" || kind === "2") {
      const parts = record.split(" ");
      const xy = parts[1] ?? "";
      const statuses: XY = { index: xy[0] ?? ".", workTree: xy[1] ?? "." };
      // A `2` record has an extra `<X><score>` field before the path.
      const pathIndex = kind === "2" ? 9 : 8;
      const path = parts.slice(pathIndex).join(" ");
      let origPath: string | null = null;
      if (kind === "2") {
        // The original path is the next NUL-terminated field.
        const next = fields[index + 1];
        if (next !== undefined) {
          origPath = next;
          index += 1;
        }
      }
      if (path.length === 0) continue;

      const indexStatus = statusFromChar(statuses.index);
      const workTreeStatus = statusFromChar(statuses.workTree);
      // The work-tree letter wins for the row's label when both sides changed:
      // "modified" is the useful word, and the two *groups* carry the detail.
      const status: GitFileStatus = workTreeStatus ?? indexStatus ?? "modified";
      push({
        path,
        origPath,
        // A rename/copy is described by the index side; the work tree only says
        // whether the new path has further edits.
        status: indexStatus === "renamed" || indexStatus === "copied" ? indexStatus : status,
        staged: indexStatus !== null,
        unstaged: workTreeStatus !== null,
      });
      continue;
    }

    // An unknown record shape is skipped rather than guessed at; `total` stays
    // honest because it only counts entries we understood.
  }

  return { staged, changed, truncated, total, branch };
}

/**
 * Reads and parses `git status`. A folder that is not a repository returns an
 * empty result plus the raw failure so the caller can classify it.
 */
export async function readStatus(
  runner: GitRunner,
  root: string,
  options: { timeoutMs?: number } = {},
): Promise<
  ParsedStatus & {
    ok: boolean;
    stderr: string;
    missing: boolean;
    /** The child's exit code, so a caller can classify without re-running. */
    code: number;
    /** True when the runner killed the child at its timeout. */
    timedOut: boolean;
    durationMs: number;
  }
> {
  const result = await runner.run(
    root,
    ["status", "--porcelain=v2", "--branch", "-z", "--ignore-submodules=dirty"],
    { timeoutMs: options.timeoutMs ?? GIT_STATUS_TIMEOUT_MS },
  );
  if (result.missing || result.code !== 0) {
    return {
      staged: [],
      changed: [],
      truncated: false,
      total: 0,
      branch: null,
      ok: false,
      stderr: result.stderr,
      missing: result.missing,
      code: result.code,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    };
  }
  return {
    ...parseStatus(result.stdout),
    ok: true,
    stderr: "",
    missing: false,
    code: 0,
    timedOut: false,
    durationMs: result.durationMs,
  };
}

/**
 * `git stash list`, one entry per line: `<ref>\0<unix time>\0<subject>`.
 *
 * `-z` is deliberately *not* used: git's `-z` for a log format separates the
 * whole output with NULs and adds a newline between entries, which makes the
 * field count per entry ambiguous. A stash subject is a commit subject and so
 * cannot contain a newline, which makes the line split exact.
 */
export async function readStashes(
  runner: GitRunner,
  root: string,
  options: { timeoutMs?: number } = {},
): Promise<GitStashEntry[]> {
  const result = await runner.run(root, ["stash", "list", "--format=%gd%x00%ct%x00%gs"], {
    timeoutMs: options.timeoutMs ?? GIT_STATUS_TIMEOUT_MS,
  });
  if (result.code !== 0 || result.missing) return [];
  const stashes: GitStashEntry[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const [ref = "", seconds = "", ...subject] = line.split("\u0000");
    if (!ref.startsWith("stash@{")) continue;
    const at = Number.parseInt(seconds, 10);
    stashes.push({
      ref,
      index: stashes.length,
      at: Number.isFinite(at) ? at * 1000 : 0,
      subject: subject.join("\u0000"),
    });
    if (stashes.length >= 100) break;
  }
  return stashes;
}

/** The branch facts from a status read, for when `readRepo` is not re-run. */
export function statusBranch(
  parsed: ParsedStatus,
): { head: string | null; ahead: number; behind: number } | null {
  return parsed.branch;
}

/** Re-exported so the service can build a snapshot without importing v2 details. */
export type { GitFileStatus };
