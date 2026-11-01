/**
 * The git wire model (git-checkpoint plan step 1).
 *
 * Pure, Electron-free and dependency-free: this module is the vocabulary the
 * main-process service, the preload bridge and the renderer rail all agree on.
 * It owns three jobs:
 *
 *  1. **Shapes.** `GitSnapshot` is what the rail renders; nothing else leaks a
 *     raw `git status` line across the IPC boundary.
 *  2. **Validation.** `parseGitAction` is a closed union parser: a renderer can
 *     only ever ask for an operation that is named here, and every path or ref
 *     it supplies is checked before it reaches a git invocation.
 *  3. **Explanation.** `classifyGitFailure` turns git's stderr into one of a
 *     small set of codes with a sentence and a next step, so an `index.lock`,
 *     a rejected push and a missing binary never read the same.
 *
 * Bounds follow `src/host/file-listing.ts`: a repository with more paths than
 * `MAX_STATUS_PATHS` reports `truncated` instead of freezing the rail.
 */

/* ------------------------------------------------------------------ limits */

/** Most paths a single status snapshot may carry (a file, not a database). */
export const MAX_STATUS_PATHS = 2000;
/** Most commits one `gitLog` page returns. */
export const MAX_LOG_PAGE = 100;
export const DEFAULT_LOG_PAGE = 30;
/** Largest diff body the app will parse (bytes of unified patch text). */
export const MAX_DIFF_BYTES = 2_000_000;
/** Largest number of files one diff response will describe. */
export const MAX_DIFF_FILES = 200;
/** Largest commit message the app will send. */
export const MAX_COMMIT_MESSAGE = 20_000;
/** Longest accepted branch name (git's own practical limit is far below this). */
export const MAX_BRANCH_NAME = 200;
/** Longest path accepted from the renderer, in characters. */
export const MAX_REPO_PATH = 4096;

/* ------------------------------------------------------------- repository */

/** Why git is not usable for a folder. Every value maps to a rail empty state. */
export type GitUnavailableReason =
  /** No `git` executable on `PATH`. */
  | "git_missing"
  /** The folder exists but is not inside a work tree. */
  | "not_a_repo"
  /** The folder (or an ancestor) is a bare repository. */
  | "bare_repo"
  /** The folder does not exist or cannot be read. */
  | "no_folder"
  /** The repository is in the middle of an operation git wants finished first. */
  | "operation_in_progress";

/** A repository git is willing to work with. */
export interface GitRepoInfo {
  /** Work-tree root from `rev-parse --show-toplevel` (absolute). */
  root: string;
  /** `.git` directory from `rev-parse --git-dir` (absolute). */
  gitDir: string;
  /** Branch name, or null when HEAD is detached. */
  branch: string | null;
  /** Short HEAD sha, or null on an empty repository. */
  head: string | null;
  /** True while HEAD points at a commit but no branch (detached). */
  detached: boolean;
  /** True when the repository has no commits yet. */
  empty: boolean;
  /** `origin/main`-style upstream, or null when the branch has none. */
  upstream: string | null;
  /** Commits ahead of upstream; 0 without an upstream. */
  ahead: number;
  /** Commits behind upstream; 0 without an upstream. */
  behind: number;
  /** Remote names, sorted. */
  remotes: string[];
  /** `{ name, source }` where source says which config file supplied it. */
  identity: GitIdentity | null;
}

/** The commit account, and where git read it from. */
export interface GitIdentity {
  name: string;
  email: string;
  /** `repo` is `.git/config`, `global` is the user's `~/.gitconfig`, `system` the rest. */
  source: "repo" | "global" | "system" | "unknown";
}

/* ------------------------------------------------------------------- files */

/**
 * VS Code's letter set, extended with `conflicted` and kept distinct from
 * `staged`/`unstaged`: one file can be both (staged edit + later unstaged
 * edit), which is exactly why the rail shows two groups.
 */
export type GitFileStatus =
  "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "conflicted";

/** One changed path, as the rail's two lists need it. */
export interface GitFileEntry {
  /** POSIX-style path relative to the work-tree root. */
  path: string;
  /** The pre-rename path for a rename/copy, else null. */
  origPath: string | null;
  status: GitFileStatus;
  /** True when the index differs from HEAD (the "Staged Changes" group). */
  staged: boolean;
  /** True when the work tree differs from the index (the "Changes" group). */
  unstaged: boolean;
}

