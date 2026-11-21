import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AssetOwner } from "../../src/attachments/store";
import {
  attachmentBranchOwner,
  attachmentOwnersForScope,
  attachmentSessionOwner,
  createAttachmentOwnershipReconciler,
} from "../../src/main/attachment-ownership";
import type {
  AttachmentSubmissionJournal,
  AttachmentSubmissionJournalEntry,
} from "../../src/main/attachment-submission-journal";
import type {
  AttachmentDeliveryScope,
  AttachmentSubmissionAssociation,
} from "../../src/shared/attachments";

const profileKey = "a".repeat(64);
const otherProfile = "b".repeat(64);
const opaque = (n: number): string =>
  `123e4567-e89b-42d3-a456-${String(426614174000 + n).padStart(12, "0")}`;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

const scope: AttachmentDeliveryScope = {
  authorityId: opaque(1),
  leaseId: opaque(2),
  profileKey,
  tabId: "tab-1",
  draftId: opaque(3),
  hostGeneration: 4,
  processGeneration: 8,
  sessionId: "session-1",
  sessionEpoch: 3,
  branchId: "branch-1",
  revision: "revision-1",
};

const originalId = opaque(10);
const representationId = opaque(11);
const otherOriginalId = opaque(12);
const otherRepresentationId = opaque(13);

function entry(
  overrides: Partial<AttachmentSubmissionJournalEntry> = {},
): AttachmentSubmissionJournalEntry {
  return {
    version: 1,
    planId: opaque(20),
    turnId: opaque(21),
    attemptId: opaque(22),
    scope: { ...scope },
    sourceTextSha256: digest("review this"),
    images: [],
    representations: [
      {
        representationId,
        representationSha256: digest("body"),
        originalId,
        originalSha256: digest("original"),
        modality: "text",
      },
    ],
    retryOfAttemptId: null,
    state: "accepted",
    createdAt: 1_000,
    updatedAt: 1_000,
    ownershipReconciledAt: 1_000,
    result: {
      outcome: "accepted",
      turnId: opaque(21),
      attemptId: opaque(22),
      userEntryId: "user-entry-1",
      associationEntryId: "association-entry-1",
    },
    ...overrides,
  };
}

function associationFor(value: AttachmentSubmissionJournalEntry): AttachmentSubmissionAssociation {
  if (value.result?.outcome !== "accepted") throw new Error("entry is not accepted");
  return {
    associationEntryId: value.result.associationEntryId,
    metadata: {
      version: 1,
      planId: value.planId,
      turnId: value.turnId,
      attemptId: value.attemptId,
      scope: { ...value.scope },
      sourceTextSha256: value.sourceTextSha256,
      userEntryId: value.result.userEntryId,
      textSha256: digest("delivered"),
      images: [...value.images],
      representations: value.representations.map((item) => ({ ...item })),
      createdAt: 1_000,
    },
  };
}

function sameOwner(left: AssetOwner, right: AssetOwner): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function memoryStore(seed: Array<{ id: string; owners: AssetOwner[]; originalId?: string }>) {
  const assets = new Map<string, AssetOwner[]>();
  const parents = new Map<string, string | undefined>();
  for (const item of seed) {
    assets.set(
      item.id,
      item.owners.map((owner) => ({ ...owner })),
    );
    parents.set(item.id, item.originalId);
  }
  const failing = new Set<string>();
  const store = {
    assets,
    failAddFor: (id: string) => {
      failing.add(id);
    },
    clearFailures: () => {
      failing.clear();
    },
    owners: vi.fn(async (id: string) => (assets.get(id) ?? []).map((owner) => ({ ...owner }))),
    addOwner: vi.fn(async (id: string, current: AssetOwner, next: AssetOwner) => {
      const owners = assets.get(id);
      if (!owners || !owners.some((owner) => sameOwner(owner, current))) {
        throw Object.assign(new Error("not found"), { code: "not_found" });
      }
      const parent = parents.get(id);
      if (
        parent !== undefined &&
        !(assets.get(parent) ?? []).some((owner) => sameOwner(owner, next))
      ) {
        throw Object.assign(new Error("dependency"), { code: "not_found" });
      }
      if (failing.has(id)) throw new Error("simulated crash");
      if (!owners.some((owner) => sameOwner(owner, next))) owners.push({ ...next });
    }),
  };
  return store;
}

