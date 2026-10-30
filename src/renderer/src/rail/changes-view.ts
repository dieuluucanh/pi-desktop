/**
 * Pure view helpers for the Changes section (git-checkpoint plan step 11).
 *
 * Kept out of `ChangesSection.tsx` so the decisions that matter — what the two
 * groups are, what a destructive action says, what an unavailable repository
 * offers — are unit-testable without a DOM, and so the component reads as
 * layout.
 */

import type { GitFileEntry, GitSnapshot, GitUnavailableReason } from "../../../shared/git";

/** The two lists, plus the group-level actions they allow. */
export interface ChangesGroups {
  staged: GitFileEntry[];
  changed: GitFileEntry[];
  stagedCount: number;
  changedCount: number;
  /** True when there is at least one file to stage (the working tree). */
  canStageAll: boolean;
  /** True when there is at least one file to unstage (the index). */
  canUnstageAll: boolean;
  /** True when the repository is available and nothing is modified. */
  clean: boolean;
  /** True when the snapshot was capped and the lists are partial. */
  truncated: boolean;
}

/** Derives the two groups from a snapshot (or an absent one). */
export function groupsOf(snapshot: GitSnapshot | undefined): ChangesGroups {
  const staged = snapshot?.staged ?? [];
  const changed = snapshot?.changed ?? [];
  return {
    staged,
    changed,
    stagedCount: staged.length,
    changedCount: changed.length,
    canStageAll: changed.length > 0,
    canUnstageAll: staged.length > 0,
    clean: (snapshot?.available ?? false) && staged.length === 0 && changed.length === 0,
    truncated: snapshot?.truncated ?? false,
  };
}

/** True when the file is a path git does not track yet. */
export function isUntracked(file: GitFileEntry): boolean {
  return file.status === "untracked";
}

/**
 * The label for a rename/copy, so the row shows both names (`old → new`).
 * Null for every other status.
 */
export function renameLabel(file: GitFileEntry): string | null {
  if (!file.origPath) return null;
  return `${file.origPath} → ${file.path}`;
}

/** What a discard of this file actually does, in the user's words. */
export interface DiscardPrompt {
  title: string;
  description: string;
  confirmLabel: string;
}

/**
 * The confirmation copy for a discard. An untracked file is **moved to the OS
 * trash** rather than deleted (the plan's D11), and the copy says so, because
 * "discard" on an untracked file is otherwise a euphemism for "delete".
 */
export function discardPrompt(file: GitFileEntry): DiscardPrompt {
  const untracked = isUntracked(file);
  return {
    title: untracked ? `Move ${file.path} to the trash?` : `Discard changes in ${file.path}?`,
    description: untracked
      ? "This file is not tracked by git, so discarding it means removing it from the folder. It goes to the system trash and can be restored from there."
      : "The changes since the last commit will be lost. The file returns to the version in the last commit.",
    confirmLabel: untracked ? "Move to trash" : "Discard changes",
  };
}

/** An empty state a folder can be in, with the action that gets out of it. */
export interface ChangesEmptyState {
  title: string;
  body: string;
  /** The one action offered, when one is actionable here. */
  action: "init" | "install" | null;
}

/** The copy for a repository git cannot serve (a clean tree says nothing). */
export function emptyStateFor(
  snapshot: GitSnapshot | undefined,
  reason: GitUnavailableReason | undefined,
): ChangesEmptyState | null {
  if (snapshot?.available) {
    // A clean tree needs no paragraph (2026-10-30 project-scoped rail plan): the
    // header's count is already 0, and "The working tree matches the last commit"
    // spent two rows saying what an empty list says. Unavailable states keep
    // their copy because each one carries an action.
    return null;
  }
  switch (reason) {
    case "git_missing":
      return {
        title: "Git is not installed",
        body: "Source control needs the git executable on PATH. Install Git, restart the app, and reopen this panel.",
        action: null,
      };
    case "not_a_repo":
      return {
        title: "Not a git repository",
        body: "This folder has no repository. Initialize one to track changes here — checkpoints work without it.",
        action: "init",
      };
    case "bare_repo":
      return {
        title: "Bare repository",
        body: "This folder is a bare repository, so it has no working tree to show changes for.",
        action: null,
      };
    case "no_folder":
      return {
        title: "Folder not found",
        body: "The project folder no longer exists on disk.",
        action: null,
      };
    case "operation_in_progress":
      return {
        title: "Git is busy",
        body:
          snapshot?.message ??
          "A merge, rebase or cherry-pick is in progress. Finish it in a terminal first.",
        action: null,
      };
    default:
      return {
        title: "Source control unavailable",
        body: snapshot?.message ?? "The repository could not be read.",
        action: null,
      };
  }
}