/** One page of the commit log. */
export interface GitCommitEntry {
  /** Full sha. */
  sha: string;
  /** Short sha for display. */
  shortSha: string;
  /** First line of the message. */
  subject: string;
  /** Author name (never the email: the rail shows the account, not a credential). */
  author: string;
  /** Author time, epoch milliseconds. */
  at: number;
  /** Branch/tag decoration names, without `HEAD ->` noise. */
  refs: string[];
  /** True for the commit HEAD points at. */
  head: boolean;
}

/** A stash entry, for the Git section's stash list. */
export interface GitStashEntry {
  /** `stash@{0}` */
  ref: string;
  /** Index in the stash list (0 is newest). */
  index: number;
  subject: string;
  at: number;
}

/* ---------------------------------------------------------------- snapshot */

/**
 * The one object the rail renders. `available: false` always carries a
 * `reason`, and every consumer must treat that as a first-class state rather
 * than an empty repository.
 */
export interface GitSnapshot {
  /** The folder that was asked about (the session cwd / project path). */
  projectPath: string;
  available: boolean;
  /** Present exactly when `available` is false. */
  reason?: GitUnavailableReason;
  /** A human sentence for `reason` (never a raw git error). */
  message?: string;
  /** The repository facts, when available. */
  repo?: GitRepoInfo;
  /** Files the index differs by (the Staged Changes group). */
  staged: GitFileEntry[];
  /** Files the work tree differs by (the Changes group). */
  changed: GitFileEntry[];
  /** Truncated at {@link MAX_STATUS_PATHS}. */
  truncated: boolean;
  /** Files changed relative to HEAD (`staged.length + changed.length`, capped). */
  totalChanged: number;
  stashes: GitStashEntry[];
  /** A recent operation failure the rail should show once (cleared on refresh). */
  error?: GitOperationError;
  /** ISO timestamp of the status read. */
  fetchedAt: string;
}

/* -------------------------------------------------------------------- diff */

export type GitDiffLineKind = "context" | "add" | "remove";

export interface GitDiffLine {
  kind: GitDiffLineKind;
  /** 1-based line number in the old file, or null for an added line. */
  oldLine: number | null;
  /** 1-based line number in the new file, or null for a removed line. */
  newLine: number | null;
  /** Text without its trailing newline. */
  text: string;
}

export interface GitDiffHunk {
  /** The hunk header as git wrote it, minus the leading `@@`. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: GitDiffLine[];
}

export interface GitDiffFile {
  path: string;
  origPath: string | null;
  /** `added`, `deleted`, `modified`, `renamed` — derived from the patch body. */
  status: GitFileStatus;
  binary: boolean;
  /** Added / removed line counts (`0` for a binary file). */
  added: number;
  removed: number;
  hunks: GitDiffHunk[];
  /**
   * The exact `---`/`+++` names git wrote (`a/<path>`, `/dev/null`). Needed to
   * rebuild a single-hunk patch that `git apply` accepts verbatim; absent on a
   * file the app synthesised.
   */
  patchOldPath?: string;
  patchNewPath?: string;
}

export interface GitDiff {
  /** Which side was read. */
  scope: "working" | "staged" | "commit";
  files: GitDiffFile[];
  /** True when the patch exceeded {@link MAX_DIFF_BYTES} and was not parsed. */
  tooLarge: boolean;
  truncated: boolean;
}

/**
 * A diff request from the rail. `GitDiffRequest` rather than `DiffRequest`
 * because this is the wire name: the preload must not import `src/git/**`.
 */
export interface GitDiffRequest {
  /** One path, relative to the work-tree root. Omitted means the whole tree. */
  path?: string;
  /** Read the index against HEAD instead of the work tree against the index. */
  staged?: boolean;
  /** Read a commit (against its first parent) instead of a working-tree diff. */
  commit?: string;
}

/** One page of the commit log, as the rail asks for it. */
export interface GitLogRequest {
  limit?: number;
  skip?: number;
  path?: string;
}

/** The outcome of a git action, including a classified failure. */
export interface GitActionResult {
  ok: boolean;
  /** Present when `ok` is false. */
  error?: GitOperationError;
  /** A one-line confirmation for the rail's status line. */
  message?: string;
}

/* ----------------------------------------------------------------- actions */

/**
 * The closed action union. Everything the rail can *do* is named here; anything
 * else is refused by {@link parseGitAction} before a shell is ever touched.
 */
