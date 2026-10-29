/**
 * The git service (git-checkpoint plan step 6).
 *
 * One object that turns "what does the rail need?" into a bounded number of git
 * invocations, and turns a validated `GitAction` into an argv. It owns the three
 * rules the rest of the app relies on:
 *
 *  1. **Snapshot assembly.** `snapshot()` is cheap, single-flight and memoised,
 *     so a poll and a double-click never run three `git status` at once.
 *  2. **Action dispatch.** Every action re-validates *membership* — a path must
 *     appear in the status the rail is looking at, a branch must exist — so a
 *     stale renderer cannot stage a file git no longer knows.
 *  3. **Failure as a value.** Nothing throws across the boundary: a failed
 *     action resolves to `{ ok: false, error }` with a classified code and a
 *     fix sentence, which is what the rail renders.
 *
 * Electron-free and filesystem-free (AGENTS rules 1-2): the last point needs an
 * OS trash for an untracked discard, so that arrives as an injected port.
 */

import {
  classifyGitFailure,
  gitUnavailableMessage,
  MAX_STATUS_PATHS,
  sanitizeBranchName,
  type GitAction,
  type GitActionResult,
  type GitCommitEntry,
  type GitDiff,
  type GitLogRequest,
  type GitOperationError,
  type GitSnapshot,
} from "../shared/git";
import { applyHunkPatch, readDiff, type DiffRequest } from "./diff";
import { initRepository, readRepo, type ReadRepoOptions } from "./repo";
import {
  GIT_NETWORK_TIMEOUT_MS,
  GIT_STATUS_TIMEOUT_MS,
  GIT_WRITE_TIMEOUT_MS,
  type GitRunner,
} from "./runner";
import { readStashes, readStatus } from "./status";

/** Moves a file to the OS trash (never a bare delete). */
export interface TrashPort {
  /** Resolves true when the file was moved somewhere recoverable. */
  trash(absolutePath: string): Promise<boolean>;
}

export interface GitServiceDeps {
  runner: GitRunner;
  /** Injected folder probe for the availability reasons. */
  pathKind?: ReadRepoOptions["pathKind"];
  /** Moves a discarded untracked file somewhere recoverable. */
  trash?: TrashPort;
  /**
   * Called immediately before a destructive action (discard, branch switch),
   * so the checkpoint service can take a `pre-op` snapshot. A throw aborts the
   * action: a safety snapshot that cannot be taken must not be skipped.
   */
  preOpSnapshot?: (projectPath: string, note: string) => Promise<void>;
  /** Injected clock, for the memo TTL and `fetchedAt`. */
  now?: () => number;
  /** How long a memoised snapshot is reused. */
  memoMs?: number;
}

/** One page of the commit log. The wire shape is `GitLogRequest` in shared. */
export type GitLogOptions = GitLogRequest;

export interface GitService {
  /** The rail's whole state for a folder. Never throws. */
  snapshot(projectPath: string, options?: { fresh?: boolean }): Promise<GitSnapshot>;
  /** One diff side, for the viewer. */
  diff(projectPath: string, request: DiffRequest): Promise<GitDiff>;
  /** One page of the commit log. */
  log(projectPath: string, options?: GitLogOptions): Promise<GitCommitEntry[]>;
  /**
   * HEAD's full commit message, for the amend box. Null when there is no commit
   * yet (or the folder is not a repository).
   */
  headMessage(projectPath: string): Promise<string | null>;
  /** Runs a validated action. */
  action(projectPath: string, action: GitAction): Promise<GitActionResult>;
  /** The branches a checkout menu can offer. */
  branches(projectPath: string): Promise<{ local: string[]; current: string | null }>;
  /** Drops every memoised snapshot (after a config change or a resume). */
  clearCache(): void;
}

/** How long an unchanged snapshot is reused; the poll interval is the real clock. */
export const DEFAULT_GIT_MEMO_MS = 1_000;

/** The outcome of a raw git call, already classified. */
function failed(stderr: string, code: number, missing = false): GitActionResult {
  return { ok: false, error: classifyGitFailure({ stderr, code, missing }) };
}

function ok(message?: string): GitActionResult {
  return message === undefined ? { ok: true } : { ok: true, message };
}

interface MemoEntry {
  snapshot: GitSnapshot;
  at: number;
}

