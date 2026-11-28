/**
 * Browser-safe attachment retention/storage contracts (plan step 13).
 *
 * The windows are policy, not provider guarantees: an incomplete import is
 * discarded after 24 hours, a deleted session keeps its attachment copies for
 * 30 days, and an unowned copy is reclaimed after a 7-day grace period.
 */
export const ATTACHMENT_STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const ATTACHMENT_TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1_000;
export const ATTACHMENT_UNOWNED_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;

export interface AttachmentStorageReport {
  readonly measuredAt: number;
  readonly assets: number;
  readonly originals: number;
  readonly representations: number;
  readonly assetBytes: number;
  readonly staging: number;
  readonly stagingBytes: number;
  readonly tombstones: number;
  readonly tombstonedAssets: number;
  readonly tombstonedBytes: number;
  readonly unowned: number;
  readonly unownedBytes: number;
  readonly pendingRemovals: number;
  readonly removable: number;
  readonly removableBytes: number;
  readonly referenced: number;
  readonly quotaBytes: number;
  readonly usedBytes: number;
  readonly freeBytes: number | null;
}

export interface AttachmentRetentionClearReport {
  readonly clearedAt: number;
  readonly paused: "manifest" | "journal" | null;
  readonly assetsRemoved: number;
  readonly staleStagingRemoved: number;
  readonly bytesFreed: number;
  readonly errors: number;
}
