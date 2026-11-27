import { describe, expect, it } from "vitest";
import {
  addDraftAttachments,
  createComposerDraft,
  createDraftSnapshot,
  removeDraftAttachment,
  withDraftAttachments,
  withDraftSelection,
  withDraftText,
} from "../../src/renderer/src/session/composer-draft";
import {
  DRAFT_APPLY_RECEIPT_LIMIT,
  applyDraftCandidate,
  captureDraftOperation,
  draftApplyReceipt,
  draftOperationInput,
  recordDraftApplyReceipt,
  preservedAttachmentIds,
} from "../../src/renderer/src/session/composer-draft-operation";
import type { ComposerAppliedReceipt } from "../../src/shared/composer-operation";
import type { ImageAttachment } from "../../src/renderer/src/session/image-attachment";

/**
 * Draft-operation capture and CAS application (2026-11-22 prompt-refinement
 * plan step 19).
 *
 * The cases that matter are the ones a live operation can race: a candidate
 * computed against an older capture must never replace newer typing, a host
 * write, an attachment change or an edit-then-revert, and a duplicate
 * completion must not apply twice. Attachments are preserved by identity in the
 * same transition that replaces the text.
 */

function image(id: string, data = "AAAA"): ImageAttachment {
  return { id, name: `${id}.png`, mimeType: "image/png", data };
}

function candidate(
  overrides: Partial<{ operationId: string; candidateRevision: number; text: string }> = {},
) {
  return {
    operationId: "op-1",
    candidateRevision: 7,
    text: "refined prompt",
    ...overrides,
  };
}

function baseOf(draft: ReturnType<typeof createComposerDraft>) {
  return { revision: draft.revision, attachmentRevision: draft.attachmentRevision };
}

function applied(
  draft: ReturnType<typeof createComposerDraft>,
  options: {
    base?: ReturnType<typeof baseOf>;
    receipts?: readonly ComposerAppliedReceipt[];
    candidate?: ReturnType<typeof candidate>;
  } = {},
) {
  return applyDraftCandidate({
    draft,
    base: options.base ?? baseOf(draft),
    candidate: options.candidate ?? candidate(),
    receipts: options.receipts ?? [],
    appliedAt: 1_000,
  });
}

describe("capture", () => {
  it("snapshots the live text, canonical expanded body, selection and ids", () => {
    const draft = withDraftSelection(
      addDraftAttachments(createComposerDraft("[paste #1 4 chars]"), [image("one"), image("two")]),
      { start: 2, end: 4 },
    );

    const captured = captureDraftOperation(draft, "body");
    expect(captured).toEqual(createDraftSnapshot(draft, "body"));
    expect(captured.text).toBe("[paste #1 4 chars]");
    expect(captured.expandedText).toBe("body");
    expect(captured.selection).toEqual({ start: 2, end: 4 });

    const input = draftOperationInput(captured);
    expect(input.attachmentIds).toEqual(["one", "two"]);
    expect(input.revision).toBe(draft.revision);
    expect(input.attachmentRevision).toBe(draft.attachmentRevision);
    // The base64 payload stays in the live record.
    expect(JSON.stringify(input)).not.toContain("AAAA");
  });
});

