/**
 * Pure view helpers for the Git section (git-checkpoint plan step 13).
 *
 * The section has to answer three questions the raw snapshot does not: *what do
 * I call this state*, *which remote would a sync talk to*, and *which of
 * fetch/pull/push is actually possible*. Those are decided here so the component
 * stays layout and the wording is testable.
 */

import type { GitRepoInfo, GitSnapshot, GitStashEntry } from "../../../shared/git";

/** What the branch line says, and the numbers beside it. */
export interface BranchView {
  label: string;
  detached: boolean;
  empty: boolean;
  ahead: number;
  behind: number;
  /** The remote tracking branch, when there is one. */
  upstream: string | null;
  remotes: string[];
}

/** The branch line's text, in priority order: empty, detached, named. */
function branchLabel(repo: GitRepoInfo): string {
  if (repo.empty) {
    return repo.branch ? `${repo.branch} (no commits yet)` : "no commits yet";
  }
  if (repo.detached) {
    return repo.head ? `detached at ${repo.head.slice(0, 7)}` : "detached";
  }
  return repo.branch ?? "unknown branch";
}

export function branchView(repo: GitRepoInfo | undefined): BranchView | null {
  if (!repo) return null;
  return {
    label: branchLabel(repo),
    detached: repo.detached,
    empty: repo.empty,
    ahead: repo.ahead,
    behind: repo.behind,
    upstream: repo.upstream,
    remotes: repo.remotes,
  };
}

/**
 * The ref a sync button would act on: the configured upstream, or the first
 * remote plus the branch when the branch does not track anything yet. Null when
 * there is nothing sensible to name, which is also when the buttons are hidden.
 */
export function syncTarget(repo: GitRepoInfo | undefined): string | null {
  if (!repo) return null;
  if (repo.upstream) return repo.upstream;
  const remote = repo.remotes[0];
  if (!remote || !repo.branch) return null;
  return `${remote}/${repo.branch}`;
}

export interface SyncAvailability {
  /** Always available when a remote exists: fetch does not need a branch. */
  fetch: boolean;
  /** Pulling needs an upstream to pull from. */
  pull: boolean;
  /** Pushing needs a branch to push (and a remote to push to). */
  push: boolean;
  /** Why the actions are unavailable, when they all are. */
  reason: string | null;
}

export function syncAvailability(repo: GitRepoInfo | undefined): SyncAvailability {
  if (!repo) {
    return { fetch: false, pull: false, push: false, reason: "No repository." };
  }
  const remote = repo.remotes[0];
  if (!remote) {
    return {
      fetch: false,
      pull: false,
      push: false,
      reason: "No remote is configured. Add one with git remote add.",
    };
  }
  if (repo.detached) {
    return {
      fetch: true,
      pull: false,
      push: false,
      reason: "HEAD is detached: check out a branch to pull or push.",
    };
  }
  return {
    fetch: true,
    pull: repo.upstream !== null,
    push: repo.branch !== null,
    reason: repo.upstream ? null : `No upstream yet: the first push sets ${remote}/${repo.branch}.`,
  };
}

/** One stash's line: its message, or git's default text. */
export function stashLabel(stash: GitStashEntry): string {
  const subject = stash.subject.replace(/^WIP on /, "WIP on ").trim();
  return subject.length > 0 ? subject : `stash@{${stash.index}}`;
}

/** True when switching branches could lose work and must be confirmed. */
export function needsDirtyConfirmation(snapshot: GitSnapshot | undefined): boolean {
  if (!snapshot?.available) return false;
  return snapshot.changed.length > 0 || snapshot.staged.length > 0;
}
