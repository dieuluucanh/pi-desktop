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
 * exact timestamp is in the row's hover card.
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
 * Every branch/tag name `%D` reported, minus symbolic remote-HEAD aliases
 * (`origin/HEAD`). Uncapped: the hover card lists them all (`parseRefs` already
 * bounds `%D` at 12).
 */
export function commitRefs(entry: GitCommitEntry): string[] {
  return entry.refs.filter((ref) => !/\/HEAD$/.test(ref));
}

/** A ref is remote only when a configured remote names it or prefixes it. */
function isRemoteRef(ref: string, remotes: readonly string[]): boolean {
  return remoteLeaf(ref, remotes) !== null;
}

/** The branch leaf after a remote name (`origin/main` → `main`), or null. */
function remoteLeaf(ref: string, remotes: readonly string[]): string | null {
  for (const remote of remotes) {
    if (ref === remote) return ref;
    if (ref.startsWith(`${remote}/`)) return ref.slice(remote.length + 1);
  }
  return null;
}

/** The tones a commit chip can carry, matching the Badge primitive. */
export type CommitChipTone = "accent" | "info" | "neutral";

/**
 * How a chip is coloured: the current branch keeps the accent, a
 * remote-tracking ref (`origin/main`) gets the info tone, and anything else —
 * a tag or another local branch — stays neutral.
 *
 * A chip is a remote ref only when it is one of the repository's remotes or
 * starts with `<remote>/`. Splitting on the first slash would mislabel a tag
 * such as `release/v1`, which is why the remote list is consulted instead.
 */
export function commitChipTone(
  chip: string,
  branch: string | null | undefined,
  remotes: readonly string[],
): CommitChipTone {
  if (branch && chip === branch) return "accent";
  if (isRemoteRef(chip, remotes)) return "info";
  return "neutral";
}

/**
 * A one-line row chip after folding a local branch and its remote-tracking refs.
 * `main` + `origin/main` is one `local:main` chip carrying the remote; a
 * remote-only ref is a `remote:main` chip. The card still shows the raw refs.
 */
export interface CommitRowChip {
  /** React key: `local:main` / `remote:main`. */
  key: string;
  /** The branch leaf or tag name shown in the chip. */
  label: string;
  /** Remote-tracking refs folded into this chip (`origin/main`, `upstream/main`). */
  remotes: string[];
  /** True when a local ref with this label is decorated on the commit. */
  local: boolean;
  tone: CommitChipTone;
}

/** How many chips the one-line row shows before a `+N` marker. */
export const COMMIT_ROW_CHIP_LIMIT = 2;

/**
 * Folds a commit's decorations into the chips the one-line row can afford. The
 * current branch leads; other refs keep git's order; `hidden` counts the chips
 * the card still carries in full.
 */
export function commitRowChips(
  entry: GitCommitEntry,
  branch: string | null | undefined,
  remotes: readonly string[],
): { chips: CommitRowChip[]; hidden: number } {
  const refs = [...new Set(commitRefs(entry))];
  const remotesByLeaf = new Map<string, string[]>();
  const localLabels = new Set<string>();

  for (const ref of refs) {
    const leaf = remoteLeaf(ref, remotes);
    if (leaf === null) {
      localLabels.add(ref);
      continue;
    }
    const group = remotesByLeaf.get(leaf);
    if (group) group.push(ref);
    else remotesByLeaf.set(leaf, [ref]);
  }

  const chips: CommitRowChip[] = [];
  const emittedRemotes = new Set<string>();
  for (const ref of refs) {
    const leaf = remoteLeaf(ref, remotes);
    if (leaf === null) {
      chips.push({
        key: `local:${ref}`,
        label: ref,
        remotes: remotesByLeaf.get(ref) ?? [],
        local: true,
        tone: branch && ref === branch ? "accent" : "neutral",
      });
      continue;
    }
    // A local ref with the same leaf already carries this remote group.
    if (localLabels.has(leaf) || emittedRemotes.has(leaf)) continue;
    emittedRemotes.add(leaf);
    chips.push({
      key: `remote:${leaf}`,
      label: leaf,
      remotes: remotesByLeaf.get(leaf) ?? [ref],
      local: false,
      tone: "info",
    });
  }

  const current = chips.findIndex((chip) => chip.local && chip.label === branch);
  if (current > 0) {
    const [chip] = chips.splice(current, 1);
    if (chip) chips.unshift(chip);
  }

  const hidden = Math.max(0, chips.length - COMMIT_ROW_CHIP_LIMIT);
  return { chips: chips.slice(0, COMMIT_ROW_CHIP_LIMIT), hidden };
}

/**
 * The full message the card selects and copies: subject, a blank line, then the
 * body when there is one. Both parts are trimmed; `""` when neither exists.
 */
export function fullCommitMessage(entry: GitCommitEntry): string {
  const subject = entry.subject.trim();
  const body = entry.body.trim();
  if (subject.length === 0) return body;
  return body.length === 0 ? subject : `${subject}\n\n${body}`;
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

/** The exact time for the hover card, in the user's locale. */
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
