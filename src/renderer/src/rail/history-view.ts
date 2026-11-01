/**
 * Pure helpers for the History section (git-checkpoint plan step 15).
 *
 * The log needs two pieces of presentation the wire model does not carry: a
 * human relative time (git gives epoch seconds) and the ref chips a commit
 * carries (branch/tag decorations). Both live here so they are testable with a
 * fixed clock instead of the wall clock.
 */

import type { GitCommitEntry, GitRepoInfo } from "../../../shared/git";

/**
 * A compact relative time: `just now`, `5m ago`, `3h ago`, `2d ago`, `3w ago`,
 * `4mo ago`, `2y ago`. Deliberately terse — the rail is 320 px wide and the
 * exact timestamp is in the row's `title`.
 */
export function relativeTime(at: number, now: number): string {
  if (!Number.isFinite(at) || at <= 0) return "unknown";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

/**
 * The chips a commit row shows: the branch/tag names `%D` reported. The upstream
 * is already among them on the commit it points at — inventing it for HEAD would
 * label an unpushed commit as `origin/main`. `origin/HEAD` is a symbolic alias,
 * not a branch the user acts on, so it is dropped.
 */
export function commitChips(entry: GitCommitEntry): string[] {
  return entry.refs.filter((ref) => !/\/HEAD$/.test(ref)).slice(0, 4);
}

/**
 * The repo facts a History page depends on. A change in any of them can move a
 * decoration (`origin/main`), the branch tip or the paging offsets, so the page
 * is re-read. `fetchedAt` and the stash list are deliberately absent: neither
 * changes what the log says.
 */
export function historyKey(repo: GitRepoInfo | undefined): string | null {
  if (!repo) return null;
  return [repo.branch ?? "", repo.head ?? "", repo.upstream ?? "", repo.ahead, repo.behind].join(
    "|",
  );
}

/** The exact time for a row's `title`, in the user's locale. */
export function absoluteTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return "unknown";
  return new Date(at).toLocaleString();
}

/** True when the log has more pages to fetch. */
export function hasMoreCommits(
  page: { entries: unknown[]; hasMore: boolean } | undefined,
): boolean {
  return page?.hasMore === true;
}
