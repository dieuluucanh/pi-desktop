import { describe, expect, it } from "vitest";
import {
  addDraftAttachments,
  attachmentIds,
  attachmentViews,
  clearDraftAttachments,
  createComposerDraft,
  createDraftSnapshot,
  draftMatchesSnapshot,
  removeDraftAttachment,
  withDraftAttachments,
  withDraftSelection,
  withDraftText,
  withPasteExpansionChanged,
} from "../../src/renderer/src/session/composer-draft";
import type { ImageAttachment } from "../../src/renderer/src/session/image-attachment";

/**
 * The revisioned composer draft (2026-11-22 prompt-refinement plan step 18).
 *
 * The behaviours that matter are the ones a later CAS apply depends on:
 * monotonic revisions (including edit-then-revert), attachment identity, and
 * selection being independent of content.
 */

function image(id: string, name = `${id}.png`, data = "AAAA"): ImageAttachment {
  return { id, name, mimeType: "image/png", data };
}

describe("content revisions", () => {
  it("bumps once per real text change and not for identical text", () => {
    const start = createComposerDraft("one");
    const edited = withDraftText(start, "two");
    expect(edited.revision).toBeGreaterThan(start.revision);
    expect(withDraftText(edited, "two")).toBe(edited);
    expect(withDraftText(edited, "two").revision).toBe(edited.revision);
  });

  it("keeps revisions monotonic through an edit-then-revert (ABA)", () => {
    const start = createComposerDraft("a");
    const edited = withDraftText(start, "b");
    const reverted = withDraftText(edited, "a");

    expect(reverted.text).toBe(start.text);
    expect(edited.revision).toBeGreaterThan(start.revision);
    expect(reverted.revision).toBeGreaterThan(edited.revision);
    // The reverted draft is not the original record: a stale snapshot must fail.
    expect(draftMatchesSnapshot(reverted, createDraftSnapshot(start, "a"))).toBe(false);
  });

  it("moves the caret to the end of new text", () => {
    const draft = withDraftText(createComposerDraft("hello"), "hello world");
    expect(draft.selection).toEqual({ start: 11, end: 11 });
  });

  it("treats a paste-body change as a content change without touching text", () => {
    const draft = withDraftAttachments(createComposerDraft("[paste #1 4 chars]"), [image("a")]);
    const next = withPasteExpansionChanged(draft);

    expect(next.text).toBe(draft.text);
    expect(next.attachments).toBe(draft.attachments);
    expect(next.attachmentRevision).toBe(draft.attachmentRevision);
    expect(next.revision).toBeGreaterThan(draft.revision);
  });
});

describe("selection", () => {
  it("does not change the content revision", () => {
    const draft = createComposerDraft("hello world");
    const selected = withDraftSelection(draft, { start: 6, end: 5 });

    expect(selected.revision).toBe(draft.revision);
    expect(selected.attachmentRevision).toBe(draft.attachmentRevision);
    expect(selected.selection).toEqual({ start: 5, end: 6 });
  });

  it("clamps to the text and is a no-op when unchanged", () => {
    const draft = createComposerDraft("abc");
    const clamped = withDraftSelection(draft, { start: -4, end: 99 });
    expect(clamped.selection).toEqual({ start: 0, end: 3 });
    expect(withDraftSelection(clamped, { start: 0, end: 3 })).toBe(clamped);
  });

  it("leaves a snapshot applicable when only the caret moved", () => {
    const draft = createComposerDraft("hello");
    const snapshot = createDraftSnapshot(draft, "hello");
    const moved = withDraftSelection(draft, { start: 0, end: 0 });
    expect(draftMatchesSnapshot(moved, snapshot)).toBe(true);
  });
});