export type GitAction =
  /** Stage one path (`git add --`). */
  | { kind: "stage"; paths: string[] }
  /** Unstage one path without touching the work tree (`git restore --staged`). */
  | { kind: "unstage"; paths: string[] }
  /** Stage a single hunk of the working tree. */
  | { kind: "stage-hunk"; path: string; patch: string }
  /** Unstage a single hunk of the index. */
  | { kind: "unstage-hunk"; path: string; patch: string }
  /**
   * Discard work-tree changes. `untracked` moves the file to the OS trash
   * instead of deleting it (the plan's D11), so this is always recoverable.
   */
  | { kind: "discard"; paths: string[]; untracked: boolean }
  /** Commit the index. `amend` replaces HEAD instead of adding a commit. */
  | { kind: "commit"; message: string; amend: boolean }
  /** Write a repository-local identity (never global: that is the user's file). */
  | { kind: "set-identity"; name: string; email: string }
  | { kind: "stash-push"; message: string | null }
  | { kind: "stash-pop"; index: number }
  | { kind: "stash-drop"; index: number }
  /** Switch to an existing local branch. */
  | { kind: "checkout-branch"; branch: string }
  /** Create and switch to a new branch at HEAD. */
  | { kind: "create-branch"; branch: string }
  | { kind: "fetch"; remote: string | null }
  | { kind: "pull" }
  | { kind: "push" }
  /** `git init` in the project folder, for a `not_a_repo` folder the user chose. */
  | { kind: "init" };

export type GitActionKind = GitAction["kind"];

export const GIT_ACTION_KINDS: readonly GitActionKind[] = [
  "stage",
  "unstage",
  "stage-hunk",
  "unstage-hunk",
  "discard",
  "commit",
  "set-identity",
  "stash-push",
  "stash-pop",
  "stash-drop",
  "checkout-branch",
  "create-branch",
  "fetch",
  "pull",
  "push",
  "init",
] as const;

/** The actions that write to the repository (as opposed to read it). */
export const GIT_MUTATING_ACTIONS: readonly GitActionKind[] = [
  "stage",
  "unstage",
  "stage-hunk",
  "unstage-hunk",
  "discard",
  "commit",
  "set-identity",
  "stash-push",
  "stash-pop",
  "stash-drop",
  "checkout-branch",
  "create-branch",
  "init",
] as const;

/** The actions that reach the network. Always an explicit button (plan D13). */
export const GIT_NETWORK_ACTIONS: readonly GitActionKind[] = ["fetch", "pull", "push"] as const;

export function isMutatingGitAction(kind: GitActionKind): boolean {
  return GIT_MUTATING_ACTIONS.includes(kind);
}

export function isNetworkGitAction(kind: GitActionKind): boolean {
  return GIT_NETWORK_ACTIONS.includes(kind);
}

/** The verb as a label for a toast: "Fetch" | "Pull" | "Push". */
export function syncVerbLabel(kind: GitActionKind): string {
  switch (kind) {
    case "fetch":
      return "Fetch";
    case "pull":
      return "Pull";
    case "push":
      return "Push";
    default:
      return "Git";
  }
}

/** The verb in progress, for the rail's status line: "Fetching" | "Pulling" | "Pushing". */
export function syncProgressLabel(kind: GitActionKind): string {
  switch (kind) {
    case "fetch":
      return "Fetching";
    case "pull":
      return "Pulling";
    case "push":
      return "Pushing";
    default:
      return "Running";
  }
}

/* --------------------------------------------------------------- failures */

/**
 * Distinct failure families the UI must not blur. `unknown` is deliberate: an
 * unrecognised stderr keeps its own text and gets no invented advice.
 */
export type GitFailureCode =
  | "git_missing"
  | "not_a_repo"
  | "index_locked"
  | "auth_required"
  | "non_fast_forward"
  | "conflict"
  | "detached_head"
  | "no_identity"
  | "dirty_tree"
  | "nothing_to_commit"
  | "no_upstream"
  | "pathspec"
  | "apply_failed"
  | "too_large"
  | "timeout"
  | "spawn_failed"
  | "permission"
  | "bad_request"
  | "unknown";

export interface GitOperationError {
  code: GitFailureCode;
  /** git's own first useful line, verbatim. */
  message: string;
  /** A next step the user can act on, when one is known. */
  fix?: string;
  /** True when retrying after the stated fix is plausible. */
  recoverable: boolean;
}

