import { describe, expect, it, vi } from "vitest";
import type { AssetOwner, AttachmentInventory } from "../../src/attachments/store";
import {
  ATTACHMENT_STAGING_MAX_AGE_MS,
  ATTACHMENT_TOMBSTONE_MS,
  ATTACHMENT_UNOWNED_GRACE_MS,
  createAttachmentRetention,
} from "../../src/main/attachment-retention";
import {
  attachmentSessionOwner,
  type AttachmentOwnershipReconciler,
} from "../../src/main/attachment-ownership";

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const profileKey = "a".repeat(64);
const id = (n: number): string =>
  `123e4567-e89b-42d3-a456-${String(426614174000 + n).padStart(12, "0")}`;

const DRAFT: AssetOwner = { kind: "draft", id: id(1) };

interface FakeAsset {
  id: string;
  kind: "original" | "representation";
  size: number;
  sha256: string;
  owners: AssetOwner[];
  unownedAt: number | null;
  originalId: string | null;
}

function harness(options: { now?: number; journalThrows?: boolean } = {}) {
  const state = {
    now: options.now ?? 1_000 * DAY,
    assets: [] as FakeAsset[],
    staging: [] as Array<{
      id: string;
      kind: "original" | "representation";
      size: number;
      createdAt: number;
      owner: AssetOwner;
    }>,
    tombstones: [] as Array<{
      owner: AssetOwner;
      deletedAt: number;
      expiresAt: number;
      assetIds: string[];
    }>,
    pendingRemovals: [] as string[],
    removed: [] as string[],
    cancelled: [] as string[],
    retireCalls: [] as Array<{ owners: AssetOwner[]; retentionMs: number }>,
    removeAsset: vi.fn(async (assetId: string) => {
      const asset = state.assets.find((item) => item.id === assetId);
      if (!asset) throw new Error("not found");
      if (asset.owners.length > 0) throw new Error("still owned");
      if (asset.kind === "original" && state.assets.some((item) => item.originalId === assetId)) {
        throw new Error("dependent representation");
      }
      state.assets = state.assets.filter((item) => item.id !== assetId);
      state.removed.push(assetId);
    }),
    ownership: {
      reconcile: vi.fn(async () => ({ promoted: 0, incomplete: 0 })),
    } as unknown as AttachmentOwnershipReconciler,
    journal: {
      list: vi.fn(async (): Promise<unknown[]> => {
        if (options.journalThrows) throw new Error("journal corrupt");
        return [];
      }),
    },
  };

  const inventory = async (): Promise<AttachmentInventory> => {
    if (state.assets.some((asset) => asset.id === "corrupt")) {
      throw Object.assign(new Error("corrupt"), { code: "corrupt_manifest" });
    }
    return {
      assets: state.assets.map((asset) => ({
        ...asset,
        name: "file.txt",
        mimeType: "text/plain",
        createdAt: 1,
        classification: undefined,
      })) as unknown as AttachmentInventory["assets"],
      staging: state.staging.map((stage) => ({ ...stage })),
      tombstones: state.tombstones.map((tombstone) => ({
        ...tombstone,
        assetIds: [...tombstone.assetIds],
      })),
      pendingRemovals: [...state.pendingRemovals],
      freeBytes: 123,
    };
  };

  const store = {
    inventory: vi.fn(inventory),
    cancel: vi.fn(async (stageId: string, owner: AssetOwner) => {
      const stage = state.staging.find(
        (item) =>
          item.id === stageId && item.owner.kind === owner.kind && item.owner.id === owner.id,
      );
      if (!stage) throw new Error("not found");
      state.staging = state.staging.filter((item) => item !== stage);
      state.cancelled.push(stageId);
    }),
    clearTombstone: vi.fn(async (owner: AssetOwner) => {
      const before = state.tombstones.length;
      state.tombstones = state.tombstones.filter(
        (item) => item.owner.kind !== owner.kind || item.owner.id !== owner.id,
      );
      return before - state.tombstones.length;
    }),
    retireOwners: vi.fn(async (owners: AssetOwner[], retentionMs: number) => {
      state.retireCalls.push({ owners: owners.map((owner) => ({ ...owner })), retentionMs });
      const unique = owners.filter(
        (owner, index) =>
          owners.findIndex(
            (candidate) => candidate.kind === owner.kind && candidate.id === owner.id,
          ) === index,
      );
      const assetIds = new Set<string>();
      for (const owner of unique) {
        for (const asset of state.assets) {
          if (asset.owners.some((entry) => entry.kind === owner.kind && entry.id === owner.id)) {
            assetIds.add(asset.id);
          }
        }
      }
      for (const owner of unique) {
        state.tombstones = state.tombstones.filter(
          (item) => item.owner.kind !== owner.kind || item.owner.id !== owner.id,
        );
        state.tombstones.push({
          owner: { ...owner },
          deletedAt: state.now,
          expiresAt: state.now + retentionMs,
          assetIds: [...assetIds],
        });
      }
      state.assets = state.assets.map((asset) => {
        const remaining = asset.owners.filter(
          (owner) =>
            !unique.some((candidate) => candidate.kind === owner.kind && candidate.id === owner.id),
        );
        return {
          ...asset,
          owners: remaining,
          unownedAt: remaining.length === 0 ? state.now : null,
        };
      });
      return { assets: assetIds.size, tombstones: unique.length };
    }),
    removeAsset: state.removeAsset,
    retryObjectRemovals: vi.fn(async () => {
      const count = state.pendingRemovals.length;
      state.pendingRemovals = [];
      return count;
    }),
  };

  const retention = createAttachmentRetention({
    profileKey,
    store: store as never,
    journal: state.journal as never,
    ownership: state.ownership,
    now: () => state.now,
  });

  const add = (
    n: number,
    overrides: Partial<FakeAsset> & { kind?: "original" | "representation" } = {},
  ) => {
    const asset: FakeAsset = {
      id: id(n),
      kind: "original",
      size: 100,
      sha256: "b".repeat(64),
      owners: [],
      unownedAt: state.now,
      originalId: null,
      ...overrides,
    };
    state.assets.push(asset);
    return asset;
  };

  return { state, store, retention, add };
}

