/**
 * Pure decisions for the commit box (git-checkpoint plan step 12).
 *
 * The box has three things to say before it lets a user commit — *is anything
 * staged*, *is the message usable*, *does the repository know who you are* — and
 * a fourth after a failure. Keeping them here means the wording is testable and
 * the component stays layout.
 */

import { MAX_COMMIT_MESSAGE, type GitIdentity, type GitSnapshot } from "../../../shared/git";

/** Why the commit button is disabled, or null when it is not. */
export interface CommitReadiness {
  canCommit: boolean;
  /** The one thing standing in the way, when there is one. */
  reason: string | null;
}

/**
 * Whether the box can commit right now. Order matters: an empty index is a
 * different problem from an empty message, and telling a user to write a message
 * when nothing is staged would waste their time.
 */
export function commitReadiness(
  snapshot: GitSnapshot | undefined,
  message: string,
  identity: GitIdentity | null | undefined,
): CommitReadiness {
  if (!snapshot?.available) {
    return { canCommit: false, reason: null };
  }
  if (snapshot.staged.length === 0 && snapshot.changed.length === 0) {
    return { canCommit: false, reason: "No changes to commit." };
  }
  if (!identity) {
    return { canCommit: false, reason: "Tell git who you are." };
  }
  if (message.trim().length === 0) {
    return { canCommit: false, reason: "Write a commit message." };
  }
  return { canCommit: true, reason: null };
}

/** The identity line, with the config level it came from. */
export interface IdentitySummary {
  /** `Ada Lovelace <ada@example.com>` */
  label: string;
  /** `this repo`, `global`, `system` or `unknown`. */
  sourceLabel: string;
  /** True when this repository's own config supplied it. */
  local: boolean;
}

export function identitySummary(identity: GitIdentity): IdentitySummary {
  return {
    label: `${identity.name} <${identity.email}>`,
    sourceLabel: identitySourceLabel(identity.source),
    local: identity.source === "repo",
  };
}

export function identitySourceLabel(source: GitIdentity["source"]): string {
  switch (source) {
    case "repo":
      return "this repo";
    case "global":
      return "global";
    case "system":
      return "system";
    default:
      return "unknown";
  }
}

/** `3 / 20000`, and whether the message is at the platform's limit. */
export function messageCount(message: string): { text: string; over: boolean } {
  const length = message.length;
  return {
    text: `${length} / ${MAX_COMMIT_MESSAGE}`,
    over: length > MAX_COMMIT_MESSAGE,
  };
}

/**
 * The label for the one-click action, which is either a plain commit (something
 * is staged) or a stage-everything-and-commit (nothing is).
 */
export function primaryActionLabel(snapshot: GitSnapshot | undefined, amend: boolean): string {
  const hasStaged = (snapshot?.staged.length ?? 0) > 0;
  const hasChanges = (snapshot?.changed.length ?? 0) > 0;
  if (amend) return "Amend commit";
  if (hasStaged) return "Commit";
  if (hasChanges) return "Stage all and commit";
  return "Commit";
}

/**
 * What to tell the user when they press Commit and it cannot go through.
 *
 * The box no longer prints this before the attempt (2026-10-30 plan): a line that
 * says "Write a commit message" while the user is still typing was pure noise in
 * a 320 px column. It is raised as a notification instead, at the moment the
 * missing thing actually blocks something, and it names the fix rather than the
 * rule.
 */
export function commitBlockedNotice(
  snapshot: GitSnapshot | undefined,
  message: string,
  identity: GitIdentity | null | undefined,
): string | null {
  if (!snapshot?.available) return null;
  if (snapshot.staged.length === 0 && snapshot.changed.length === 0) {
    return "No changes to commit — stage something first.";
  }
  if (!identity) {
    return "Tell git who you are: Commit options (⋯) → Set identity.";
  }
  if (message.trim().length === 0) return "Write a commit message first.";
  if (message.length > MAX_COMMIT_MESSAGE) {
    return "The commit message is longer than the limit; shorten it to commit.";
  }
  return null;
}