/** Stderr patterns, in priority order (the first match wins). */
const FAILURE_PATTERNS: ReadonlyArray<{ code: GitFailureCode; pattern: RegExp }> = [
  {
    code: "git_missing",
    pattern:
      /not recognized as an internal or external command|command not found|ENOENT|git: not found/i,
  },
  { code: "index_locked", pattern: /index\.lock|unable to create '.*\.lock'|cannot lock ref/i },
  {
    code: "auth_required",
    pattern:
      /authentication failed|could not read (?:username|password)|terminal prompts disabled|permission denied \(publickey\)|invalid username or password|access denied|403 forbidden/i,
  },
  {
    code: "non_fast_forward",
    pattern:
      /non-fast-forward|\[rejected\].*\(fetch first\)|failed to push some refs|updates were rejected/i,
  },
  { code: "conflict", pattern: /CONFLICT \(|Automatic merge failed|unmerged files|fix conflicts/i },
  {
    code: "dirty_tree",
    pattern:
      /your local changes.*would be overwritten|commit your changes or stash them|please commit your changes/i,
  },
  { code: "detached_head", pattern: /detached HEAD|you are not currently on a branch/i },
  {
    code: "no_identity",
    pattern:
      /please tell me who you are|unable to auto-detect email address|empty ident name|author identity unknown/i,
  },
  {
    code: "nothing_to_commit",
    pattern: /nothing to commit|no changes added to commit|nothing added to commit/i,
  },
  { code: "no_upstream", pattern: /has no upstream branch|no upstream configured|does not track/i },
  {
    code: "pathspec",
    pattern: /pathspec .* did not match|did not match any file\(s\) known to git/i,
  },
  { code: "apply_failed", pattern: /patch does not apply|error: patch failed|corrupt patch/i },
  { code: "not_a_repo", pattern: /not a git repository|does not appear to be a git repository/i },
  { code: "too_large", pattern: /exceeds the maximum|output too large/i },
  {
    code: "spawn_failed",
    pattern: /failed to spawn|spawn .* ENOENT|resource temporarily unavailable/i,
  },
];

const FIX_BY_CODE: Partial<Record<GitFailureCode, string>> = {
  git_missing:
    "Install Git and make sure it is on PATH, then reopen the rail. Source control and checkpoints need it.",
  index_locked:
    "Another git process is running (or an earlier one crashed). Close it, or delete .git/index.lock if nothing else is running.",
  auth_required:
    "Git could not authenticate non-interactively. Push or fetch once from a terminal to prime your SSH agent or credential helper, then retry here.",
  non_fast_forward:
    "Your branch is behind the remote. Pull first (or fetch, then merge), then push again.",
  conflict: "Resolve the conflicted files in your editor, stage them, then commit.",
  dirty_tree: "Commit or stash your changes first; git will not overwrite them.",
  detached_head: "Create a branch here before committing, so the commit is not lost.",
  no_identity:
    "Set your name and email in the commit box, or run git config --global user.name/user.email.",
  nothing_to_commit: "Stage at least one change before committing.",
  no_upstream: "Push once with --set-upstream, or pick a remote branch in the Git section.",
  pathspec: "The file changed on disk. Refresh the rail and try again.",
  apply_failed: "The file changed since the diff was read. Refresh and retry.",
  too_large: "The diff is too large to render here. Use your editor or a terminal for this file.",
  timeout:
    "Git did not answer in time. Check the network connection and the credential helper, then retry. A push or fetch that needs an interactive prompt cannot complete here.",
  spawn_failed: "The git process could not start. Check that it is installed and executable.",
};

const RECOVERABLE: ReadonlySet<GitFailureCode> = new Set<GitFailureCode>([
  "index_locked",
  "auth_required",
  "non_fast_forward",
  "conflict",
  "dirty_tree",
  "detached_head",
  "no_identity",
  "nothing_to_commit",
  "no_upstream",
  "pathspec",
  "apply_failed",
  "too_large",
  "timeout",
  "not_a_repo",
  "unknown",
]);

/** The first non-empty, non-hint line of git's stderr, trimmed for display. */
export function firstGitLine(text: string | undefined): string {
  if (!text) return "";
  const line = text
    .split(/\r?\n/)
    // A hint is advice, not the failure; skip it before stripping the prefix
    // (otherwise `hint: see git help` would read as the problem).
    .filter((entry) => !/^\s*hint:/i.test(entry))
    .map((entry) => entry.replace(/^(?:error|fatal|warning):\s*/i, "").trim())
    .find((entry) => entry.length > 0);
  return (line ?? "").slice(0, 500);
}

/**
 * Turns a failed git invocation into a named failure. `missing` (the executable
 * itself was absent) and `timedOut` (the runner killed the child) short-circuit
 * to their own codes, so a platform-specific spawn error or a partial stderr
 * line never has to be guessed from text.
 */
export function classifyGitFailure(input: {
  stderr?: string | undefined;
  code?: number | undefined;
  missing?: boolean | undefined;
  /** The runner killed the child at its timeout. */
  timedOut?: boolean | undefined;
  /** How long the call ran, for a truthful timeout message. */
  durationMs?: number | undefined;
}): GitOperationError {
  if (input.missing === true) {
    return {
      code: "git_missing",
      message: "Git is not installed, or it is not on this app's PATH.",
      fix: FIX_BY_CODE.git_missing as string,
      recoverable: false,
    };
  }
  // Before the stderr patterns: a killed child can leave a partial line that
  // matches an unrelated family, and "timed out" is the truth the user needs.
  if (input.timedOut === true) {
    const seconds =
      input.durationMs !== undefined && Number.isFinite(input.durationMs)
        ? Math.max(1, Math.round(input.durationMs / 1000))
        : null;
    return {
      code: "timeout",
      message:
        seconds === null
          ? "git timed out before it answered."
          : `git timed out after ${seconds} s.`,
      fix: FIX_BY_CODE.timeout as string,
      recoverable: true,
    };
  }
  const text = input.stderr ?? "";
  const match = FAILURE_PATTERNS.find((entry) => entry.pattern.test(text));
  const code: GitFailureCode = match?.code ?? "unknown";
  const message = firstGitLine(text) || `git exited with code ${input.code ?? "unknown"}`;
  const fix = FIX_BY_CODE[code];
  return {
    code,
    message,
    ...(fix ? { fix } : {}),
    recoverable: RECOVERABLE.has(code),
  };
}

/** The user-facing sentence for a folder git cannot serve. */
export function gitUnavailableMessage(reason: GitUnavailableReason): string {
  switch (reason) {
    case "git_missing":
      return "Git is not installed, or it is not on this app's PATH.";
    case "not_a_repo":
      return "This folder is not a git repository.";
    case "bare_repo":
      return "This folder is a bare repository, so it has no working tree to show.";
    case "no_folder":
      return "This folder does not exist any more.";
    case "operation_in_progress":
      return "Git is in the middle of an operation (a merge, rebase or cherry-pick). Finish it in a terminal first.";
  }
}

/* ------------------------------------------------------------- validation */

/**
 * A path is accepted only if it is a relative, forward-slash path that cannot
 * escape the work tree. Absolute paths, drive letters, backslashes, `..`
 * segments and NUL bytes are refused: every caller passes this through before
 * building an argv entry, and `git add --` still gets the `--` separator.
 */
export function isSafeRepoPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_REPO_PATH) return false;
  // eslint-disable-next-line no-control-regex -- NUL and friends must never reach an argv entry
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  if (value.startsWith("/") || value.startsWith("\\")) return false;
  // A drive letter or UNC prefix is absolute on Windows.
  if (/^[a-zA-Z]:/.test(value)) return false;
  if (value.includes("\\")) return false;
  const segments = value.split("/");
  if (!segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")) {
    return false;
  }
  // Nothing in `.git/` is a rail target: staging or restoring an internal file
  // would corrupt the repository, and the app never writes there.
  return segments[0]?.toLowerCase() !== ".git";
}