describe("attachment retention sweep", () => {
  it("cancels stale imports, expires old tombstones and deletes aged unowned assets", async () => {
    const h = harness();
    h.state.staging.push(
      { id: id(10), kind: "original", size: 40, createdAt: h.state.now - 25 * HOUR, owner: DRAFT },
      { id: id(11), kind: "original", size: 40, createdAt: h.state.now - HOUR, owner: DRAFT },
    );
    const original = h.add(20, { unownedAt: h.state.now - 8 * DAY });
    const representation = h.add(21, {
      kind: "representation",
      originalId: original.id,
      owners: [],
      unownedAt: h.state.now - 8 * DAY,
      size: 10,
    });
    h.add(22, { unownedAt: h.state.now - 6 * DAY });
    h.add(23, { owners: [DRAFT], unownedAt: null });
    h.state.tombstones.push({
      owner: { kind: "session", id: "expired" },
      deletedAt: h.state.now - 40 * DAY,
      expiresAt: h.state.now - 1,
      assetIds: [id(24)],
    });
    const protectedAsset = h.add(24, { unownedAt: h.state.now - 40 * DAY });
    h.state.tombstones.push({
      owner: { kind: "session", id: "live" },
      deletedAt: h.state.now - DAY,
      expiresAt: h.state.now + 30 * DAY,
      assetIds: [protectedAsset.id],
    });

    const report = await h.retention.sweep();
    expect(report).toMatchObject({
      paused: null,
      staleStagingRemoved: 1,
      expiredTombstones: 1,
      assetsRemoved: 2,
      errors: 0,
    });
    expect(h.state.cancelled).toEqual([id(10)]);
    expect(h.state.tombstones.map((tombstone) => tombstone.owner.id)).toEqual(["live"]);
    expect(h.state.removed).toEqual([representation.id, original.id]);
    expect(h.state.assets.map((asset) => asset.id)).toContain(id(22));
    expect(h.state.assets.map((asset) => asset.id)).toContain(protectedAsset.id);
    // The draft-owned pending attempt is never a deletion candidate.
    expect(h.state.assets.map((asset) => asset.id)).toContain(id(23));

    // Idempotent: the next pass finds nothing new.
    await expect(h.retention.sweep()).resolves.toMatchObject({
      staleStagingRemoved: 0,
      expiredTombstones: 0,
      assetsRemoved: 0,
    });
  });

  it("pauses every destructive step when the journal is unreadable", async () => {
    const h = harness({ journalThrows: true });
    h.state.staging.push({
      id: id(30),
      kind: "original",
      size: 10,
      createdAt: h.state.now - 48 * HOUR,
      owner: DRAFT,
    });
    h.add(31, { unownedAt: h.state.now - 30 * DAY });
    const report = await h.retention.sweep();
    expect(report).toMatchObject({ paused: "journal", staleStagingRemoved: 0, assetsRemoved: 0 });
    expect(h.store.cancel).not.toHaveBeenCalled();
    expect(h.store.removeAsset).not.toHaveBeenCalled();
    expect(h.store.retryObjectRemovals).not.toHaveBeenCalled();
  });

  it("pauses when the manifest is corrupt and never implies unowned data", async () => {
    const h = harness();
    h.add(40, { id: "corrupt" });
    const report = await h.retention.sweep();
    expect(report).toMatchObject({ paused: "manifest", assetsRemoved: 0 });
    expect(h.store.cancel).not.toHaveBeenCalled();
    expect(h.store.removeAsset).not.toHaveBeenCalled();
  });

  it("retires a session's session and branch owners and reports storage", async () => {
    const h = harness();
    const sessionOwner = attachmentSessionOwner(profileKey, "session-1");
    const original = h.add(50, { owners: [sessionOwner] });
    const representation = h.add(51, {
      kind: "representation",
      originalId: original.id,
      owners: [sessionOwner],
      size: 25,
    });
    h.state.journal.list = vi.fn(async (): Promise<unknown[]> => [
      { scope: { profileKey, sessionId: "session-1", branchId: "branch-a" } },
      { scope: { profileKey, sessionId: "session-1", branchId: "branch-b" } },
      { scope: { profileKey, sessionId: "other", branchId: "branch-c" } },
      { scope: { profileKey, sessionId: "session-1", branchId: "branch-a" } },
    ]);

    const result = await h.retention.retireSession("session-1");
    expect(result.tombstones).toBe(3);
    expect(h.state.retireCalls).toHaveLength(1);
    expect(h.state.retireCalls[0]?.retentionMs).toBe(ATTACHMENT_TOMBSTONE_MS);
    expect(h.state.retireCalls[0]?.owners).toHaveLength(3);

    h.state.now += ATTACHMENT_STAGING_MAX_AGE_MS + ATTACHMENT_UNOWNED_GRACE_MS + 1;
    const report = await h.retention.report();
    expect(report).toMatchObject({
      assets: 2,
      originals: 1,
      representations: 1,
      assetBytes: 125,
      tombstones: 3,
      tombstonedAssets: 2,
      tombstonedBytes: 125,
      unowned: 2,
      quotaBytes: 5 * 1024 * 1024 * 1024,
      freeBytes: 123,
    });
    expect(report?.removable).toBe(0);
    expect(report?.referenced).toBe(0);
    expect(representation.size).toBe(25);

    await expect(h.retention.restoreSession("session-1")).resolves.toBe(1);
  });

  it("clears explicitly without evicting owned or tombstoned assets", async () => {
    const h = harness();
    const young = h.add(60, { owners: [], unownedAt: h.state.now - HOUR });
    const old = h.add(61, { owners: [], unownedAt: h.state.now - 2 * DAY });
    const owned = h.add(62, { owners: [DRAFT], unownedAt: null });
    const protectedAsset = h.add(63, { owners: [], unownedAt: h.state.now - 30 * DAY });
    h.state.tombstones.push({
      owner: { kind: "session", id: "live" },
      deletedAt: h.state.now - DAY,
      expiresAt: h.state.now + 30 * DAY,
      assetIds: [protectedAsset.id],
    });

    const report = await h.retention.clear();
    expect(report.paused).toBeNull();
    expect(report.assetsRemoved).toBe(2);
    expect(report.bytesFreed).toBe(200);
    expect(h.state.assets.map((asset) => asset.id)).toEqual([owned.id, protectedAsset.id]);
    expect(young.id).not.toBe(old.id);
  });

  it("returns null when storage cannot be measured and reports incidents", async () => {
    const incidents: string[] = [];
    const h = harness();
    h.add(70, { id: "corrupt" });
    const retention = createAttachmentRetention({
      profileKey,
      store: h.store as never,
      journal: h.state.journal as never,
      ownership: h.state.ownership,
      now: () => h.state.now,
      report: (incident) => incidents.push(incident),
    });
    await expect(retention.report()).resolves.toBeNull();
    expect(incidents).toContain("manifest_unreadable");
  });
});
