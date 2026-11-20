/**
 * Repository discovery and identity (git-checkpoint plan step 3).
 *
 * Answers the one question the rail asks before anything else: *is this folder
 * a work tree, and what does git say about it?* Every failure is a named reason
 * (`git_missing`, `not_a_repo`, `bare_repo`, `no_folder`), never an exception,
 * because "not a git repository" is a normal state for an Office folder and the
 * rail has a first-class empty state for it.
 *
 * The probes are deliberately few and cheap: `rev-parse` for the layout,
 * `symbolic-ref`/`rev-parse --short HEAD` for the head, `rev-list --count` for
 * the upstream divergence, and two `config --get` calls for the identity. All
 * of them are bounded by the runner's timeouts.
 */

import type { GitIdentity, GitRepoInfo, GitUnavailableReason } from "../shared/git";
import type { GitRunner } from "./runner";
import { GIT_STATUS_TIMEOUT_MS } from "./runner";

/** One probe's outcome, so the caller can tell "no answer" from "empty answer". */
export interface RepoProbe {
  root: string;
  gitDir: string;
}

export interface RepoReadResult {
  available: boolean;
  reason?: GitUnavailableReason;
  repo?: GitRepoInfo;
  /** A raw git message for Diagnostics; the rail uses `reason` instead. */
  detail?: string;
}

export interface ReadRepoOptions {
  /**
   * Injected folder probe. The engine never touches `node:fs` directly (AGENTS
   * rule 2); main and the host both supply a `stat`-backed implementation.
   */
  pathKind?: (target: string) => Promise<"file" | "directory" | null>;
  timeoutMs?: number;
}

/** One line of stdout, trimmed; empty becomes null. */
function line(text: string): string | null {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Reads the repository facts for `cwd`. Resolves to `available: false` with a
 * reason for every ordinary "no" (no git, no folder, not a repo, bare repo).
 */
export async function readRepo(
  runner: GitRunner,
  cwd: string,
  options: ReadRepoOptions = {},
): Promise<RepoReadResult> {
  const timeoutMs = options.timeoutMs ?? GIT_STATUS_TIMEOUT_MS;

  // The folder has to exist, or `rev-parse` reports a confusing not-a-repo.
  if (options.pathKind) {
    const kind = await options.pathKind(cwd);
    if (kind !== "directory") return { available: false, reason: "no_folder" };
  }

  const top = await runner.run(cwd, ["rev-parse", "--show-toplevel"], { timeoutMs });
  if (top.missing) return { available: false, reason: "git_missing" };
  if (top.timedOut) {
    return { available: false, reason: "timeout", detail: "git rev-parse timed out" };
  }
  const root = line(top.stdout);
  if (top.code !== 0 || root === null) {
    // Distinguish a bare repository: `--show-toplevel` fails there too, but
    // `--is-bare-repository` answers true, which is the more useful message.
    const bare = await runner.run(cwd, ["rev-parse", "--is-bare-repository"], { timeoutMs });
    if (!bare.missing && bare.code === 0 && line(bare.stdout) === "true") {
      return { available: false, reason: "bare_repo" };
    }
    return { available: false, reason: "not_a_repo", detail: line(top.stderr) ?? undefined };
  }

  const insideWorkTree = await runner.run(root, ["rev-parse", "--is-inside-work-tree"], {
    timeoutMs,
  });
  if (insideWorkTree.code === 0 && line(insideWorkTree.stdout) === "false") {
    return { available: false, reason: "bare_repo" };
  }

  const gitDirResult = await runner.run(root, ["rev-parse", "--absolute-git-dir"], {
    timeoutMs,
  });
  // `--absolute-git-dir` is modern git; a very old binary falls back to the
  // relative `--git-dir`, which is still a usable path for Diagnostics.
  const gitDir =
    gitDirResult.code === 0 && line(gitDirResult.stdout)
      ? (line(gitDirResult.stdout) as string)
      : ((line(gitDirResult.stdout) ?? `${root}/.git`) as string);

  // An in-flight merge/rebase/cherry-pick makes several actions fail with a
  // confusing message; telling the user up front is kinder.
  const operation = await detectOperation(runner, gitDir, options.pathKind, timeoutMs);
  if (operation) {
    return {
      available: false,
      reason: "operation_in_progress",
      detail: `${operation} in progress`,
    };
  }

  const [branchResult, headResult, upstreamResult, remoteResult, identity] = await Promise.all([
    runner.run(root, ["symbolic-ref", "--short", "HEAD"], { timeoutMs }),
    runner.run(root, ["rev-parse", "--short", "HEAD"], { timeoutMs }),
    runner.run(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
      timeoutMs,
    }),
    runner.run(root, ["remote"], { timeoutMs }),
    readIdentity(runner, root, timeoutMs),
  ]);

  const branch = branchResult.code === 0 ? line(branchResult.stdout) : null;
  const head = headResult.code === 0 ? line(headResult.stdout) : null;
  const upstream = upstreamResult.code === 0 ? line(upstreamResult.stdout) : null;
  const remotes =
    remoteResult.code === 0
      ? remoteResult.stdout
          .split(/\r?\n/)
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
          .sort()
      : [];

  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = await runner.run(
      root,
      ["rev-list", "--left-right", "--count", `@{upstream}...HEAD`],
      { timeoutMs },
    );
    if (counts.code === 0) {
      const [left, right] = counts.stdout.trim().split(/\s+/);
      behind = Number.parseInt(left ?? "0", 10) || 0;
      ahead = Number.parseInt(right ?? "0", 10) || 0;
    }
  }

  return {
    available: true,
    repo: {
      root,
      gitDir,
      branch,
      head,
      detached: branch === null && head !== null,
      empty: head === null,
      upstream,
      ahead,
      behind,
      remotes,
      identity,
    },
  };
}

