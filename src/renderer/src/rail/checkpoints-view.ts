/**
 * Presentation helpers for the Checkpoints section (git-checkpoint plan step 22).
 *
 * The timeline row has to say four things in 320 px: when, which kind of
 * snapshot, what it was for, and how big it was. The formatting rules live here,
 * with a fixed clock in the tests, so the component itself stays declarative.
 */

import {
  checkpointLabel,
  checkpointLink,
  formatBytes,
  type Checkpoint,
  type CheckpointKind,
  type CheckpointState,
} from "../../../shared/checkpoints";

/**
 * The rail's view of {@link checkpointLink} (plan step 25). Re-exported rather
 * than reimplemented: the rule decides whether conversation rewind is offered,
 * and two copies of it would eventually disagree.
 */
export type CheckpointLinkage = "linked" | "from-before-fork" | "unlinked";

export { canRewindCheckpoint as canRewindConversation } from "../../../shared/checkpoints";

/** The linkage of one checkpoint, given the ids the open transcript knows. */
export function checkpointLinkage(
  checkpoint: Pick<Checkpoint, "kind" | "entryId">,
  entryIds: Readonly<Record<string, true>> | undefined,
): CheckpointLinkage {
  return checkpointLink(checkpoint, entryIds);
}

/** The badge a row shows for its linkage, or null when it needs none. */
export function linkageLabel(linkage: CheckpointLinkage): string | null {
  switch (linkage) {
    case "linked":
      return "This session";
    case "from-before-fork":
      return "Before the fork";
    case "unlinked":
      return null;
  }
}

/** The chip label for a checkpoint's kind. */
export const KIND_LABELS: Record<CheckpointKind, string> = {
  run: "Prompt",
  manual: "Manual",
  "pre-op": "Safety",
  "pre-restore": "Restore",
};

/** The badge tone per kind, so a safety snapshot reads differently from a run. */
export const KIND_TONES: Record<CheckpointKind, "accent" | "neutral" | "warn"> = {
  run: "accent",
  manual: "neutral",
  "pre-op": "warn",
  "pre-restore": "warn",
};

/** `2h ago` — terse on purpose; the exact time is the row's `title`. */
export function checkpointAge(at: number, now: number): string {
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

/** A row's main text: the label, or the kind's default sentence. */
export function checkpointTitle(checkpoint: Checkpoint): string {
  return checkpointLabel(checkpoint);
}

/** `12 files · 4.2 MB`, with a skipped count when the snapshot lost something. */
export function checkpointDetail(checkpoint: Checkpoint): string {
  const parts = [
    checkpoint.files === 1 ? "1 file" : `${checkpoint.files} files`,
    formatBytes(checkpoint.bytes),
  ];
  if (checkpoint.skipped > 0) parts.push(`${checkpoint.skipped} skipped`);
  return parts.join(" · ");
}

/**
 * The usage footer: `1.2 GB of 2 GB · 37 checkpoints`, and how full the budget
 * is (0-1) so the rail can show a bar without recomputing the fraction.
 */
export function usageSummary(state: Pick<CheckpointState, "usage">): {
  text: string;
  fraction: number;
} {
  const { bytes, maxBytes, checkpoints } = state.usage;
  const fraction = maxBytes > 0 ? Math.min(1, bytes / maxBytes) : 0;
  const count = checkpoints === 1 ? "1 checkpoint" : `${checkpoints} checkpoints`;
  return {
    text: `${formatBytes(bytes)} of ${formatBytes(maxBytes)} · ${count}`,
    fraction,
  };
}

/**
 * Why the section is unavailable, as the rail states it (D3: never a silent
 * no-op). Returns null when the surface is usable.
 */
export function unavailableCopy(state: CheckpointState): string | null {
  if (state.available) return null;
  return state.message ?? "Checkpoints are unavailable for this folder.";
}

/** True when the section should offer *Snapshot now*. */
export function canSnapshot(state: CheckpointState): boolean {
  return state.available && state.enabled;
}

/**
 * True when *run* snapshots are not live — a stale host or safe mode. The
 * section says so instead of waiting for a snapshot that will never arrive (R9).
 */
export function runSnapshotsUnavailable(state: CheckpointState): boolean {
  return state.available && !state.runSnapshots;
}