export function createGitService(deps: GitServiceDeps): GitService {
  const now = deps.now ?? ((): number => Date.now());
  const memoMs = deps.memoMs ?? DEFAULT_GIT_MEMO_MS;

  /** Finished snapshots, keyed by project path. */
  const memo = new Map<string, MemoEntry>();
  /** In-flight snapshots, so concurrent callers share one read. */
  const inFlight = new Map<string, Promise<GitSnapshot>>();
  /** One mutating action at a time per repository, so two clicks cannot interleave. */
  const actionQueue = new Map<string, Promise<unknown>>();

  const readSnapshot = async (projectPath: string): Promise<GitSnapshot> => {
    const fetchedAt = new Date(now()).toISOString();
    const repo = await readRepo(deps.runner, projectPath, {
      ...(deps.pathKind ? { pathKind: deps.pathKind } : {}),
    });
    if (!repo.available || !repo.repo) {
      return {
        projectPath,
        available: false,
        reason: repo.reason ?? "not_a_repo",
        message: gitUnavailableMessage(repo.reason ?? "not_a_repo"),
        staged: [],
        changed: [],
        truncated: false,
        totalChanged: 0,
        stashes: [],
        fetchedAt,
      };
    }

    const root = repo.repo.root;
    // `status` is the only read that must succeed; stashes are a nicety.
    const status = await readStatus(deps.runner, root, { timeoutMs: GIT_STATUS_TIMEOUT_MS });
    if (!status.ok) {
      // A repository that `rev-parse` accepted but `status` refused (a lock, a
      // half-written index) is reported as unavailable with git's own words.
      const error = classifyGitFailure({
        stderr: status.stderr,
        missing: status.missing,
      });
      return {
        projectPath,
        available: false,
        reason: error.code === "git_missing" ? "git_missing" : "not_a_repo",
        message: error.fix ? `${error.message} ${error.fix}` : error.message,
        staged: [],
        changed: [],
        truncated: false,
        totalChanged: 0,
        stashes: [],
        fetchedAt,
      };
    }

    const stashes = await readStashes(deps.runner, root, { timeoutMs: GIT_STATUS_TIMEOUT_MS });

    // `branch.ab` is only present when the branch has an upstream; prefer it
    // over the `rev-list` probe because it is the same answer for free.
    const repoWithCounts =
      status.branch && status.branch.head === repo.repo.branch
        ? { ...repo.repo, ahead: status.branch.ahead, behind: status.branch.behind }
        : repo.repo;

    return {
      projectPath,
      available: true,
      repo: repoWithCounts,
      staged: status.staged.slice(0, MAX_STATUS_PATHS),
      changed: status.changed.slice(0, MAX_STATUS_PATHS),
      truncated: status.truncated,
      totalChanged: status.total,
      stashes,
      fetchedAt,
    };
  };

  const snapshot = async (
    projectPath: string,
    options: { fresh?: boolean } = {},
  ): Promise<GitSnapshot> => {
    const cached = memo.get(projectPath);
    if (!options.fresh && cached && now() - cached.at < memoMs) return cached.snapshot;

    const running = inFlight.get(projectPath);
    if (running) return running;

    const promise = readSnapshot(projectPath)
      .catch((error: unknown): GitSnapshot => ({
        projectPath,
        available: false,
        reason: "not_a_repo",
        message: error instanceof Error ? error.message : String(error),
        staged: [],
        changed: [],
        truncated: false,
        totalChanged: 0,
        stashes: [],
        fetchedAt: new Date(now()).toISOString(),
      }))
      .then((result) => {
        memo.set(projectPath, { snapshot: result, at: now() });
        inFlight.delete(projectPath);
        return result;
      });
    inFlight.set(projectPath, promise);
    return promise;
  };

  /** Runs one action under a per-project lock and invalidates the memo. */
  const runExclusive = async <T>(projectPath: string, work: () => Promise<T>): Promise<T> => {
    const previous = actionQueue.get(projectPath) ?? Promise.resolve();
    const next = previous.then(work, work);
    // The queue only needs ordering, not the value; swallow a rejection so the
    // next action is not blocked by a failed one.
    actionQueue.set(
      projectPath,
      next.catch(() => undefined),
    );
    try {
      return await next;
    } finally {
      memo.delete(projectPath);
    }
  };

  /** The paths an action may touch: exactly what the last status reported. */
  const knownPaths = async (root: string): Promise<Set<string>> => {
    const status = await readStatus(deps.runner, root, { timeoutMs: GIT_STATUS_TIMEOUT_MS });
    const paths = new Set<string>();
    for (const entry of [...status.staged, ...status.changed]) paths.add(entry.path);
    return paths;
  };

  const requireKnownPaths = async (
    root: string,
    paths: readonly string[],
  ): Promise<GitOperationError | null> => {
    const known = await knownPaths(root);
    const unknown = paths.filter((path) => !known.has(path));
    if (unknown.length === 0) return null;
    return {
      code: "pathspec",
      message: `${unknown[0]} is not a changed file any more.`,
      fix: "Refresh the rail and try again.",
      recoverable: true,
    };
  };

  const dispatch = async (root: string, action: GitAction): Promise<GitActionResult> => {
    switch (action.kind) {
      case "stage": {
        const stale = await requireKnownPaths(root, action.paths);
        if (stale) return { ok: false, error: stale };
        const result = await deps.runner.run(root, ["add", "--", ...action.paths], {
          timeoutMs: GIT_WRITE_TIMEOUT_MS,
        });
        if (result.code !== 0 || result.missing) {
          return failed(result.stderr, result.code, result.missing);
        }
        return ok(
          action.paths.length === 1
            ? `Staged ${action.paths[0]}.`
            : `Staged ${action.paths.length} files.`,
        );
      }

      case "unstage": {
        // `restore --staged` keeps the work tree; `reset` would too, but its
        // form depends on whether HEAD exists.
        const result = await deps.runner.run(root, ["restore", "--staged", "--", ...action.paths], {
          timeoutMs: GIT_WRITE_TIMEOUT_MS,
        });
        if (result.code === 0 && !result.missing) {
          return ok(
            action.paths.length === 1
              ? `Unstaged ${action.paths[0]}.`
              : `Unstaged ${action.paths.length} files.`,
          );
        }
        // An empty repository has no HEAD to restore from; fall back to reset.
        const fallback = await deps.runner.run(root, ["reset", "--", ...action.paths], {
          timeoutMs: GIT_WRITE_TIMEOUT_MS,
        });
        if (fallback.code !== 0 || fallback.missing) {
          return failed(
            result.stderr || fallback.stderr,
            result.code || fallback.code,
            result.missing,
          );
        }
        return ok();
      }

      case "stage-hunk":
      case "unstage-hunk": {
        const applied = await applyHunkPatch(deps.runner, root, action.patch, {
          reverse: action.kind === "unstage-hunk",
        });
        if (!applied.ok) {
          return {
            ok: false,
            error: classifyGitFailure({ stderr: applied.stderr, code: 1 }),
          };
        }
        return ok(action.kind === "stage-hunk" ? "Staged one hunk." : "Unstaged one hunk.");
      }

      case "discard": {
        if (deps.preOpSnapshot) {
          await deps.preOpSnapshot(root, `discard ${action.paths.length} file(s)`);
        }
        const tracked = action.untracked ? [] : action.paths;
        const untracked = action.untracked ? action.paths : [];
        if (tracked.length > 0) {
          const result = await deps.runner.run(root, ["checkout", "--", ...tracked], {
            timeoutMs: GIT_WRITE_TIMEOUT_MS,
          });
          if (result.code !== 0 || result.missing) {
            return failed(result.stderr, result.code, result.missing);
          }
        }
        if (untracked.length > 0) {
          if (!deps.trash) {
            return {
              ok: false,
              error: {
                code: "unknown",
                message:
                  "Discarding an untracked file needs the OS trash, which is unavailable here.",
                recoverable: false,
              },
            };
          }
          const refused: string[] = [];
          for (const path of untracked) {
            const moved = await deps.trash.trash(joinPath(root, path));
            if (!moved) refused.push(path);
          }
          if (refused.length > 0) {
            return {
              ok: false,
              error: {
                code: "permission",
                message: `Could not move ${refused[0]} to the trash.`,
                fix: "Delete it yourself, or check the folder's permissions.",
                recoverable: false,
              },
            };
          }
        }
        return ok(
          action.untracked
            ? `Moved ${action.paths.length} untracked file(s) to the trash.`
            : `Discarded changes in ${action.paths.length} file(s).`,
        );
      }

      case "commit": {
        const identity = await ensureIdentity(deps.runner, root);
        if (identity) return { ok: false, error: identity };
        // `-F -` keeps the message byte-exact (no shell quoting, no `-m`
        // concatenation), and `--no-verify` is deliberately *not* passed: the
        // user's hooks are their own.
        const args = ["commit", "-F", "-", ...(action.amend ? ["--amend"] : [])];
        const result = await deps.runner.run(root, args, {
          input: action.message,
          timeoutMs: GIT_WRITE_TIMEOUT_MS,
        });
        if (result.code !== 0 || result.missing) {
          return failed(result.stderr || result.stdout, result.code, result.missing);
        }
        const firstLine = action.message.split("\n")[0] ?? "";
        return ok(action.amend ? "Amended the last commit." : `Committed: ${firstLine}`);
      }

      case "set-identity": {
        // Repository-local only: the user's global config is theirs.
        for (const [key, value] of [
          ["user.name", action.name],
          ["user.email", action.email],
        ] as const) {
          const result = await deps.runner.run(root, ["config", "--local", key, value], {
            timeoutMs: GIT_WRITE_TIMEOUT_MS,
          });
          if (result.code !== 0 || result.missing) {
            return failed(result.stderr, result.code, result.missing);
          }
        }
        return ok(`This repository now commits as ${action.name} <${action.email}>.`);
      }

      case "stash-push": {
        const args = ["stash", "push"];
        if (action.message) args.push("-m", action.message);
        const result = await deps.runner.run(root, args, { timeoutMs: GIT_WRITE_TIMEOUT_MS });
        if (result.code !== 0 || result.missing) {
          // "No local changes to save" exits 0 in modern git; a real failure is
          // anything else.
          return failed(result.stderr, result.code, result.missing);
        }
        return ok("Stashed the working tree.");
      }

      case "stash-pop":
      case "stash-drop": {
        const result = await deps.runner.run(
          root,
          ["stash", action.kind === "stash-pop" ? "pop" : "drop", `stash@{${action.index}}`],
          { timeoutMs: GIT_WRITE_TIMEOUT_MS },
        );
        if (result.code !== 0 || result.missing) {
          return failed(result.stderr, result.code, result.missing);
        }
        return ok(action.kind === "stash-pop" ? "Restored the stash." : "Dropped the stash.");
      }

      case "checkout-branch": {
        const branch = sanitizeBranchName(action.branch);
        if (!branch) {
          return {
            ok: false,
            error: {
              code: "bad_request",
              message: "That is not a valid branch name.",
              recoverable: false,
            },
          };
        }
        if (deps.preOpSnapshot) await deps.preOpSnapshot(root, `switch to ${branch}`);
        const result = await deps.runner.run(root, ["switch", branch], {
          timeoutMs: GIT_WRITE_TIMEOUT_MS,
        });
        if (result.code !== 0 || result.missing) {
          return failed(result.stderr, result.code, result.missing);
        }
        return ok(`Switched to ${branch}.`);
      }

      case "create-branch": {
        const branch = sanitizeBranchName(action.branch);
        if (!branch) {
          return {
            ok: false,
            error: {
              code: "bad_request",
              message: "That is not a valid branch name.",
              recoverable: false,
            },
          };
        }
        const result = await deps.runner.run(root, ["switch", "-c", branch], {
          timeoutMs: GIT_WRITE_TIMEOUT_MS,
        });
        if (result.code !== 0 || result.missing) {
          return failed(result.stderr, result.code, result.missing);
        }
        return ok(`Created and switched to ${branch}.`);
      }

      case "fetch": {
        const args = ["fetch", ...(action.remote ? [action.remote] : [])];
        const result = await deps.runner.run(root, args, { timeoutMs: GIT_NETWORK_TIMEOUT_MS });
        if (result.code !== 0 || result.missing) {
          return failed(result.stderr, result.code, result.missing);
        }
        return ok("Fetched.");
      }

      case "pull": {
        const result = await deps.runner.run(root, ["pull", "--no-edit"], {
          timeoutMs: GIT_NETWORK_TIMEOUT_MS,
          env: { GIT_EDITOR: ":" },
        });
        if (result.code !== 0 || result.missing) {
          return failed(result.stderr, result.code, result.missing);
        }
        return ok("Pulled.");
      }

      case "push": {
        const result = await deps.runner.run(root, ["push"], { timeoutMs: GIT_NETWORK_TIMEOUT_MS });
        if (result.code === 0 && !result.missing) return ok("Pushed.");
        const failure = classifyGitFailure({ stderr: result.stderr, code: result.code });
        // The very first push of a new branch has no upstream; git says so and
        // the fix is a single well-known flag, so offer it rather than making the
        // user read a wall of hint text.
        if (failure.code === "no_upstream") {
          const repo = await readRepo(deps.runner, root);
          const branch = repo.repo?.branch;
          const remote = repo.repo?.remotes[0] ?? "origin";
          if (branch) {
            const pushed = await deps.runner.run(root, ["push", "--set-upstream", remote, branch], {
              timeoutMs: GIT_NETWORK_TIMEOUT_MS,
            });
            if (pushed.code === 0 && !pushed.missing) {
              return ok(`Pushed ${branch} to ${remote} and set the upstream.`);
            }
          }
        }
        return { ok: false, error: failure };
      }

      case "init": {
        const created = await initRepository(deps.runner, root);
        if (!created.ok) {
          return {
            ok: false,
            error: { code: "unknown", message: created.message, recoverable: false },
          };
        }
        return ok("Initialised a repository here.");
      }

      default: {
        // Exhaustiveness: adding a `GitAction` variant fails this assignment.
        const exhaustive: never = action;
        return {
          ok: false,
          error: {
            code: "bad_request",
            message: `Unsupported git action: ${JSON.stringify(exhaustive)}`,
            recoverable: false,
          },
        };
      }
    }
  };

  return {
    snapshot,

    async diff(projectPath, request) {
      const repo = await readRepo(deps.runner, projectPath, {
        ...(deps.pathKind ? { pathKind: deps.pathKind } : {}),
      });
      if (!repo.available || !repo.repo) {
        return { scope: "working" as const, files: [], tooLarge: false, truncated: false };
      }
      return readDiff(deps.runner, repo.repo.root, request);
    },

    async log(projectPath, options = {}) {
      const repo = await readRepo(deps.runner, projectPath, {
        ...(deps.pathKind ? { pathKind: deps.pathKind } : {}),
      });
      if (!repo.available || !repo.repo) return [];
      const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 30)));
      const skip = Math.max(0, Math.floor(options.skip ?? 0));
      return readLog(deps.runner, repo.repo.root, { limit, skip, path: options.path });
    },

    async headMessage(projectPath) {
      const repo = await readRepo(deps.runner, projectPath, {
        ...(deps.pathKind ? { pathKind: deps.pathKind } : {}),
      });
      if (!repo.available || !repo.repo) return null;
      return readHeadMessage(deps.runner, repo.repo.root);
    },

    async action(projectPath, action) {
      const repo = await readRepo(deps.runner, projectPath, {
        ...(deps.pathKind ? { pathKind: deps.pathKind } : {}),
      });
      if (!repo.available || !repo.repo) {
        // `init` is the one action a plain folder can accept.
        if (action.kind === "init" && repo.reason === "not_a_repo") {
          return runExclusive(projectPath, () => dispatch(projectPath, action));
        }
        return {
          ok: false,
          error: {
            code: repo.reason === "git_missing" ? "git_missing" : "not_a_repo",
            message: gitUnavailableMessage(repo.reason ?? "not_a_repo"),
            recoverable: false,
          },
        };
      }
      return runExclusive(repo.repo.root, () => dispatch(repo.repo?.root ?? projectPath, action));
    },

    async branches(projectPath) {
      const repo = await readRepo(deps.runner, projectPath, {
        ...(deps.pathKind ? { pathKind: deps.pathKind } : {}),
      });
      if (!repo.available || !repo.repo) return { local: [], current: null };
      const result = await deps.runner.run(
        repo.repo.root,
        ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        { timeoutMs: GIT_STATUS_TIMEOUT_MS },
      );
      const local =
        result.code === 0
          ? result.stdout
              .split(/\r?\n/)
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0)
              .sort((left, right) => left.localeCompare(right))
          : [];
      return { local, current: repo.repo.branch };
    },

    clearCache() {
      memo.clear();
      inFlight.clear();
    },
  };
}

