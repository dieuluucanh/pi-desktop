import { describe, expect, it, vi } from "vitest";
import { createAttachmentDeliverySubmissionService } from "../../src/main/attachment-delivery-submission";
import type { AttachmentDeliveryLease } from "../../src/main/attachment-delivery-leases";
import type { StagedAttachmentTransfer } from "../../src/main/attachment-delivery-transfer";
import type { AttachmentDeliveryPlan, AttachmentPromptResult } from "../../src/shared/attachments";

const id = (n: number): string =>
  `123e4567-e89b-42d3-a456-${String(426614174000 + n).padStart(12, "0")}`;
const turnId = id(1);
const attemptId = id(2);
const planId = id(3);
const representationId = id(4);
const draft = { tabId: "tab-1", draftId: id(6), token: id(5) };
const context = {
  sessionId: "session-1",
  sessionEpoch: 3,
  branchId: "branch-1",
  revision: "revision-1",
  isCurrent: () => true,
};
const plan: AttachmentDeliveryPlan = {
  version: 1,
  id: planId,
  model: { provider: "fake", id: "model", api: "openai-completions" },
  representationIds: [representationId],
  estimatedTokens: 12,
  blockingReasons: [],
};
const input = {
  senderId: 10,
  draft,
  representationIds: [representationId],
  context,
  turnId,
  attemptId,
  text: "review this file",
};
const accepted: AttachmentPromptResult = {
  outcome: "accepted",
  turnId,
  attemptId,
  userEntryId: "user-entry-1",
  associationEntryId: "association-entry-1",
};

function fixture(result: AttachmentPromptResult = accepted) {
  const lease = { close: vi.fn() } as unknown as AttachmentDeliveryLease;
  const staged: StagedAttachmentTransfer = {
    transferId: id(6),
    plan: vi.fn(async () => ({ outcome: "ready" as const, plan })),
    dispatch: vi.fn(async () => result),
    cancel: vi.fn(async () => {}),
  };
  const open = vi.fn(async () => lease);
  const stage = vi.fn(async () => staged);
  const closeDraft = vi.fn(async () => {});
  return {
    service: createAttachmentDeliverySubmissionService({ open, stage, closeDraft }),
    lease,
    staged,
    open,
    stage,
    closeDraft,
  };
}

describe("main-only attachment submission orchestration", () => {
  it("closes only the submitted draft generation after durable acceptance", async () => {
    const h = fixture();
    await expect(h.service.submit({ ...input, explicitRetry: true })).resolves.toEqual(accepted);
    expect(h.open).toHaveBeenCalledWith({
      senderId: input.senderId,
      draft,
      representationIds: [representationId],
      context,
    });
    expect(h.staged.dispatch).toHaveBeenCalledWith({
      planId,
      turnId,
      attemptId,
      text: input.text,
      explicitRetry: true,
    });
    expect(h.closeDraft).toHaveBeenCalledOnce();
    expect(h.closeDraft).toHaveBeenCalledWith(input.senderId, draft);
    expect(h.staged.cancel).toHaveBeenCalledOnce();
  });

  it.each([
    { outcome: "handled", turnId, attemptId },
    { outcome: "uncertain", turnId, attemptId },
    { outcome: "blocked", reasons: ["busy"], turnId, attemptId },
  ] as const)("retains the original draft and files after $outcome", async (result) => {
    const h = fixture(result);
    await expect(h.service.submit(input)).resolves.toEqual(result);
    expect(h.closeDraft).not.toHaveBeenCalled();
    expect(h.staged.cancel).toHaveBeenCalledOnce();
  });

  it("keeps the draft when authoritative planning blocks the send", async () => {
    const h = fixture();
    h.staged.plan = vi.fn(async () => ({
      outcome: "blocked" as const,
      reasons: ["model_unknown"] as const,
    }));
    await expect(h.service.submit(input)).resolves.toEqual({
      outcome: "blocked",
      reasons: ["model_unknown"],
      turnId,
      attemptId,
    });
    expect(h.staged.dispatch).not.toHaveBeenCalled();
    expect(h.closeDraft).not.toHaveBeenCalled();
    expect(h.staged.cancel).toHaveBeenCalledOnce();
  });

  it("records ambiguous dispatch exceptions as uncertain and retains the draft", async () => {
    const h = fixture();
    h.staged.dispatch = vi.fn(async () => {
      throw new Error("transport failure");
    });
    await expect(h.service.submit(input)).resolves.toEqual({
      outcome: "uncertain",
      turnId,
      attemptId,
    });
    expect(h.closeDraft).not.toHaveBeenCalled();
    expect(h.staged.cancel).toHaveBeenCalledOnce();
  });

  it("does not clear a draft when a response carries a different attempt identity", async () => {
    const h = fixture();
    h.staged.dispatch = vi.fn(async () => ({
      outcome: "accepted" as const,
      turnId: id(20),
      attemptId: id(21),
      userEntryId: "user-entry-1",
      associationEntryId: "association-entry-1",
    }));
    await expect(h.service.submit(input)).resolves.toEqual({
      outcome: "uncertain",
      turnId,
      attemptId,
    });
    expect(h.closeDraft).not.toHaveBeenCalled();
    expect(h.staged.cancel).toHaveBeenCalledOnce();
  });

  it("closes an opened lease if host staging fails before dispatch", async () => {
    const h = fixture();
    h.stage.mockRejectedValue(new Error("host unavailable"));
    await expect(h.service.submit(input)).resolves.toEqual({
      outcome: "blocked",
      reasons: ["unavailable"],
      turnId,
      attemptId,
    });
    expect(h.lease.close).toHaveBeenCalledOnce();
    expect(h.closeDraft).not.toHaveBeenCalled();
  });

  it("does not open or clear anything for invalid text or attempt identity", async () => {
    const h = fixture();
    await expect(h.service.submit({ ...input, text: "\ud800" })).resolves.toMatchObject({
      outcome: "blocked",
      reasons: ["unavailable"],
    });
    await expect(
      h.service.submit({ ...input, attemptId: "not-an-id" as typeof attemptId }),
    ).resolves.toMatchObject({
      outcome: "blocked",
      reasons: ["unavailable"],
    });
    expect(h.open).not.toHaveBeenCalled();
    expect(h.closeDraft).not.toHaveBeenCalled();
  });
});