describe("attachments", () => {
  it("keeps object identity and order when adding", () => {
    const first = image("one");
    const second = image("two");
    const start = createComposerDraft("look");
    const draft = addDraftAttachments(start, [first, second]);

    expect(draft.attachments[0]).toBe(first);
    expect(draft.attachments[1]).toBe(second);
    expect(attachmentIds(draft)).toEqual(["one", "two"]);
    expect(draft.revision).toBeGreaterThan(start.revision);
    expect(draft.attachmentRevision).toBeGreaterThan(start.attachmentRevision);
  });

  it("keeps two copies of the same image as two distinct attachments", () => {
    const draft = addDraftAttachments(createComposerDraft(""), [
      image("shot#1", "shot.png"),
      image("shot#2", "shot.png"),
    ]);

    expect(draft.attachments).toHaveLength(2);
    expect(attachmentIds(draft)).toEqual(["shot#1", "shot#2"]);
    expect(removeDraftAttachment(draft, "shot#1").attachments.map((a) => a.id)).toEqual(["shot#2"]);
  });

  it("ignores an id that is already attached", () => {
    const draft = addDraftAttachments(createComposerDraft(""), [image("one")]);
    expect(addDraftAttachments(draft, [image("one")])).toBe(draft);
  });

  it("bumps the attachment revision only when the identity set changes", () => {
    const withImage = addDraftAttachments(createComposerDraft(""), [image("one")]);
    const typed = withDraftText(withImage, "more text");

    expect(typed.attachmentRevision).toBe(withImage.attachmentRevision);
    expect(typed.revision).toBeGreaterThan(withImage.revision);

    const removed = removeDraftAttachment(typed, "one");
    expect(removed.attachmentRevision).toBeGreaterThan(typed.attachmentRevision);
    expect(removed.revision).toBeGreaterThan(typed.revision);
    expect(removed.attachments).toHaveLength(0);
  });

  it("is a no-op for unknown ids and an already empty list", () => {
    const draft = addDraftAttachments(createComposerDraft(""), [image("one")]);
    expect(removeDraftAttachment(draft, "nope")).toBe(draft);
    const empty = createComposerDraft("");
    expect(clearDraftAttachments(empty)).toBe(empty);
  });

  it("clears every attachment after a send", () => {
    const draft = addDraftAttachments(createComposerDraft(""), [image("one"), image("two")]);
    const cleared = clearDraftAttachments(draft);
    expect(cleared.attachments).toHaveLength(0);
    expect(cleared.attachmentRevision).toBeGreaterThan(draft.attachmentRevision);
  });

  it("snapshots metadata only, never the base64 payload", () => {
    const draft = addDraftAttachments(createComposerDraft("look"), [image("one", "a.png", "AAAA")]);
    const snapshot = createDraftSnapshot(draft, "look");

    expect(snapshot.attachments).toEqual([
      { id: "one", name: "a.png", mimeType: "image/png", bytes: 4 },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("AAAA");
    expect(attachmentViews(draft)[0]).not.toHaveProperty("data");
  });
});

describe("snapshots", () => {
  it("carries the canonical expanded text and the current selection", () => {
    const draft = withDraftSelection(
      addDraftAttachments(createComposerDraft("[paste #1 4 chars]"), [image("one")]),
      { start: 2, end: 4 },
    );
    const snapshot = createDraftSnapshot(draft, "body");

    expect(snapshot.text).toBe("[paste #1 4 chars]");
    expect(snapshot.expandedText).toBe("body");
    expect(snapshot.selection).toEqual({ start: 2, end: 4 });
    expect(snapshot.revision).toBe(draft.revision);
    expect(snapshot.attachmentRevision).toBe(draft.attachmentRevision);
  });

  it("rejects a snapshot after an attachment change", () => {
    const draft = addDraftAttachments(createComposerDraft("look"), [image("one")]);
    const snapshot = createDraftSnapshot(draft, "look");
    const changed = removeDraftAttachment(draft, "one");

    expect(draftMatchesSnapshot(changed, snapshot)).toBe(false);
    expect(
      draftMatchesSnapshot(withDraftAttachments(draft, [image("one"), image("two")]), snapshot),
    ).toBe(false);
    expect(draftMatchesSnapshot(withDraftAttachments(draft, [image("one")]), snapshot)).toBe(true);
  });
});
