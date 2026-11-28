import type { AttachmentStore } from "../attachments/store";
import { ATTACHMENT_LIMITS } from "../shared/attachments";
import {
  ATTACHMENT_STAGING_MAX_AGE_MS,
  ATTACHMENT_TOMBSTONE_MS,
  ATTACHMENT_UNOWNED_GRACE_MS,
  type AttachmentRetentionClearReport,
  type AttachmentStorageReport,
} from "../shared/attachment-storage";
import type {
  AttachmentSubmissionJournal,
  AttachmentSubmissionJournalEntry,
} from "./attachment-submission-journal";
import {
  attachmentBranchOwner,
  attachmentSessionOwner,
  type AttachmentOwnershipReconciler,
} from "./attachment-ownership";

/**
 * Attachment retention, recovery and storage reporting (plan step 13).
 *
 * Policy (all windows measured from an injected clock):
 *  - incomplete imports are cancelled after 24 hours;
 *  - a deleted durable owner leaves a 30-day tombstone, during which its assets
 *    may be restored by reopening/adopting the exact session;
 *  - an unowned asset is deleted after 7 days unless an unexpired tombstone
 *    covers it.
 *
 * Deletion is always conservative: referenced assets are never evicted, a
 * corrupt manifest or journal pauses the whole sweep, and a failed object
 * removal stays in the store's bounded pending list for the next pass. The
 * sweep is idempotent and can be interrupted at any boundary.
 */

export {
  ATTACHMENT_STAGING_MAX_AGE_MS,
  ATTACHMENT_TOMBSTONE_MS,
  ATTACHMENT_UNOWNED_GRACE_MS,
  type AttachmentRetentionClearReport,
  type AttachmentStorageReport,
} from "../shared/attachment-storage";

export type AttachmentRetentionIncident =
  | "manifest_unreadable"
  | "journal_unreadable"
  | "ownership_incomplete"
  | "staging_cleanup_failed"
  | "asset_cleanup_failed"
  | "object_cleanup_failed";

export interface AttachmentRetentionSweepReport {
  readonly sweptAt: number;
  /** A corrupt/unreadable input pauses every destructive step. */
  readonly paused: "manifest" | "journal" | null;
  readonly promoted: number;
  readonly promotionIncomplete: number;
  readonly objectRemovalsRetried: number;
  readonly staleStagingRemoved: number;
  readonly expiredTombstones: number;
  readonly assetsRemoved: number;
  readonly errors: number;
}

export interface AttachmentRetentionDeps {
  readonly profileKey: string;
  readonly store: Pick<
    AttachmentStore,
    | "inventory"
    | "cancel"
    | "clearTombstone"
    | "removeAsset"
    | "retireOwners"
    | "retryObjectRemovals"
  >;
  readonly journal: Pick<AttachmentSubmissionJournal, "list">;
  readonly ownership: Pick<AttachmentOwnershipReconciler, "reconcile">;
  now(): number;
  /** Bounded incident hook; never receives names, paths or content. */
  readonly report?: (incident: AttachmentRetentionIncident) => void;
}

export interface AttachmentRetention {
  sweep(): Promise<AttachmentRetentionSweepReport>;
  /** Retire every durable owner of one deleted session (session + branches). */
  retireSession(sessionId: string): Promise<{ assets: number; tombstones: number }>;
  /** Restore a session tombstone (for example after reopening the session). */
  restoreSession(sessionId: string): Promise<number>;
  report(): Promise<AttachmentStorageReport | null>;
  /** Explicit user action: delete unreferenced, unprotected assets now. */
  clear(): Promise<AttachmentRetentionClearReport>;
}

