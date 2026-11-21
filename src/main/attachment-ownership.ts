import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  isAttachmentId,
  sameAttachmentRepresentations,
  validateAttachmentSubmissionMetadata,
  type AttachmentDeliveryScope,
  type AttachmentSubmissionAssociation,
} from "../shared/attachments";
import type { AssetOwner, AttachmentStore } from "../attachments/store";
import type {
  AttachmentSubmissionJournal,
  AttachmentSubmissionJournalEntry,
} from "./attachment-submission-journal";

/**
 * Durable ownership for accepted attachment submissions (plan step 12).
 *
 * `prefs`/drafts are ephemeral identities. Once Pi has durably accepted a turn,
 * the exact approved originals and representations must survive the draft that
 * created them, and must stay retained for every session/branch that references
 * them. This module is the one main-owned reconciler:
 *
 *  - `promote` adds the accepted scope's session and branch owners, idempotently.
 *  - `reconcile` sweeps every durable accepted journal entry (startup and after
 *    a live reconciliation), so a crash between acceptance and promotion is
 *    repaired later rather than becoming a resent turn.
 *  - `adopt` adds a live session/branch owner for an exact accepted association
 *    it holds (a Pi fork/clone copies entries verbatim but gets a new session
 *    id). It only accepts an association that matches an app-owned accepted
 *    journal entry by plan/turn/attempt/entry ids and representation identity,
 *    so imported/forged metadata and bare asset ids confer no ownership.
 *
 * No function here reads bytes, source paths or project files, and nothing is
 * exposed to the renderer. Ownership is retention/reassociation, not a grant to
 * read an arbitrary asset: previews still require an owner-scoped store read.
 */

const MAX_SCOPE_LENGTH = 512;
const MAX_ADOPTED_ASSOCIATIONS = 512;

function hasControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function validIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SCOPE_LENGTH &&
    !hasControl(value)
  );
}

function digest(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex");
}

/**
 * An opaque, profile-scoped durable owner id. The session/branch identity is
 * hashed (never stored as a path) and the `kind` stays `session` because the
 * store only distinguishes draft from durable ownership.
 */
export function attachmentSessionOwner(profileKey: string, sessionId: string): AssetOwner {
  return { kind: "session", id: `session:${digest([profileKey, "session", sessionId])}` };
}

export function attachmentBranchOwner(
  profileKey: string,
  sessionId: string,
  branchId: string,
): AssetOwner {
  return { kind: "session", id: `branch:${digest([profileKey, "branch", sessionId, branchId])}` };
}

/** Owners promised by one accepted delivery scope. */
export function attachmentOwnersForScope(
  profileKey: string,
  scope: Pick<AttachmentDeliveryScope, "sessionId" | "branchId">,
): readonly AssetOwner[] {
  const owners: AssetOwner[] = [attachmentSessionOwner(profileKey, scope.sessionId)];
  if (scope.branchId) {
    owners.push(attachmentBranchOwner(profileKey, scope.sessionId, scope.branchId));
  }
  return owners;
}

export type AttachmentPromotionResult = "promoted" | "skipped" | "incomplete";

export interface AttachmentOwnershipReconciler {
  /**
   * Promote one durable accepted entry. A crash anywhere in the middle leaves a
   * partial promotion that the next call completes; it never mutates the
   * journal or turns acceptance into uncertainty.
   */
  promote(entry: AttachmentSubmissionJournalEntry): Promise<AttachmentPromotionResult>;
  /** Promote every accepted entry (an explicit subset is used by dispatch). */
  reconcile(
    entries?: readonly AttachmentSubmissionJournalEntry[],
  ): Promise<{ promoted: number; incomplete: number }>;
  /**
   * Add a live session/branch as an owner when it holds an exact copy of an
   * app-accepted association (Pi fork/clone). Returns the number of assets that
   * gained the new owner.
   */
  adopt(input: {
    readonly sessionId: string;
    readonly branchId: string | null;
    readonly associations: readonly unknown[];
  }): Promise<number>;
}

export interface AttachmentOwnershipDeps {
  readonly store: Pick<AttachmentStore, "owners" | "addOwner">;
  readonly journal: Pick<AttachmentSubmissionJournal, "list">;
  /** Lowercase SHA-256 of the canonical profile identity. */
  readonly profileKey: string;
  /** Bounded incident hook; never receives names, paths or content. */
  readonly report?: (incident: "promotion_incomplete" | "adoption_incomplete") => void;
}

