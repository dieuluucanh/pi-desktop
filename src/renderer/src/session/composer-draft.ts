/**
 * The composer's revisioned draft (2026-11-22 prompt-refinement plan step 18).
 *
 * The textarea used to own the image attachments locally, so replacing the
 * composer (a docked extension dialog, a remount, a pane move) silently dropped
 * them and no caller could tell whether a draft had changed between two
 * moments. This module is the pure model: the store keeps one record per tab,
 * the composer renders it, and every content change mints a new revision.
 *
 * Invariants:
 *  - **Content revisions are monotonic.** Every write that changes the visible
 *    content — typing, a host `setEditorText`, a paste marker's body, an
 *    attachment add/remove — allocates a new, higher `revision`, even when the
 *    text returns to an earlier value (edit-then-revert is not a no-op: a
 *    stale async result must not apply over it). Re-setting identical content
 *    is a no-op, so a repeated host frame does not invalidate a live snapshot.
 *  - **Selection is separate.** Moving the caret is not a content change; it
 *    never touches `revision`.
 *  - **Attachments keep their object identity.** The same image added twice is
 *    two attachments with two ids (see `image-attachment.ts`); removing one
 *    removes only that one. `attachmentRevision` changes only when the ordered
 *    identity set changes, so a text edit does not look like an attachment
 *    edit.
 *  - **No binary data leaves the renderer.** Snapshots carry attachment ids,
 *    names, mime types and byte counts only; the base64 payload stays in the
 *    live record (renderer memory) and is never part of persisted preferences.
 */

import type { ImageAttachment } from "./image-attachment";

/** A caret/selection range in the draft text, normalised so `start <= end`. */
export interface ComposerSelection {
  start: number;
  end: number;
}

/** Attachment metadata, safe to copy into an operation request or a log line. */
export interface ComposerAttachmentView {
  id: string;
  name: string;
  mimeType: string;
  /** Base64 length, not the decoded image size: a bound is all a caller needs. */
  bytes: number;
}

/** One tab's live composer draft. Immutable; replace it through the helpers. */
export interface ComposerDraftState {
  /** The text at the latest content revision (kept in step with `prefs.drafts`). */
  text: string;
  attachments: readonly ImageAttachment[];
  /** Monotonic content revision; see the module comment. */
  revision: number;
  /** Monotonic revision of the ordered attachment identity set. */
  attachmentRevision: number;
  selection: ComposerSelection;
}

/** What a caller captures before a long-running operation (plan step 19). */
export interface ComposerDraftSnapshot {
  revision: number;
  attachmentRevision: number;
  /** The composer text, with paste markers still collapsed. */
  text: string;
  /** The same text with every known paste body expanded: what would be sent. */
  expandedText: string;
  selection: ComposerSelection;
  attachments: ComposerAttachmentView[];
}

/**
 * A process-wide clock, not a per-record counter: a lazily recreated record
 * (renderer reload, hot replace, a tab re-opened with the same id after close)
 * must never mint a revision an older snapshot could compare itself equal to.
 */
let draftRevisionClock = 0;

/** Allocates the next monotonic draft revision. */
export function nextDraftRevision(): number {
  draftRevisionClock += 1;
  return draftRevisionClock;
}

/** The shared empty attachment list, so a draft with no images is stable. */
export const NO_ATTACHMENTS: readonly ImageAttachment[] = Object.freeze([]);

/** A new draft for a tab: the current text, no attachments, caret at the end. */
export function createComposerDraft(text = ""): ComposerDraftState {
  return {
    text,
    attachments: NO_ATTACHMENTS,
    revision: nextDraftRevision(),
    attachmentRevision: nextDraftRevision(),
    selection: { start: text.length, end: text.length },
  };
}

/** Ordered attachment ids; two arrays are the same identity set when equal. */
export function attachmentIds(draft: ComposerDraftState): string[] {
  return draft.attachments.map((attachment) => attachment.id);
}

