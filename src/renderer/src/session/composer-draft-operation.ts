/**
 * Draft-operation capture and compare-and-swap application
 * (2026-11-22 prompt-refinement plan step 19).
 *
 * Step 18 made the composer's text, attachments and revision one tab state.
 * This module is the pure half of the operation that reads it: it captures the
 * exact draft a submit starts from and applies one returned candidate only when
 * the live draft is still that capture.
 *
 * Invariants:
 *  - **The capture is the live draft, never the mirror.** `expandedText` is the
 *    canonical paste-expanded body a send would use, and the snapshot carries
 *    attachment ids/metadata only. A debounced `getEditorText()` value, a stale
 *    `prefs.drafts` echo or a host frame is not a capture.
 *  - **Base equality is content equality.** Both the text revision and the
 *    ordered attachment revision must still match. Typing, a host write, an
 *    attachment add/remove/reorder and an edit-then-revert all advance one of
 *    them, so an ABA edit can never look current again.
 *  - **One transition.** A successful apply replaces the text and keeps the
 *    live attachment objects (same identity) in a single new draft record; the
 *    caller commits that record and the persisted text together (the store
 *    does, in one `set`).
 *  - **Receipts make application idempotent.** A duplicate completion for an
 *    operation that already applied is refused without touching the draft, so
 *    a replayed frame or a reconciled host cannot apply twice.
 */

import type { ComposerAppliedReceipt } from "../../../shared/composer-operation";
import {
  attachmentViews,
  createDraftSnapshot,
  draftMatchesSnapshot,
  nextDraftRevision,
  withDraftText,
  type ComposerDraftSnapshot,
  type ComposerDraftState,
  type ComposerSelection,
} from "./composer-draft";

/** How many applied receipts one tab keeps for reconciliation. */
export const DRAFT_APPLY_RECEIPT_LIMIT = 32;

/** Why a candidate was not applied. */
export type DraftApplyRefusalReason =
  /** The operation was already applied at this candidate revision. */
  | "duplicate"
  /** The operation was already applied at a different revision. */
  | "already-applied"
  /** The draft moved on since the capture (typing, host write, attachments, ABA). */
  | "stale-base"
  /** A refined prompt may not replace the draft with nothing. */
  | "empty-candidate"
  /** Missing/malformed operation id or candidate revision. */
  | "invalid-candidate";

/** The capture a candidate is computed from, or the revision a user confirmed. */
export type DraftApplyBase = Pick<ComposerDraftSnapshot, "revision" | "attachmentRevision">;

/** What the host returns for one captured draft. */
export interface DraftCandidateText {
  operationId: string;
  candidateRevision: number;
  text: string;
}

/** The renderer-safe operation input: live text, canonical body, ids only. */
export interface DraftOperationInput {
  revision: number;
  attachmentRevision: number;
  /** The visible draft, paste markers still collapsed. */
  text: string;
  /** The canonical text a send would use (paste bodies expanded). */
  expandedText: string;
  selection: ComposerSelection;
  attachmentIds: string[];
}

/**
 * A caret request minted by a successful apply. It carries the text it belongs
 * to so a composer that mounted after the apply never places the caret into a
 * different draft.
 */
export interface ComposerCaretRequest {
  token: number;
  text: string;
  caret: number;
}

/**
 * The capture a submit sends. `expandedText` is passed in because expanding
 * paste markers needs the tab's paste table, which the store owns.
 */
export function captureDraftOperation(
  draft: ComposerDraftState,
  expandedText: string,
): ComposerDraftSnapshot {
  return createDraftSnapshot(draft, expandedText);
}

/**
 * Flattens a capture into the operation input. Attachment ids are ordered and
 * duplicated only when the user really attached the same image twice; the
 * base64 payload never leaves the live record.
 */
export function draftOperationInput(snapshot: ComposerDraftSnapshot): DraftOperationInput {
  return {
    revision: snapshot.revision,
    attachmentRevision: snapshot.attachmentRevision,
    text: snapshot.text,
    expandedText: snapshot.expandedText,
    selection: { ...snapshot.selection },
    attachmentIds: snapshot.attachments.map((attachment) => attachment.id),
  };
}

/** The applied receipt for an operation, if this tab already applied it. */
export function draftApplyReceipt(
  receipts: readonly ComposerAppliedReceipt[],
  operationId: string,
): ComposerAppliedReceipt | undefined {
  return receipts.find((receipt) => receipt.operationId === operationId);
}