function safeNow(now: () => number): number | null {
  const value = now();
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function protectedIds(
  tombstones: readonly { readonly assetIds: readonly string[]; readonly expiresAt: number }[],
  now: number,
): Set<string> {
  const protectedAssets = new Set<string>();
  for (const tombstone of tombstones) {
    if (tombstone.expiresAt <= now) continue;
    for (const id of tombstone.assetIds) protectedAssets.add(id);
  }
  return protectedAssets;
}

function removableAssets(
  inventory: Awaited<ReturnType<AttachmentStore["inventory"]>>,
  now: number,
  graceMs: number,
): { readonly remove: readonly string[]; readonly removableBytes: number } {
  const protectedAssets = protectedIds(inventory.tombstones, now);
  const byId = new Map(inventory.assets.map((asset) => [asset.id, asset]));
  const eligible = new Set<string>();
  let removableBytes = 0;
  for (const asset of inventory.assets) {
    if (asset.owners.length !== 0 || asset.unownedAt === null) continue;
    if (now - asset.unownedAt < graceMs) continue;
    if (protectedAssets.has(asset.id)) continue;
    eligible.add(asset.id);
    removableBytes += asset.size;
  }
  // Representations go first so their originals stop being referenced.
  const ordered = [...eligible].sort((left, right) => {
    const leftKind = byId.get(left)?.kind === "original" ? 1 : 0;
    const rightKind = byId.get(right)?.kind === "original" ? 1 : 0;
    return leftKind - rightKind;
  });
  return { remove: ordered, removableBytes };
}

function summarize(
  inventory: Awaited<ReturnType<AttachmentStore["inventory"]>>,
  now: number,
): AttachmentStorageReport {
  const tombstoned = protectedIds(inventory.tombstones, now);
  let assetBytes = 0;
  let tombstonedBytes = 0;
  let unownedBytes = 0;
  let originals = 0;
  for (const asset of inventory.assets) {
    assetBytes += asset.size;
    if (asset.kind === "original") originals++;
    if (tombstoned.has(asset.id)) tombstonedBytes += asset.size;
    if (asset.owners.length === 0) unownedBytes += asset.size;
  }
  const candidates = removableAssets(inventory, now, ATTACHMENT_UNOWNED_GRACE_MS);
  const removable = candidates.remove.length;
  const removableBytes = candidates.removableBytes;
  const stagingBytes = inventory.staging.reduce((total, stage) => total + stage.size, 0);
  return {
    measuredAt: now,
    assets: inventory.assets.length,
    originals,
    representations: inventory.assets.length - originals,
    assetBytes,
    staging: inventory.staging.length,
    stagingBytes,
    tombstones: inventory.tombstones.length,
    tombstonedAssets: tombstoned.size,
    tombstonedBytes,
    unowned: inventory.assets.filter((asset) => asset.owners.length === 0).length,
    unownedBytes,
    pendingRemovals: inventory.pendingRemovals.length,
    removable,
    removableBytes,
    referenced:
      inventory.assets.length -
      inventory.assets.filter((asset) => asset.owners.length === 0).length,
    quotaBytes: ATTACHMENT_LIMITS.localStoreBytes,
    usedBytes: assetBytes + stagingBytes,
    freeBytes: inventory.freeBytes,
  };
}

export function createAttachmentRetention(deps: AttachmentRetentionDeps): AttachmentRetention {
  const report = deps.report ?? (() => undefined);

  const sweep = async (): Promise<AttachmentRetentionSweepReport> => {
    const timestamp = safeNow(deps.now);
    const base = {
      sweptAt: timestamp ?? 0,
      promoted: 0,
      promotionIncomplete: 0,
      objectRemovalsRetried: 0,
      staleStagingRemoved: 0,
      expiredTombstones: 0,
      assetsRemoved: 0,
      errors: 0,
    };
    if (timestamp === null) return { ...base, paused: "manifest" };

    // Rebuild durable ownership first, and pause entirely when the journal is
    // unreadable: a corrupt journal may still describe a pending attempt.
    let entries: readonly AttachmentSubmissionJournalEntry[];
    try {
      entries = await deps.journal.list();
    } catch {
      report("journal_unreadable");
      return { ...base, paused: "journal" };
    }
    let promoted = 0;
    let promotionIncomplete: number;
    try {
      const result = await deps.ownership.reconcile(entries);
      promoted = result.promoted;
      promotionIncomplete = result.incomplete;
      if (result.incomplete > 0) report("ownership_incomplete");
    } catch {
      report("ownership_incomplete");
      promotionIncomplete = 1;
    }

    // Read the manifest before any destructive step: a corrupt/unsafe storage
    // tree pauses the sweep instead of turning unreadable state into "unowned".
    let inventory: Awaited<ReturnType<AttachmentStore["inventory"]>>;
    try {
      inventory = await deps.store.inventory();
    } catch {
      report("manifest_unreadable");
      return {
        ...base,
        paused: "manifest",
        promoted,
        promotionIncomplete,
      };
    }

    let objectRemovalsRetried = 0;
    try {
      objectRemovalsRetried = await deps.store.retryObjectRemovals();
    } catch {
      report("object_cleanup_failed");
    }

    const staleStaging = inventory.staging.filter(
      (stage) => timestamp - stage.createdAt >= ATTACHMENT_STAGING_MAX_AGE_MS,
    );
    let removedStaging = 0;
    for (const stage of staleStaging) {
      try {
        await deps.store.cancel(stage.id, stage.owner);
        removedStaging++;
      } catch {
        report("staging_cleanup_failed");
      }
    }

    const expired = inventory.tombstones.filter((tombstone) => tombstone.expiresAt <= timestamp);
    let expiredTombstones = 0;
    for (const tombstone of expired) {
      try {
        expiredTombstones += await deps.store.clearTombstone(tombstone.owner);
      } catch {
        report("asset_cleanup_failed");
      }
    }

    const remainingTombstones = inventory.tombstones.filter(
      (tombstone) => tombstone.expiresAt > timestamp,
    );
    const candidates = removableAssets(
      { ...inventory, tombstones: remainingTombstones },
      timestamp,
      ATTACHMENT_UNOWNED_GRACE_MS,
    );
    let assetsRemoved = 0;
    let errors = 0;
    for (const id of candidates.remove) {
      try {
        await deps.store.removeAsset(id);
        assetsRemoved++;
      } catch {
        // A surviving reference (or a failed object removal) is retried later.
        errors++;
        report("asset_cleanup_failed");
      }
    }

    return {
      sweptAt: timestamp,
      paused: null,
      promoted,
      promotionIncomplete,
      objectRemovalsRetried,
      staleStagingRemoved: removedStaging,
      expiredTombstones,
      assetsRemoved,
      errors,
    };
  };

  return {
    sweep,
    async retireSession(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 512) {
        return { assets: 0, tombstones: 0 };
      }
      const owners = [attachmentSessionOwner(deps.profileKey, sessionId)];
      try {
        const entries = await deps.journal.list();
        const branches = new Set(
          entries
            .filter(
              (entry) =>
                entry.scope.profileKey === deps.profileKey &&
                entry.scope.sessionId === sessionId &&
                entry.scope.branchId !== null,
            )
            .map((entry) => entry.scope.branchId as string),
        );
        for (const branchId of branches) {
          owners.push(attachmentBranchOwner(deps.profileKey, sessionId, branchId));
        }
      } catch {
        report("journal_unreadable");
      }
      // Errors propagate: deleting the session must abort rather than leave
      // assets with a live owner and no recovery window.
      return await deps.store.retireOwners(owners, ATTACHMENT_TOMBSTONE_MS);
    },
    async restoreSession(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return 0;
      const owner = attachmentSessionOwner(deps.profileKey, sessionId);
      try {
        return await deps.store.clearTombstone(owner);
      } catch {
        return 0;
      }
    },
    async report() {
      const timestamp = safeNow(deps.now);
      if (timestamp === null) return null;
      try {
        return summarize(await deps.store.inventory(), timestamp);
      } catch {
        report("manifest_unreadable");
        return null;
      }
    },
    async clear() {
      const timestamp = safeNow(deps.now);
      if (timestamp === null) {
        return {
          clearedAt: 0,
          paused: "manifest",
          assetsRemoved: 0,
          staleStagingRemoved: 0,
          bytesFreed: 0,
          errors: 0,
        };
      }
      try {
        await deps.journal.list();
      } catch {
        report("journal_unreadable");
        return {
          clearedAt: timestamp,
          paused: "journal",
          assetsRemoved: 0,
          staleStagingRemoved: 0,
          bytesFreed: 0,
          errors: 0,
        };
      }
      let inventory: Awaited<ReturnType<AttachmentStore["inventory"]>>;
      try {
        inventory = await deps.store.inventory();
      } catch {
        report("manifest_unreadable");
        return {
          clearedAt: timestamp,
          paused: "manifest",
          assetsRemoved: 0,
          staleStagingRemoved: 0,
          bytesFreed: 0,
          errors: 0,
        };
      }
      let bytesFreed = 0;
      let errors = 0;
      let staleStagingRemoved = 0;
      const now = timestamp;
      for (const stage of inventory.staging) {
        if (now - stage.createdAt < ATTACHMENT_STAGING_MAX_AGE_MS) continue;
        try {
          await deps.store.cancel(stage.id, stage.owner);
          staleStagingRemoved++;
          bytesFreed += stage.size;
        } catch {
          errors++;
        }
      }
      // An explicit clear may bypass the 7-day unowned grace, but never an
      // unexpired tombstone and never an owned/referenced asset.
      const candidates = removableAssets(inventory, now, 0);
      let assetsRemoved = 0;
      for (const id of candidates.remove) {
        const asset = inventory.assets.find((item) => item.id === id);
        try {
          await deps.store.removeAsset(id);
          assetsRemoved++;
          bytesFreed += asset?.size ?? 0;
        } catch {
          errors++;
          report("asset_cleanup_failed");
        }
      }
      return {
        clearedAt: timestamp,
        paused: null,
        assetsRemoved,
        staleStagingRemoved,
        bytesFreed,
        errors,
      };
    },
  };
}