describe("automatic apply", () => {
  it("replaces the text, keeps every attachment and requests the caret", () => {
    const first = image("one");
    const second = image("two");
    const draft = addDraftAttachments(createComposerDraft("draft prompt"), [first, second]);
    const base = baseOf(draft);

    const outcome = applied(draft, { base });
    expect(outcome.status).toBe("applied");
    if (outcome.status !== "applied") return;

    expect(outcome.draft.text).toBe("refined prompt");
    expect(outcome.draft.revision).toBeGreaterThan(base.revision);
    expect(outcome.draft.attachmentRevision).toBe(base.attachmentRevision);
    expect(outcome.draft.attachments).toEqual([first, second]);
    expect(outcome.draft.attachments[0]).toBe(first);
    expect(preservedAttachmentIds(outcome.draft)).toEqual(["one", "two"]);
    expect(outcome.caret).toBe("refined prompt".length);
    expect(outcome.draft.selection).toEqual({ start: outcome.caret, end: outcome.caret });
    expect(outcome.replacedText).toBe("draft prompt");
    expect(outcome.receipt).toEqual({
      operationId: "op-1",
      appliedRevision: 7,
      disposition: "replaced",
      appliedAt: 1_000,
    });
  });

  it("advances the revision even when the candidate equals the current text", () => {
    const draft = createComposerDraft("same text");
    const outcome = applied(draft, { candidate: candidate({ text: "same text" }) });

    expect(outcome.status).toBe("applied");
    if (outcome.status !== "applied") return;
    expect(outcome.draft.text).toBe("same text");
    expect(outcome.draft.revision).toBeGreaterThan(draft.revision);
  });

  it("refuses a candidate captured before newer typing", () => {
    const captured = createComposerDraft("draft");
    const typed = withDraftText(captured, "draft plus more");

    const outcome = applied(typed, { base: baseOf(captured) });
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") return;
    expect(outcome.reason).toBe("stale-base");
    expect(outcome.draft).toBe(typed);
  });

  it("refuses a candidate captured before a host write", () => {
    const captured = createComposerDraft("draft");
    const restored = withDraftText(captured, "restored from disk");

    const outcome = applied(restored, { base: baseOf(captured) });
    expect(outcome.status === "refused" && outcome.reason).toBe("stale-base");
  });

  it("refuses a candidate captured before an edit-then-revert (ABA)", () => {
    const captured = createComposerDraft("a");
    const edited = withDraftText(captured, "b");
    const reverted = withDraftText(edited, "a");

    const outcome = applied(reverted, { base: baseOf(captured) });
    expect(outcome.status === "refused" && outcome.reason).toBe("stale-base");
  });

  it("refuses every attachment change: add, remove and reorder", () => {
    const draft = addDraftAttachments(createComposerDraft("look"), [image("one"), image("two")]);
    const base = baseOf(draft);

    const added = addDraftAttachments(draft, [image("three")]);
    expect(applied(added, { base }).status === "refused").toBe(true);

    const removed = removeDraftAttachment(draft, "one");
    expect(applied(removed, { base }).status === "refused").toBe(true);

    const reordered = withDraftAttachments(draft, [image("two"), image("one")]);
    expect(applied(reordered, { base }).status === "refused").toBe(true);
  });

  it("does not accept an empty or whitespace-only candidate", () => {
    const draft = createComposerDraft("keep me");
    for (const text of ["", "   ", "\n\t"]) {
      const outcome = applied(draft, { candidate: candidate({ text }) });
      expect(outcome.status === "refused" && outcome.reason).toBe("empty-candidate");
      expect(outcome.draft).toBe(draft);
    }
  });

  it("refuses a malformed candidate without touching the draft", () => {
    const draft = createComposerDraft("keep me");
    for (const malformed of [
      candidate({ operationId: "" }),
      candidate({ candidateRevision: 0 }),
      candidate({ candidateRevision: 1.5 }),
      candidate({ text: 42 as unknown as string }),
    ]) {
      const outcome = applied(draft, { candidate: malformed });
      expect(outcome.status === "refused" && outcome.reason).toBe("invalid-candidate");
      expect(outcome.draft).toBe(draft);
    }
  });
});

describe("receipts", () => {
  it("makes a duplicate completion idempotent and rejects a re-application", () => {
    const draft = createComposerDraft("draft");
    const first = applied(draft);
    expect(first.status).toBe("applied");
    if (first.status !== "applied") return;

    const duplicate = applied(first.draft, {
      receipts: [first.receipt],
      candidate: candidate({ text: "a second replacement" }),
    });
    expect(duplicate.status === "refused" && duplicate.reason).toBe("duplicate");
    expect(duplicate.draft).toBe(first.draft);

    const different = applied(first.draft, {
      receipts: [first.receipt],
      candidate: candidate({ candidateRevision: 8 }),
    });
    expect(different.status === "refused" && different.reason).toBe("already-applied");
  });

  it("records one receipt per operation and keeps the newest bounded set", () => {
    let receipts: ComposerAppliedReceipt[] = [];
    for (let index = 0; index < DRAFT_APPLY_RECEIPT_LIMIT + 4; index += 1) {
      receipts = recordDraftApplyReceipt(receipts, {
        operationId: `op-${index}`,
        appliedRevision: index + 1,
        disposition: "replaced",
        appliedAt: index,
      });
    }

    expect(receipts).toHaveLength(DRAFT_APPLY_RECEIPT_LIMIT);
    expect(receipts[0]?.operationId).toBe("op-4");
    expect(receipts.at(-1)?.operationId).toBe(`op-${DRAFT_APPLY_RECEIPT_LIMIT + 3}`);
    expect(draftApplyReceipt(receipts, "op-0")).toBeUndefined();
    expect(draftApplyReceipt(receipts, "op-5")?.appliedRevision).toBe(6);

    const replaced = recordDraftApplyReceipt(receipts, {
      operationId: "op-5",
      appliedRevision: 99,
      disposition: "replaced",
      appliedAt: 100,
    });
    expect(replaced).toHaveLength(DRAFT_APPLY_RECEIPT_LIMIT);
    expect(draftApplyReceipt(replaced, "op-5")?.appliedRevision).toBe(99);
  });
});