/**
 * Records an applied receipt, replacing an earlier one for the same operation
 * and keeping the ledger bounded. The newest receipts are the ones a late
 * duplicate completion can still match, so the oldest are dropped first.
 */
export function recordDraftApplyReceipt(
  receipts: readonly ComposerAppliedReceipt[],
  receipt: ComposerAppliedReceipt,
): ComposerAppliedReceipt[] {
  const next = receipts.filter((entry) => entry.operationId !== receipt.operationId);
  next.push(receipt);
  return next.length > DRAFT_APPLY_RECEIPT_LIMIT
    ? next.slice(next.length - DRAFT_APPLY_RECEIPT_LIMIT)
    : next;
}

/** An apply outcome the caller may commit; refused outcomes change nothing. */
export interface DraftApplyApplied {
  status: "applied";
  draft: ComposerDraftState;
  receipt: ComposerAppliedReceipt;
  /** Where the caret belongs once the DOM carries the replaced text. */
  caret: number;
  /** The text that was replaced, for a "what changed" notice. */
  replacedText: string;
}

export interface DraftApplyRefused {
  status: "refused";
  reason: DraftApplyRefusalReason;
  /** The live draft, unchanged. */
  draft: ComposerDraftState;
}

export type DraftApplyOutcome = DraftApplyApplied | DraftApplyRefused;

export interface DraftApplyInput {
  /** The live record the caller just read. */
  draft: ComposerDraftState;
  /** The capture (automatic apply) or the revision the user confirmed. */
  base: DraftApplyBase;
  candidate: DraftCandidateText;
  /** This tab's applied receipts, newest last. */
  receipts: readonly ComposerAppliedReceipt[];
  /** Timestamp for the receipt (injected so tests stay deterministic). */
  appliedAt: number;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isBase(value: DraftApplyBase | undefined): value is DraftApplyBase {
  return (
    value !== undefined && isPositiveInt(value.revision) && isPositiveInt(value.attachmentRevision)
  );
}

/**
 * Applies one candidate only to its exact still-current base snapshot.
 *
 * The result is pure: the caller decides whether to commit the returned draft,
 * persist its text, record the receipt and place the caret. A refusal returns
 * the unchanged draft so a caller that tried anyway cannot clobber newer text.
 */
export function applyDraftCandidate(input: DraftApplyInput): DraftApplyOutcome {
  const { draft, base, candidate, receipts, appliedAt } = input;
  const refused = (reason: DraftApplyRefusalReason): DraftApplyRefused => ({
    status: "refused",
    reason,
    draft,
  });

  if (
    !candidate ||
    typeof candidate.operationId !== "string" ||
    candidate.operationId.length === 0 ||
    !isPositiveInt(candidate.candidateRevision) ||
    typeof candidate.text !== "string"
  ) {
    return refused("invalid-candidate");
  }
  if (!isBase(base)) return refused("stale-base");

  const applied = draftApplyReceipt(receipts, candidate.operationId);
  if (applied) {
    return refused(
      applied.appliedRevision === candidate.candidateRevision ? "duplicate" : "already-applied",
    );
  }

  if (candidate.text.trim().length === 0) return refused("empty-candidate");

  if (!draftMatchesSnapshot(draft, base)) return refused("stale-base");

  // The text is replaced and every live attachment is kept in the same record:
  // no intermediate draft can drop a chip the user added while refining.
  const replaced =
    draft.text === candidate.text
      ? // An applied candidate always advances the revision, even when it
        // happens to equal the current text: the capture must not stay current
        // for a second operation.
        { ...draft, revision: nextDraftRevision() }
      : withDraftText(draft, candidate.text);
  const caret = replaced.text.length;

  return {
    status: "applied",
    draft: replaced,
    receipt: {
      operationId: candidate.operationId,
      appliedRevision: candidate.candidateRevision,
      disposition: "replaced",
      appliedAt,
    },
    caret,
    replacedText: draft.text,
  };
}

/**
 * The attachment metadata a candidate application preserves. Exported so a
 * caller/test can state the invariant without re-reading the draft internals.
 */
export function preservedAttachmentIds(draft: ComposerDraftState): string[] {
  return attachmentViews(draft).map((attachment) => attachment.id);
}