function journalOf(
  entries: readonly AttachmentSubmissionJournalEntry[],
): Pick<AttachmentSubmissionJournal, "list"> {
  return { list: async () => entries.map((item) => structuredClone(item)) };
}

const draftOwner: AssetOwner = { kind: "draft", id: scope.draftId };

function seededStore() {
  return memoryStore([
    { id: originalId, owners: [draftOwner] },
    { id: representationId, owners: [draftOwner], originalId },
  ]);
}

describe("accepted attachment ownership", () => {
  it("promotes originals before representations to session and branch owners, idempotently", async () => {
    const store = seededStore();
    const reconciler = createAttachmentOwnershipReconciler({
      store,
      journal: journalOf([entry()]),
      profileKey,
    });

    await expect(reconciler.promote(entry())).resolves.toBe("promoted");
    const expected = attachmentOwnersForScope(profileKey, scope);
    expect(expected).toHaveLength(2);
    expect(store.assets.get(originalId)).toEqual([draftOwner, ...expected]);
    expect(store.assets.get(representationId)).toEqual([draftOwner, ...expected]);
    expect(store.addOwner).toHaveBeenCalledTimes(4);

    await expect(reconciler.promote(entry())).resolves.toBe("skipped");
    expect(store.addOwner).toHaveBeenCalledTimes(4);
  });

  it("never promotes a non-accepted or foreign-profile entry", async () => {
    const store = seededStore();
    const reconciler = createAttachmentOwnershipReconciler({
      store,
      journal: journalOf([entry()]),
      profileKey,
    });
    for (const state of ["dispatching", "uncertain", "handled", "blocked"] as const) {
      await expect(reconciler.promote(entry({ state }))).resolves.toBe("skipped");
    }
    await expect(
      reconciler.promote(entry({ scope: { ...scope, profileKey: otherProfile } })),
    ).resolves.toBe("skipped");
    await expect(
      reconciler.promote(entry({ scope: { ...scope, draftId: "not-an-id" } })),
    ).resolves.toBe("skipped");
    expect(store.addOwner).not.toHaveBeenCalled();
  });

  it("repairs a crash between the original and its representation", async () => {
    const store = seededStore();
    const reconciler = createAttachmentOwnershipReconciler({
      store,
      journal: journalOf([entry()]),
      profileKey,
    });
    // Original session owner succeeds; the representation write crashes.
    store.failAddFor(representationId);
    await expect(reconciler.promote(entry())).resolves.toBe("incomplete");
    // Every owner is attempted per asset; both original writes succeed and the
    // representation stays behind until the crash is repaired.
    expect(store.assets.get(originalId)).toEqual([
      draftOwner,
      attachmentSessionOwner(profileKey, scope.sessionId),
      attachmentBranchOwner(profileKey, scope.sessionId, "branch-1"),
    ]);
    expect(store.assets.get(representationId)).toEqual([draftOwner]);

    store.clearFailures();
    await expect(reconciler.promote(entry())).resolves.toBe("promoted");
    expect(store.assets.get(representationId)).toEqual([
      draftOwner,
      attachmentSessionOwner(profileKey, scope.sessionId),
      attachmentBranchOwner(profileKey, scope.sessionId, "branch-1"),
    ]);
    // The journal remains accepted; nothing here rewrites it.
    expect(entry().state).toBe("accepted");
  });

  it("reports a missing asset without throwing and still retries later", async () => {
    const store = memoryStore([{ id: representationId, owners: [draftOwner], originalId }]);
    const reconciler = createAttachmentOwnershipReconciler({
      store,
      journal: journalOf([entry()]),
      profileKey,
    });
    await expect(reconciler.promote(entry())).resolves.toBe("incomplete");
    await expect(reconciler.reconcile()).resolves.toEqual({ promoted: 0, incomplete: 1 });
    expect(store.addOwner).not.toHaveBeenCalled();
  });

  it("uses an existing durable owner when the draft generation is already released", async () => {
    const sessionOwner = attachmentSessionOwner(profileKey, scope.sessionId);
    const store = memoryStore([
      { id: originalId, owners: [sessionOwner] },
      { id: representationId, owners: [sessionOwner], originalId },
    ]);
    const reconciler = createAttachmentOwnershipReconciler({
      store,
      journal: journalOf([entry()]),
      profileKey,
    });
    await expect(reconciler.promote(entry())).resolves.toBe("promoted");
    const branchOwner = attachmentBranchOwner(profileKey, scope.sessionId, "branch-1");
    expect(store.assets.get(originalId)).toEqual([sessionOwner, branchOwner]);
    expect(store.assets.get(representationId)).toEqual([sessionOwner, branchOwner]);
  });

  it("sweeps every accepted entry and counts durable repairs", async () => {
    const store = seedTwoAssets();
    const reconciler = createAttachmentOwnershipReconciler({
      store,
      journal: journalOf([
        entry(),
        entry({
          attemptId: opaque(23),
          turnId: opaque(24),
          planId: opaque(25),
          representations: [
            {
              representationId: otherRepresentationId,
              representationSha256: digest("other"),
              originalId: otherOriginalId,
              originalSha256: digest("other-original"),
              modality: "text",
            },
          ],
          result: {
            outcome: "accepted",
            turnId: opaque(24),
            attemptId: opaque(23),
            userEntryId: "user-entry-2",
            associationEntryId: "association-entry-2",
          },
        }),
        entry({ state: "uncertain", attemptId: opaque(26) }),
      ]),
      profileKey,
    });
    await expect(reconciler.reconcile()).resolves.toEqual({ promoted: 2, incomplete: 0 });
    await expect(reconciler.reconcile()).resolves.toEqual({ promoted: 0, incomplete: 0 });
  });

  it("adopts a fork's exact copied association without granting arbitrary ids", async () => {
    const source = entry();
    const store = seededStore();
    const reconciler = createAttachmentOwnershipReconciler({
      store,
      journal: journalOf([source]),
      profileKey,
    });
    expect(
      await reconciler.adopt({
        sessionId: "forked-session",
        branchId: "forked-branch",
        associations: [associationFor(source)],
      }),
    ).toBe(4);
    const forkSession = attachmentSessionOwner(profileKey, "forked-session");
    const forkBranch = attachmentBranchOwner(profileKey, "forked-session", "forked-branch");
    expect(store.assets.get(originalId)).toEqual(expect.arrayContaining([forkSession, forkBranch]));
    expect(store.assets.get(originalId)).toEqual(
      expect.arrayContaining([
        attachmentSessionOwner(profileKey, scope.sessionId),
        attachmentBranchOwner(profileKey, scope.sessionId, "branch-1"),
      ]),
    );

    // Idempotent: a second read adds nothing.
    const calls = store.addOwner.mock.calls.length;
    expect(
      await reconciler.adopt({
        sessionId: "forked-session",
        branchId: "forked-branch",
        associations: [associationFor(source)],
      }),
    ).toBe(0);
    expect(store.addOwner.mock.calls.length).toBe(calls);
  });

  it("refuses forged, foreign or non-accepted metadata", async () => {
    const source = entry();
    const store = seededStore();
    const reconciler = createAttachmentOwnershipReconciler({
      store,
      journal: journalOf([source]),
      profileKey,
    });
    const forged = associationFor(source);
    const cases: unknown[] = [
      { ...forged, associationEntryId: "other-entry" },
      {
        ...forged,
        metadata: { ...forged.metadata, userEntryId: "forged-user" },
      },
      {
        ...forged,
        metadata: { ...forged.metadata, textSha256: "not-a-digest" },
      },
      {
        ...forged,
        metadata: { ...forged.metadata, profileKey: otherProfile },
      },
      {
        ...forged,
        metadata: {
          ...forged.metadata,
          scope: { ...forged.metadata.scope, profileKey: otherProfile },
        },
      },
      {
        ...forged,
        metadata: {
          ...forged.metadata,
          representations: [
            { ...forged.metadata.representations[0]!, representationSha256: digest("tampered") },
          ],
        },
      },
      {
        ...forged,
        metadata: {
          ...forged.metadata,
          scope: { ...forged.metadata.scope, sessionId: "forged-session" },
        },
      },
      {
        ...forged,
        metadata: {
          ...forged.metadata,
          scope: { ...forged.metadata.scope, branchId: "forged-branch" },
        },
      },
      { metadata: forged.metadata },
      "not-an-association",
      null,
    ];
    expect(
      await reconciler.adopt({
        sessionId: "forked-session",
        branchId: null,
        associations: cases,
      }),
    ).toBe(0);
    expect(store.addOwner).not.toHaveBeenCalled();

    // A paused/handled entry is not adoption evidence, even with a valid shape.
    const uncertain = createAttachmentOwnershipReconciler({
      store,
      journal: journalOf([{ ...source, state: "uncertain" }]),
      profileKey,
    });
    expect(
      await uncertain.adopt({
        sessionId: "forked-session",
        branchId: null,
        associations: [associationFor(source)],
      }),
    ).toBe(0);
  });

  it("validates adoption inputs and bounds", async () => {
    const store = seededStore();
    const reconciler = createAttachmentOwnershipReconciler({
      store,
      journal: journalOf([entry()]),
      profileKey,
    });
    await expect(
      reconciler.adopt({ sessionId: "", branchId: null, associations: [] }),
    ).resolves.toBe(0);
    await expect(
      reconciler.adopt({ sessionId: "s", branchId: "bad\nbranch", associations: [] }),
    ).resolves.toBe(0);
    await expect(
      reconciler.adopt({
        sessionId: "s",
        branchId: null,
        associations: Array.from({ length: 513 }, () => null),
      }),
    ).resolves.toBe(0);
    expect(store.addOwner).not.toHaveBeenCalled();
  });

  it("skips a tombstoned target but records a durable ownership decision", async () => {
    const store = seededStore();
    const mark = vi.fn(async () => {});
    const reconciler = createAttachmentOwnershipReconciler({
      store,
      journal: journalOf([entry()]),
      profileKey,
      isRetired: async (owner) =>
        owner.kind === "session" &&
        owner.id === attachmentSessionOwner(profileKey, scope.sessionId).id,
      markReconciled: mark,
    });
    await expect(reconciler.promote(entry())).resolves.toBe("promoted");
    // The session target is retired; the branch target is still promoted.
    expect(store.assets.get(originalId)).toEqual([
      draftOwner,
      attachmentBranchOwner(profileKey, scope.sessionId, "branch-1"),
    ]);
    expect(mark).toHaveBeenCalledOnce();
  });

  it("clears the live session's tombstone when adopting exact evidence", async () => {
    const source = entry();
    const store = seededStore();
    const clear = vi.fn(async () => 1);
    const reconciler = createAttachmentOwnershipReconciler({
      store,
      journal: journalOf([source]),
      profileKey,
      clearTombstone: clear,
    });
    await expect(
      reconciler.adopt({
        sessionId: "restored-session",
        branchId: "restored-branch",
        associations: [associationFor(source)],
      }),
    ).resolves.toBeGreaterThan(0);
    expect(clear).toHaveBeenCalledTimes(2);
  });
});

function seedTwoAssets() {
  return memoryStore([
    { id: originalId, owners: [{ ...draftOwner }] },
    { id: representationId, owners: [{ ...draftOwner }], originalId },
    { id: otherOriginalId, owners: [{ ...draftOwner }] },
    { id: otherRepresentationId, owners: [{ ...draftOwner }], originalId: otherOriginalId },
  ]);
}