function sameOwner(left: AssetOwner, right: AssetOwner): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function validAssets(entry: AttachmentSubmissionJournalEntry): boolean {
  if (
    !Array.isArray(entry.representations) ||
    entry.representations.length === 0 ||
    entry.representations.length > 10
  ) {
    return false;
  }
  const originals = new Set<string>();
  for (const representation of entry.representations) {
    if (
      !representation ||
      !isAttachmentId(representation.representationId) ||
      !isAttachmentId(representation.originalId) ||
      originals.has(representation.originalId)
    ) {
      return false;
    }
    originals.add(representation.originalId);
  }
  return true;
}

function promotable(
  entry: AttachmentSubmissionJournalEntry,
  profileKey: string,
): entry is AttachmentSubmissionJournalEntry {
  return (
    !!entry &&
    entry.state === "accepted" &&
    entry.result?.outcome === "accepted" &&
    entry.scope?.profileKey === profileKey &&
    validIdentity(entry.scope.sessionId) &&
    (entry.scope.branchId === null || validIdentity(entry.scope.branchId)) &&
    isAttachmentId(entry.scope.draftId) &&
    validAssets(entry)
  );
}

/** The asset ids of one entry, originals before their representations. */
function assetOrder(entry: AttachmentSubmissionJournalEntry): {
  readonly originals: readonly string[];
  readonly representations: readonly string[];
} {
  const originals = [...new Set(entry.representations.map((item) => item.originalId))];
  return { originals, representations: entry.representations.map((item) => item.representationId) };
}

async function addOwners(
  store: AttachmentOwnershipDeps["store"],
  entry: AttachmentSubmissionJournalEntry,
  targets: readonly AssetOwner[],
): Promise<AttachmentPromotionResult> {
  const draftOwner: AssetOwner = { kind: "draft", id: entry.scope.draftId };
  const { originals } = assetOrder(entry);
  const representationOriginal = new Map(
    entry.representations.map((item) => [item.representationId, item.originalId]),
  );
  const representations = [...representationOriginal.keys()];
  let changed = false;
  let incomplete = false;
  for (const target of targets) {
    // An original must carry the owner before its representation can.
    const ownedOriginals = new Set<string>();
    for (const id of originals) {
      try {
        const owners = await store.owners(id);
        if (owners.some((owner) => sameOwner(owner, target))) {
          ownedOriginals.add(id);
          continue;
        }
        // After step 13 releases a draft owner, an existing durable owner is
        // the safe current owner; a manifest write is still required.
        const current = owners.find((owner) => sameOwner(owner, draftOwner)) ?? owners[0];
        if (!current) {
          incomplete = true;
          continue;
        }
        await store.addOwner(id, current, target);
        ownedOriginals.add(id);
        changed = true;
      } catch {
        // A missing asset must not abort the sweep; the journal stays accepted
        // and the next pass retries.
        incomplete = true;
      }
    }
    for (const id of representations) {
      const original = representationOriginal.get(id);
      if (!original || !ownedOriginals.has(original)) {
        incomplete = true;
        continue;
      }
      try {
        const owners = await store.owners(id);
        if (owners.some((owner) => sameOwner(owner, target))) continue;
        const current = owners.find((owner) => sameOwner(owner, draftOwner)) ?? owners[0];
        if (!current) {
          incomplete = true;
          continue;
        }
        await store.addOwner(id, current, target);
        changed = true;
      } catch {
        // A dependent-representation conflict is retried, never fatal.
        incomplete = true;
      }
    }
  }
  if (incomplete) return "incomplete";
  return changed ? "promoted" : "skipped";
}