/** Joins a repo-relative path onto the work-tree root, POSIX-style. */
function joinPath(root: string, relative: string): string {
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const base = root.replace(/[\\/]+$/, "");
  return `${base}${separator}${relative.split("/").join(separator)}`;
}

/**
 * The commit identity check. Returns a failure when the repository has none, so
 * `commit` can say "set your name and email" instead of letting git print a
 * seven-line hint.
 */
async function ensureIdentity(runner: GitRunner, root: string): Promise<GitOperationError | null> {
  const [name, email] = await Promise.all([
    runner.run(root, ["config", "--get", "user.name"], { timeoutMs: GIT_STATUS_TIMEOUT_MS }),
    runner.run(root, ["config", "--get", "user.email"], { timeoutMs: GIT_STATUS_TIMEOUT_MS }),
  ]);
  if (name.code === 0 && email.code === 0 && name.stdout.trim() && email.stdout.trim()) {
    return null;
  }
  return {
    code: "no_identity",
    message: "This repository has no commit identity (user.name / user.email).",
    fix: "Set your name and email in the commit box, or run git config --global user.name/user.email.",
    recoverable: true,
  };
}

/**
 * HEAD's complete commit message (subject and body), or null when there is no
 * commit yet. `%B` is the raw message, which is exactly what `--amend -F -`
 * needs: prefilling from the log's subject would silently drop a body.
 */