/**
 * Validates a branch name against the rules `git check-ref-format --branch`
 * enforces, without spawning a process. Conservative on purpose: a false
 * negative just means the user picks a slightly plainer name.
 */
export function sanitizeBranchName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (name.length === 0 || name.length > MAX_BRANCH_NAME) return null;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) return null;
  if (name.endsWith(".") || name.endsWith(".lock")) return null;
  if (name === "HEAD" || name === "@") return null;
  // eslint-disable-next-line no-control-regex -- git refuses control characters too
  if (/[\u0000-\u0020\u007f~^:?*[\\]/.test(name)) return null;
  if (name.includes("..") || name.includes("//") || name.includes("@{")) return null;
  if (name.split("/").some((part) => part.length === 0 || part.startsWith("."))) return null;
  return name;
}

/** Normalises a commit message: CRLF to LF, trimmed at the end, bounded. */
export function sanitizeCommitMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const message = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\s+$/, "");
  if (message.trim().length === 0) return null;
  return message.slice(0, MAX_COMMIT_MESSAGE);
}

/** A plausible email, bounded; the commit box refuses anything else. */
export function sanitizeIdentityEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim();
  if (email.length === 0 || email.length > 254) return null;
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) return null;
  return email;
}

/** A display name for the commit account: no control characters, bounded. */
export function sanitizeIdentityName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Check for control characters *before* collapsing whitespace: a newline is a
  // control character, and collapsing it first would silently accept it.
  // eslint-disable-next-line no-control-regex -- names go into a config file
  if (/[\u0000-\u001f\u007f<>]/.test(value)) return null;
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length === 0 || name.length > 120) return null;
  return name;
}

/** A remote name: the same shape git accepts for a config section key. */
export function sanitizeRemoteName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (name.length === 0 || name.length > 200) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  return name;
}