/**
 * Which long-running git operation is in progress, if any. Each one leaves a
 * marker inside the git directory: a file for a merge/cherry-pick/revert, a
 * directory for a rebase. `rev-parse --git-path` resolves the marker correctly
 * for a linked worktree too (where it lives outside the main `.git`).
 *
 * Without an injected folder probe the check is skipped rather than guessed:
 * claiming an operation is in progress when it is not would disable the rail.
 */
async function detectOperation(
  runner: GitRunner,
  gitDir: string,
  pathKind: ReadRepoOptions["pathKind"],
  timeoutMs: number,
): Promise<string | null> {
  if (!pathKind) return null;
  const markers: ReadonlyArray<{ name: string; label: string }> = [
    { name: "MERGE_HEAD", label: "a merge" },
    { name: "rebase-merge", label: "a rebase" },
    { name: "rebase-apply", label: "a rebase" },
    { name: "CHERRY_PICK_HEAD", label: "a cherry-pick" },
    { name: "REVERT_HEAD", label: "a revert" },
  ];
  for (const marker of markers) {
    const resolved = await runner.run(
      gitDir,
      ["rev-parse", "--path-format=absolute", "--git-path", marker.name],
      { timeoutMs },
    );
    const target = resolved.code === 0 ? line(resolved.stdout) : null;
    if (!target) continue;
    if ((await pathKind(target)) !== null) return marker.label;
  }
  return null;
}

/**
 * The commit identity, with the config level it came from. `repo` means the
 * commit box may write `.git/config`; `global`/`system` mean the value is the
 * user's own and the box only reports it.
 */
export async function readIdentity(
  runner: GitRunner,
  root: string,
  timeoutMs = GIT_STATUS_TIMEOUT_MS,
): Promise<GitIdentity | null> {
  const [name, email] = await Promise.all([
    runner.run(root, ["config", "--get", "user.name"], { timeoutMs }),
    runner.run(root, ["config", "--get", "user.email"], { timeoutMs }),
  ]);
  if (name.code !== 0 || email.code !== 0) return null;
  const nameValue = line(name.stdout);
  const emailValue = line(email.stdout);
  if (!nameValue || !emailValue) return null;
  return {
    name: nameValue,
    email: emailValue,
    source: await identitySource(runner, root, "user.name", nameValue, timeoutMs),
  };
}

/**
 * Which config file supplied `user.name`. `--show-origin` would be one call, but
 * its output is a `file:/path\tscope` pair whose formatting varies by platform;
 * three cheap `--local`/`--global` probes are easier to reason about and to fake.
 */
async function identitySource(
  runner: GitRunner,
  root: string,
  key: string,
  expected: string,
  timeoutMs: number,
): Promise<GitIdentity["source"]> {
  const scopes: ReadonlyArray<{ flag: string; source: GitIdentity["source"] }> = [
    { flag: "--local", source: "repo" },
    { flag: "--global", source: "global" },
    { flag: "--system", source: "system" },
  ];
  for (const scope of scopes) {
    const result = await runner.run(root, ["config", scope.flag, "--get", key], { timeoutMs });
    if (result.code === 0 && line(result.stdout) === expected) return scope.source;
  }
  return "unknown";
}

/** True when the folder is a repository we can drive (a cheap re-check). */
export async function isRepository(runner: GitRunner, cwd: string): Promise<boolean> {
  const result = await runner.run(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return result.code === 0 && line(result.stdout) === "true";
}

/**
 * Initialises a repository in `cwd`. Only ever called for an explicit user
 * action (the rail's *Initialize repository* button) — never as a side effect.
 */
export async function initRepository(
  runner: GitRunner,
  cwd: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await runner.run(cwd, ["init"], { timeoutMs: 20_000 });
  if (result.missing) return { ok: false, message: "Git is not installed." };
  if (result.code !== 0) {
    return {
      ok: false,
      message: line(result.stderr) ?? `git init exited with code ${result.code}`,
    };
  }
  return { ok: true };
}