export async function readHeadMessage(runner: GitRunner, root: string): Promise<string | null> {
  const result = await runner.run(root, ["show", "-s", "--format=%B", "HEAD"], {
    timeoutMs: GIT_STATUS_TIMEOUT_MS,
  });
  if (result.code !== 0 || result.missing) return null;
  const text = result.stdout.replace(/\s+$/, "");
  return text.length > 0 ? text : null;
}

/** `git log` in a format the parser can trust, bounded and path-aware. */
export async function readLog(
  runner: GitRunner,
  root: string,
  options: { limit: number; skip: number; path?: string },
): Promise<GitCommitEntry[]> {
  // `%x00` between fields, `%x1e` between records: neither can occur in a
  // subject, and both survive a subject that contains a pipe or a tab.
  const format = "%H%x00%h%x00%s%x00%an%x00%ct%x00%D";
  const args = [
    "log",
    `--max-count=${options.limit}`,
    `--skip=${options.skip}`,
    "--no-color",
    `--format=${format}%x1e`,
  ];
  if (options.path) args.push("--", options.path);
  const result = await runner.run(root, args, { timeoutMs: GIT_STATUS_TIMEOUT_MS });
  if (result.code !== 0 || result.missing) return [];

  const entries: GitCommitEntry[] = [];
  for (const record of result.stdout.split("\u001e")) {
    const trimmed = record.replace(/^\r?\n/, "");
    if (trimmed.length === 0) continue;
    const [sha = "", shortSha = "", subject = "", author = "", seconds = "", refs = ""] =
      trimmed.split("\u0000");
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    const at = Number.parseInt(seconds, 10);
    entries.push({
      sha,
      shortSha,
      subject,
      author,
      at: Number.isFinite(at) ? at * 1000 : 0,
      refs: parseRefs(refs),
      head: isHeadDecoration(refs),
    });
  }
  return entries;
}

/**
 * `%D` gives `HEAD -> main, origin/main, tag: v1.0`. The rail only needs the
 * branch/tag names, and `HEAD ->` is noise it reconstructs from `head`.
 */
function parseRefs(value: string): string[] {
  if (value.trim().length === 0) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry !== "HEAD")
    .map((entry) => entry.replace(/^HEAD -> /, ""))
    .map((entry) => entry.replace(/^tag: /, ""))
    .slice(0, 12);
}

/**
 * True when `%D` marks this commit as HEAD. Both forms occur: `HEAD` alone on an
 * unborn branch's tip-less log, and `HEAD -> main` when the branch is emitted.
 */
function isHeadDecoration(value: string): boolean {
  return /(?:^|,\s*)HEAD(?:\s*->|,|$)/.test(value);
}