/** A stash index from `stash@{n}`; bounded so a stale row cannot address a hole. */
export function sanitizeStashIndex(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 0 || value > 999) return null;
  return value;
}

/** A full 40-character sha (lowercase hex). */
export function isFullSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

/** A unified patch we are willing to hand to `git apply`: bounded, non-empty. */
export function sanitizePatch(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_DIFF_BYTES) return null;

  if (value.includes("\u0000")) return null;
  // A patch must carry a file header and at least one hunk.
  if (!/^diff --git /m.test(value) || !/^@@ /m.test(value)) return null;
  return value;
}

/* ----------------------------------------------------------- action parser */

const RECORD = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function parsePaths(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.length > MAX_STATUS_PATHS) return null;
  const paths: string[] = [];
  for (const entry of value) {
    if (!isSafeRepoPath(entry)) return null;
    if (!paths.includes(entry)) paths.push(entry);
  }
  return paths.length > 0 ? paths : null;
}

/**
 * Parses an untrusted action payload. Returns null for anything unrecognised,
 * so `src/main/ipc.ts` can refuse it with one message and the service never has
 * to re-validate. Validation here is *shape* validation; membership (does this
 * path appear in the current status?) is the service's job.
 */
export function parseGitAction(value: unknown): GitAction | null {
  const record = RECORD(value);
  const kind = record.kind;
  if (typeof kind !== "string" || !GIT_ACTION_KINDS.includes(kind as GitActionKind)) return null;

  switch (kind as GitActionKind) {
    case "stage":
    case "unstage": {
      const paths = parsePaths(record.paths);
      return paths ? { kind: kind as "stage" | "unstage", paths } : null;
    }
    case "stage-hunk":
    case "unstage-hunk": {
      if (!isSafeRepoPath(record.path)) return null;
      const patch = sanitizePatch(record.patch);
      return patch
        ? { kind: kind as "stage-hunk" | "unstage-hunk", path: record.path, patch }
        : null;
    }
    case "discard": {
      const paths = parsePaths(record.paths);
      if (!paths) return null;
      if (typeof record.untracked !== "boolean") return null;
      return { kind: "discard", paths, untracked: record.untracked };
    }
    case "commit": {
      const message = sanitizeCommitMessage(record.message);
      if (!message) return null;
      if (record.amend !== undefined && typeof record.amend !== "boolean") return null;
      return { kind: "commit", message, amend: record.amend === true };
    }
    case "set-identity": {
      const name = sanitizeIdentityName(record.name);
      const email = sanitizeIdentityEmail(record.email);
      return name && email ? { kind: "set-identity", name, email } : null;
    }
    case "stash-push": {
      if (record.message === null || record.message === undefined) {
        return { kind: "stash-push", message: null };
      }
      const message = sanitizeCommitMessage(record.message);
      return message ? { kind: "stash-push", message } : null;
    }
    case "stash-pop":
    case "stash-drop": {
      const index = sanitizeStashIndex(record.index);
      return index === null ? null : { kind: kind as "stash-pop" | "stash-drop", index };
    }
    case "checkout-branch":
    case "create-branch": {
      const branch = sanitizeBranchName(record.branch);
      return branch ? { kind: kind as "checkout-branch" | "create-branch", branch } : null;
    }
    case "fetch": {
      if (record.remote === null || record.remote === undefined) {
        return { kind: "fetch", remote: null };
      }
      const remote = sanitizeRemoteName(record.remote);
      return remote ? { kind: "fetch", remote } : null;
    }
    case "pull":
      return { kind: "pull" };
    case "push":
      return { kind: "push" };
    case "init":
      return { kind: "init" };
    default:
      return null;
  }
}

/* --------------------------------------------------------- request parsers */

/**
 * A project folder the renderer may address (git-checkpoint plan step 7).
 *
 * The allowlist is the tab table's cwds plus the remembered projects, resolved
 * by main — never a path the renderer invents. Comparison is case- and
 * separator-insensitive so a Windows path that round-tripped through the UI is
 * not refused for its spelling; the engine still resolves the real work tree.
 *
 * Throws (rather than returning null) because a caller that passed an unknown
 * folder has a bug worth surfacing through the IPC error channel.
 */
export function requireProjectPath(known: readonly string[], value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("git: a project folder is required");
  }
  const requested = value.trim();
  // Unify separators *and* case: a Windows path that round-tripped through the
  // UI may come back with forward slashes, and `C:\work\app` must still match.
  const normalise = (target: string): string =>
    target.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const wanted = normalise(requested);
  if (!known.some((path) => normalise(path) === wanted)) {
    throw new Error(`git: ${requested} is not an open project`);
  }
  return requested;
}