function sameSubmissionIdentity(
  entry: AttachmentSubmissionJournalEntry,
  association: AttachmentSubmissionAssociation,
  profileKey: string,
): boolean {
  const metadata = association.metadata;
  return (
    entry.state === "accepted" &&
    entry.result?.outcome === "accepted" &&
    entry.scope.profileKey === profileKey &&
    // A fork copies the association verbatim, so adoption must present the exact
    // accepted scope. A modified/forged scope can never match app-owned evidence.
    isDeepStrictEqual(entry.scope, metadata.scope) &&
    entry.planId === metadata.planId &&
    entry.turnId === metadata.turnId &&
    entry.attemptId === metadata.attemptId &&
    entry.result.userEntryId === metadata.userEntryId &&
    entry.result.associationEntryId === association.associationEntryId &&
    entry.sourceTextSha256 === metadata.sourceTextSha256 &&
    sameAttachmentRepresentations(entry.representations, metadata.representations)
  );
}

function parseAssociation(value: unknown): AttachmentSubmissionAssociation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const association = value as Record<string, unknown>;
  if (
    Object.keys(association).length !== 2 ||
    !Object.keys(association).every((key) => ["metadata", "associationEntryId"].includes(key)) ||
    typeof association.associationEntryId !== "string" ||
    association.associationEntryId.length === 0 ||
    association.associationEntryId.length > 512
  ) {
    return null;
  }
  const metadata = validateAttachmentSubmissionMetadata(association.metadata);
  return metadata ? { metadata, associationEntryId: association.associationEntryId } : null;
}

export function createAttachmentOwnershipReconciler(
  deps: AttachmentOwnershipDeps,
): AttachmentOwnershipReconciler {
  const report = deps.report ?? (() => undefined);

  const promote = async (
    entry: AttachmentSubmissionJournalEntry,
  ): Promise<AttachmentPromotionResult> => {
    if (!promotable(entry, deps.profileKey)) return "skipped";
    const result = await addOwners(
      deps.store,
      entry,
      attachmentOwnersForScope(deps.profileKey, entry.scope),
    );
    if (result === "incomplete") report("promotion_incomplete");
    return result;
  };

  return {
    promote,
    async reconcile(entries) {
      let list: readonly AttachmentSubmissionJournalEntry[];
      try {
        list = entries ?? (await deps.journal.list());
      } catch {
        return { promoted: 0, incomplete: 1 };
      }
      let promoted = 0;
      let incomplete = 0;
      for (const entry of list) {
        if (entry.state !== "accepted") continue;
        const result = await promote(entry);
        if (result === "promoted") promoted++;
        if (result === "incomplete") incomplete++;
      }
      return { promoted, incomplete };
    },
    async adopt(input) {
      if (
        !validIdentity(input.sessionId) ||
        (input.branchId !== null && !validIdentity(input.branchId)) ||
        !Array.isArray(input.associations) ||
        input.associations.length > MAX_ADOPTED_ASSOCIATIONS
      ) {
        return 0;
      }
      let entries: readonly AttachmentSubmissionJournalEntry[];
      try {
        entries = await deps.journal.list();
      } catch {
        report("adoption_incomplete");
        return 0;
      }
      const accepted = entries.filter((entry) => promotable(entry, deps.profileKey));
      if (accepted.length === 0) return 0;
      const targets: AssetOwner[] = [attachmentSessionOwner(deps.profileKey, input.sessionId)];
      if (input.branchId) {
        targets.push(attachmentBranchOwner(deps.profileKey, input.sessionId, input.branchId));
      }
      const matched = new Map<string, AttachmentSubmissionJournalEntry>();
      for (const value of input.associations) {
        const association = parseAssociation(value);
        if (!association) continue;
        const entry = accepted.find((candidate) =>
          sameSubmissionIdentity(candidate, association, deps.profileKey),
        );
        if (entry) matched.set(entry.attemptId, entry);
      }
      let added = 0;
      let incomplete = false;
      for (const entry of matched.values()) {
        // Repair the original scope first; it also supplies a current owner if
        // the draft generation has already been released.
        const promoted = await promote(entry);
        if (promoted === "incomplete") incomplete = true;
        const { originals, representations } = assetOrder(entry);
        for (const target of targets) {
          for (const id of [...originals, ...representations]) {
            try {
              const owners = await deps.store.owners(id);
              if (owners.some((owner) => sameOwner(owner, target))) continue;
              const current = owners[0];
              if (!current) {
                incomplete = true;
                continue;
              }
              await deps.store.addOwner(id, current, target);
              added++;
            } catch {
              incomplete = true;
            }
          }
        }
      }
      if (incomplete) report("adoption_incomplete");
      return added;
    },
  };
}