function sameAttachmentOrder(
  left: readonly ImageAttachment[],
  right: readonly ImageAttachment[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((attachment, index) => attachment.id === right[index]?.id);
}

/**
 * Replaces the text. Identical text is a no-op so a replayed host frame cannot
 * invalidate a pending operation; a genuine change (including a revert) bumps
 * the content revision and moves the caret to the end of the new text.
 */
export function withDraftText(draft: ComposerDraftState, text: string): ComposerDraftState {
  if (draft.text === text) return draft;
  return {
    ...draft,
    text,
    revision: nextDraftRevision(),
    selection: { start: text.length, end: text.length },
  };
}

/** Replaces the whole attachment list, bumping both revisions when it changed. */
export function withDraftAttachments(
  draft: ComposerDraftState,
  attachments: readonly ImageAttachment[],
): ComposerDraftState {
  if (sameAttachmentOrder(draft.attachments, attachments)) return draft;
  return {
    ...draft,
    attachments: attachments.length === 0 ? NO_ATTACHMENTS : [...attachments],
    revision: nextDraftRevision(),
    attachmentRevision: nextDraftRevision(),
  };
}

/**
 * Appends attachments. An id already present is ignored rather than replaced,
 * so a double drop of the same pasted file cannot collapse two visible chips.
 */
export function addDraftAttachments(
  draft: ComposerDraftState,
  added: readonly ImageAttachment[],
): ComposerDraftState {
  if (added.length === 0) return draft;
  const known = new Set(draft.attachments.map((attachment) => attachment.id));
  const fresh = added.filter((attachment) => !known.has(attachment.id));
  if (fresh.length === 0) return draft;
  return withDraftAttachments(draft, [...draft.attachments, ...fresh]);
}

/** Removes one attachment by its instance id. An unknown id is a no-op. */
export function removeDraftAttachment(
  draft: ComposerDraftState,
  attachmentId: string,
): ComposerDraftState {
  const next = draft.attachments.filter((attachment) => attachment.id !== attachmentId);
  if (next.length === draft.attachments.length) return draft;
  return withDraftAttachments(draft, next);
}

/** Drops every attachment (a successful send, or a cleared composer). */
export function clearDraftAttachments(draft: ComposerDraftState): ComposerDraftState {
  if (draft.attachments.length === 0) return draft;
  return withDraftAttachments(draft, NO_ATTACHMENTS);
}

/**
 * Records the caret/selection. Never bumps a revision: selection changes are
 * not content changes, so an operation started before the caret moved stays
 * applicable.
 */
export function withDraftSelection(
  draft: ComposerDraftState,
  selection: ComposerSelection,
  text: string = draft.text,
): ComposerDraftState {
  const limit = text.length;
  const start = Math.max(0, Math.min(Math.trunc(selection.start), limit));
  const end = Math.max(0, Math.min(Math.trunc(selection.end), limit));
  const normalised = { start: Math.min(start, end), end: Math.max(start, end) };
  if (draft.selection.start === normalised.start && draft.selection.end === normalised.end) {
    return draft;
  }
  return { ...draft, selection: normalised };
}

/**
 * Marks a change to a paste marker's body. The visible text is unchanged — the
 * marker is still `[paste #3 +240 lines]` — but the canonical text that would be
 * sent changed, so a snapshot taken against the old body must not apply.
 */
export function withPasteExpansionChanged(draft: ComposerDraftState): ComposerDraftState {
  return { ...draft, revision: nextDraftRevision() };
}

/** Attachment metadata for a snapshot; never the base64 payload. */
export function attachmentViews(draft: ComposerDraftState): ComposerAttachmentView[] {
  return draft.attachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    bytes: attachment.data.length,
  }));
}

/**
 * The capture a live operation starts from (plan step 19). `expandedText` is
 * passed in because expanding paste markers needs the tab's paste table, which
 * the store owns.
 */
export function createDraftSnapshot(
  draft: ComposerDraftState,
  expandedText: string,
): ComposerDraftSnapshot {
  return {
    revision: draft.revision,
    attachmentRevision: draft.attachmentRevision,
    text: draft.text,
    expandedText,
    selection: { ...draft.selection },
    attachments: attachmentViews(draft),
  };
}

/**
 * True when a candidate computed against `base` still describes the live
 * draft. Selection is deliberately excluded.
 */
export function draftMatchesSnapshot(
  draft: ComposerDraftState,
  base: Pick<ComposerDraftSnapshot, "revision" | "attachmentRevision">,
): boolean {
  return draft.revision === base.revision && draft.attachmentRevision === base.attachmentRevision;
}