/** Validates a `git:diff` request: one optional safe path, one side, one sha. */
export function parseGitDiffRequest(value: unknown): GitDiffRequest {
  const record = RECORD(value);
  const request: GitDiffRequest = {};
  if (record.path !== undefined) {
    if (!isSafeRepoPath(record.path)) throw new Error("git: invalid diff path");
    request.path = record.path;
  }
  if (record.staged !== undefined) {
    if (typeof record.staged !== "boolean") throw new Error("git: staged must be a boolean");
    request.staged = record.staged;
  }
  if (record.commit !== undefined) {
    if (!isFullSha(record.commit)) throw new Error("git: commit must be a full sha");
    request.commit = record.commit;
  }
  return request;
}

/** Validates a `git:log` page: a bounded window and an optional safe path. */
export function parseGitLogRequest(value: unknown): GitLogRequest {
  if (value === undefined || value === null) return {};
  const record = RECORD(value);
  const request: GitLogRequest = {};
  if (record.limit !== undefined) {
    if (typeof record.limit !== "number" || !Number.isFinite(record.limit)) {
      throw new Error("git: limit must be a number");
    }
    request.limit = Math.max(1, Math.min(MAX_LOG_PAGE, Math.floor(record.limit)));
  }
  if (record.skip !== undefined) {
    if (typeof record.skip !== "number" || !Number.isFinite(record.skip)) {
      throw new Error("git: skip must be a number");
    }
    request.skip = Math.max(0, Math.floor(record.skip));
  }
  if (record.path !== undefined) {
    if (!isSafeRepoPath(record.path)) throw new Error("git: invalid log path");
    request.path = record.path;
  }
  return request;
}

/* ------------------------------------------------------------- sanitizers */

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

const FILE_STATUSES: readonly GitFileStatus[] = [
  "modified",
  "added",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "conflicted",
];

function sanitizeFileEntry(value: unknown): GitFileEntry | null {
  const record = RECORD(value);
  if (!isSafeRepoPath(record.path)) return null;
  const status = FILE_STATUSES.includes(record.status as GitFileStatus)
    ? (record.status as GitFileStatus)
    : "modified";
  const origPath = isSafeRepoPath(record.origPath) ? record.origPath : null;
  return {
    path: record.path,
    origPath,
    status,
    staged: record.staged === true,
    unstaged: record.unstaged === true,
  };
}

function sanitizeFileEntries(value: unknown): GitFileEntry[] {
  if (!Array.isArray(value)) return [];
  const out: GitFileEntry[] = [];
  for (const entry of value) {
    const parsed = sanitizeFileEntry(entry);
    if (parsed) out.push(parsed);
    if (out.length >= MAX_STATUS_PATHS) break;
  }
  return out;
}

function sanitizeIdentity(value: unknown): GitIdentity | null {
  const record = RECORD(value);
  const name = sanitizeIdentityName(record.name);
  const email = sanitizeIdentityEmail(record.email);
  if (!name || !email) return null;
  const source = record.source;
  return {
    name,
    email,
    source:
      source === "repo" || source === "global" || source === "system"
        ? source
        : ("unknown" as const),
  };
}

function sanitizeRepoInfo(value: unknown): GitRepoInfo | null {
  const record = RECORD(value);
  if (typeof record.root !== "string" || record.root.length === 0) return null;
  const branch =
    typeof record.branch === "string" && sanitizeBranchName(record.branch) ? record.branch : null;
  return {
    root: record.root,
    gitDir: typeof record.gitDir === "string" ? record.gitDir : record.root,
    branch,
    head: typeof record.head === "string" ? record.head.slice(0, 64) : null,
    detached: record.detached === true,
    empty: record.empty === true,
    upstream: typeof record.upstream === "string" ? record.upstream.slice(0, 400) : null,
    ahead: Math.max(0, Math.floor(asNumber(record.ahead))),
    behind: Math.max(0, Math.floor(asNumber(record.behind))),
    remotes: Array.isArray(record.remotes)
      ? record.remotes
          .map((entry) => sanitizeRemoteName(entry))
          .filter((entry): entry is string => entry !== null)
          .slice(0, 50)
      : [],
    identity: sanitizeIdentity(record.identity),
  };
}

function sanitizeStashes(value: unknown): GitStashEntry[] {
  if (!Array.isArray(value)) return [];
  const out: GitStashEntry[] = [];
  for (const entry of value) {
    const record = RECORD(entry);
    const index = sanitizeStashIndex(record.index);
    if (index === null || typeof record.ref !== "string") continue;
    out.push({
      ref: record.ref,
      index,
      subject: typeof record.subject === "string" ? record.subject.slice(0, 500) : "",
      at: Math.max(0, Math.floor(asNumber(record.at))),
    });
    if (out.length >= 100) break;
  }
  return out;
}

function sanitizeOperationError(value: unknown): GitOperationError | undefined {
  const record = RECORD(value);
  if (typeof record.message !== "string" || record.message.length === 0) return undefined;
  const code = typeof record.code === "string" ? record.code : "unknown";
  return {
    code: code as GitFailureCode,
    message: record.message.slice(0, 500),
    ...(typeof record.fix === "string" ? { fix: record.fix.slice(0, 500) } : {}),
    recoverable: record.recoverable === true,
  };
}

const UNAVAILABLE_REASONS: readonly GitUnavailableReason[] = [
  "git_missing",
  "not_a_repo",
  "bare_repo",
  "no_folder",
  "operation_in_progress",
];

/** Coerces an untrusted snapshot (a pushed IPC payload or a test fixture). */
export function sanitizeGitSnapshot(value: unknown): GitSnapshot {
  const record = RECORD(value);
  const reason = UNAVAILABLE_REASONS.includes(record.reason as GitUnavailableReason)
    ? (record.reason as GitUnavailableReason)
    : undefined;
  const available = record.available === true && record.repo !== undefined;
  const staged = sanitizeFileEntries(record.staged);
  const changed = sanitizeFileEntries(record.changed);
  const error = sanitizeOperationError(record.error);
  const snapshot: GitSnapshot = {
    projectPath: typeof record.projectPath === "string" ? record.projectPath : "",
    available,
    staged,
    changed,
    truncated: record.truncated === true,
    totalChanged: Math.max(
      0,
      Math.floor(asNumber(record.totalChanged, staged.length + changed.length)),
    ),
    stashes: sanitizeStashes(record.stashes),
    fetchedAt: typeof record.fetchedAt === "string" ? record.fetchedAt : new Date(0).toISOString(),
    ...(error ? { error } : {}),
  };
  if (!available) {
    const fallback: GitUnavailableReason = reason ?? "not_a_repo";
    snapshot.reason = fallback;
    snapshot.message =
      typeof record.message === "string" ? record.message : gitUnavailableMessage(fallback);
    return snapshot;
  }
  const repo = sanitizeRepoInfo(record.repo);
  if (repo) {
    snapshot.repo = repo;
  } else {
    // An "available" snapshot without a repository is a lie; report it honestly.
    snapshot.available = false;
    snapshot.reason = "not_a_repo";
    snapshot.message = gitUnavailableMessage("not_a_repo");
  }
  return snapshot;
}

/** An empty, unavailable snapshot (the value before the first read). */
export function emptyGitSnapshot(
  projectPath: string,
  reason: GitUnavailableReason = "not_a_repo",
): GitSnapshot {
  return {
    projectPath,
    available: false,
    reason,
    message: gitUnavailableMessage(reason),
    staged: [],
    changed: [],
    truncated: false,
    totalChanged: 0,
    stashes: [],
    fetchedAt: new Date(0).toISOString(),
  };
}

/* ----------------------------------------------------------- display bits */

/** The letter VS Code's source-control view uses for a status. */
export function gitStatusLetter(status: GitFileStatus): string {
  switch (status) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "untracked":
      return "U";
    case "conflicted":
      return "!";
  }
}

/** Semantic tone for a status letter, so the rail never hard-codes a colour. */
export function gitStatusTone(status: GitFileStatus): "ok" | "warn" | "danger" | "neutral" {
  switch (status) {
    case "added":
    case "untracked":
      return "ok";
    case "modified":
    case "renamed":
    case "copied":
      return "warn";
    case "deleted":
    case "conflicted":
      return "danger";
  }
}

/** One-line description of the repository state for the rail header. */
export function describeGitHead(repo: GitRepoInfo | undefined): string {
  if (!repo) return "no repository";
  if (repo.empty) return repo.branch ? `${repo.branch} (no commits yet)` : "no commits yet";
  if (repo.detached) return repo.head ? `detached at ${repo.head.slice(0, 7)}` : "detached";
  const branch = repo.branch ?? "unknown branch";
  if (!repo.upstream) return branch;
  const parts: string[] = [];
  if (repo.ahead > 0) parts.push(`↑${repo.ahead}`);
  if (repo.behind > 0) parts.push(`↓${repo.behind}`);
  return parts.length > 0 ? `${branch} ${parts.join(" ")}` : branch;
}

/** True when the snapshot has something worth committing. */
export function hasStagedChanges(snapshot: GitSnapshot | undefined): boolean {
  return (snapshot?.staged.length ?? 0) > 0;
}
