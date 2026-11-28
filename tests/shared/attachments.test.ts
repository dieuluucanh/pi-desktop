import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_DELIVERY_VERSION,
  ATTACHMENT_LIMITS,
  attachmentBudgetReason,
  attachmentRepresentationReason,
  canTransitionAttachment,
  hostSupportsAttachmentDelivery,
  isAttachmentId,
  isWellFormedAttachmentText,
  resolveAttachmentCapability,
  validateAttachmentPromptRequest,
  type AttachmentBudgetInput,
} from "../../src/shared/attachments";

const PLAN = "123e4567-e89b-42d3-a456-426614174000";
const TURN = "123e4567-e89b-42d3-b456-426614174001";
const ATTEMPT = "123e4567-e89b-42d3-b456-426614174002";
const MODEL = { id: "model", provider: "custom", api: "openai-completions" };

const budget: AttachmentBudgetInput = {
  originalKind: "text",
  originalBytes: 1_000,
  draftOriginalBytes: 2_000,
  fileCount: 2,
  textBytes: 1_000,
  totalTextBytes: 2_000,
  estimatedTokens: 500,
  availableTokens: 1_000,
};

describe("attachment identities and wire contract", () => {
  it("accepts only canonical generated UUID v4 identifiers", () => {
    expect(isAttachmentId(PLAN)).toBe(true);
    for (const value of [
      "../file",
      "C:/secrets",
      PLAN.toUpperCase(),
      "123e4567-e89b-12d3-a456-426614174000",
      "123e4567-e89b-42d3-0456-426614174000",
      "",
      null,
      123,
    ]) {
      expect(isAttachmentId(value), String(value)).toBe(false);
    }
  });

  it("rejects lone surrogates rather than approving text providers will silently sanitize", () => {
    for (const text of ["bad\ud800text", "\udfff", "\ud800\ud800", "\udc00\udc00"]) {
      expect(isWellFormedAttachmentText(text)).toBe(false);
      expect(
        validateAttachmentPromptRequest({
          version: 1,
          planId: PLAN,
          turnId: TURN,
          attemptId: ATTEMPT,
          text,
        }),
      ).toEqual({
        ok: false,
        reason: "bad_request",
      });
    }
    for (const text of ["", "normal", "Tiếng Việt 😀", "\ufefftext", "\ud800\udc00"]) {
      expect(isWellFormedAttachmentText(text)).toBe(true);
    }
  });

  it("validates a reference-only prompt, including an attachment-only turn", () => {
    const request = {
      version: ATTACHMENT_DELIVERY_VERSION,
      planId: PLAN,
      turnId: TURN,
      attemptId: ATTEMPT,
      text: "",
    };
    expect(validateAttachmentPromptRequest(request)).toEqual({ ok: true, value: request });
    expect(validateAttachmentPromptRequest({ ...request, text: "Summarize" }).ok).toBe(true);
  });

  it("rejects missing fields, wrong IDs and extra fields rather than ignoring them", () => {
    const request = { version: 1, planId: PLAN, turnId: TURN, attemptId: ATTEMPT, text: "read" };
    for (const bad of [
      null,
      [],
      {},
      { ...request, planId: "../../other" },
      { ...request, turnId: "name.txt" },
      { ...request, attemptId: "name.txt" },
      { version: 1, planId: PLAN, turnId: TURN, text: "read" },
      { ...request, text: null },
      { ...request, path: "/etc/passwd" },
      { ...request, attachments: [] },
      { ...request, images: [] },
      { ...request, data: "base64" },
    ]) {
      expect(validateAttachmentPromptRequest(bad)).toEqual({ ok: false, reason: "bad_request" });
    }
    expect(validateAttachmentPromptRequest({ ...request, version: 2 })).toEqual({
      ok: false,
      reason: "unsupported_version",
    });
  });

  it("requires an exact delivery version rather than assuming an old host supports it", () => {
    for (const capabilities of [
      undefined,
      null,
      {},
      { attachmentDeliveryVersion: null },
      { attachmentDeliveryVersion: 0 },
      { attachmentDeliveryVersion: 2 },
      { attachmentDeliveryVersion: "1" },
    ]) {
      expect(hostSupportsAttachmentDelivery(capabilities)).toBe(false);
    }
    expect(hostSupportsAttachmentDelivery({ attachmentDeliveryVersion: 1 })).toBe(true);
  });
});

describe("actual model capability", () => {
  it("distinguishes text-only models and image-capable models", () => {
    expect(resolveAttachmentCapability({ ...MODEL, input: ["text"] }, "text")).toMatchObject({
      state: "supported",
      model: MODEL,
      limits: { maxRequestBytes: null, maxImagesPerMessage: null },
    });
    expect(resolveAttachmentCapability({ ...MODEL, input: ["text"] }, "image")).toEqual({
      state: "unsupported",
      reason: "model_modality_unsupported",
    });
    expect(resolveAttachmentCapability({ ...MODEL, input: ["text", "image"] }, "image").state).toBe(
      "supported",
    );
  });

  it("never infers support from a provider or missing custom-model metadata", () => {
    for (const model of [
      null,
      {},
      { ...MODEL },
      { ...MODEL, input: "image" },
      { ...MODEL, input: ["image", "future-modality"] },
      { ...MODEL, input: ["image"], api: "" },
      { ...MODEL, input: ["image"], type: "image" },
    ]) {
      expect(resolveAttachmentCapability(model, "image")).toEqual({
        state: "unknown",
        reason: "model_unknown",
      });
    }
    expect(resolveAttachmentCapability({ ...MODEL, input: [] }, "text").state).toBe("unsupported");
  });

  it("does not advertise native documents even for an image model", () => {
    expect(resolveAttachmentCapability({ ...MODEL, input: ["text", "image"] }, "document")).toEqual(
      {
        state: "unsupported",
        reason: "sdk_document_unsupported",
      },
    );
    expect(resolveAttachmentCapability(null, "document").state).toBe("unsupported");
  });

  it("preserves actual model limits and fails closed for malformed limits", () => {
    const inputLimits = {
      maxRequestBytes: 1_000,
      images: {
        maxPerMessage: 2,
        maxPerRequest: 3,
        resize: { maxBytes: 100, maxWidth: 20, maxHeight: 30 },
      },
    };
    expect(
      resolveAttachmentCapability({ ...MODEL, input: ["image"], inputLimits }, "image"),
    ).toMatchObject({
      state: "supported",
      limits: {
        maxRequestBytes: 1_000,
        maxImagesPerMessage: 2,
        maxImagesPerRequest: 3,
        maxImageBytes: 100,
        maxImageWidth: 20,
        maxImageHeight: 30,
      },
    });
    for (const inputLimits of [
      null,
      { images: null },
      { images: { resize: null } },
      { maxRequestBytes: -1 },
      { images: { maxPerMessage: "2" } },
      { images: { resize: { maxBytes: Infinity } } },
    ]) {
      expect(
        resolveAttachmentCapability({ ...MODEL, input: ["image"], inputLimits }, "image"),
      ).toEqual({
        state: "unknown",
        reason: "model_limits_unknown",
      });
    }
  });
});

describe("representation and budgets", () => {
  it("allows direct text/images but requires approved document conversion", () => {
    expect(
      attachmentRepresentationReason({
        originalKind: "text",
        modality: "text",
        origin: "direct",
        approved: false,
      }),
    ).toBeNull();
    expect(
      attachmentRepresentationReason({
        originalKind: "image",
        modality: "image",
        origin: "direct",
        approved: false,
      }),
    ).toBeNull();
    expect(
      attachmentRepresentationReason({
        originalKind: "pdf",
        modality: "document",
        origin: "direct",
        approved: false,
      }),
    ).toBe("sdk_document_unsupported");
    expect(
      attachmentRepresentationReason({
        originalKind: "spreadsheet",
        modality: "text",
        origin: "direct",
        approved: true,
      }),
    ).toBe("conversion_required");
    expect(
      attachmentRepresentationReason({
        originalKind: "spreadsheet",
        modality: "text",
        origin: "converted",
        approved: false,
      }),
    ).toBe("approval_required");
    expect(
      attachmentRepresentationReason({
        originalKind: "spreadsheet",
        modality: "text",
        origin: "converted",
        approved: true,
      }),
    ).toBeNull();
    expect(
      attachmentRepresentationReason({
        originalKind: "video",
        modality: "text",
        origin: "converted",
        approved: true,
      }),
    ).toBe("format_unsupported");
  });

  it("checks per-file, aggregate, count and context ceilings without truncating", () => {
    expect(attachmentBudgetReason(budget)).toBeNull();
    expect(attachmentBudgetReason({ ...budget, fileCount: 11 })).toBe("too_many_files");
    expect(
      attachmentBudgetReason({
        ...budget,
        draftOriginalBytes: ATTACHMENT_LIMITS.draftOriginalBytes + 1,
      }),
    ).toBe("draft_too_large");
    expect(
      attachmentBudgetReason({
        ...budget,
        originalBytes: ATTACHMENT_LIMITS.textOriginalBytes + 1,
        draftOriginalBytes: ATTACHMENT_LIMITS.textOriginalBytes + 1,
      }),
    ).toBe("original_too_large");
    expect(
      attachmentBudgetReason({
        ...budget,
        textBytes: ATTACHMENT_LIMITS.promptTextBytesPerFile + 1,
        totalTextBytes: ATTACHMENT_LIMITS.promptTextBytesPerFile + 1,
      }),
    ).toBe("text_limit_exceeded");
    expect(
      attachmentBudgetReason({
        ...budget,
        totalTextBytes: ATTACHMENT_LIMITS.promptTextBytesTotal + 1,
      }),
    ).toBe("text_limit_exceeded");
    expect(attachmentBudgetReason({ ...budget, estimatedTokens: 1_001 })).toBe(
      "context_limit_exceeded",
    );
    expect(
      attachmentBudgetReason({ ...budget, estimatedTokens: 32_001, availableTokens: 50_000 }),
    ).toBe("context_limit_exceeded");
  });

  it("fails closed on invalid measurements and accepts exact limits", () => {
    for (const amount of [-1, NaN, Infinity, 1.5]) {
      expect(attachmentBudgetReason({ ...budget, originalBytes: amount })).toBe("invalid_budget");
    }
    expect(attachmentBudgetReason({ ...budget, fileCount: 0 })).toBe("invalid_budget");
    expect(attachmentBudgetReason({ ...budget, originalBytes: 2_001 })).toBe("invalid_budget");
    expect(attachmentBudgetReason({ ...budget, textBytes: 2_001 })).toBe("invalid_budget");
    expect(
      attachmentBudgetReason({
        ...budget,
        originalBytes: ATTACHMENT_LIMITS.textOriginalBytes,
        draftOriginalBytes: ATTACHMENT_LIMITS.textOriginalBytes,
        textBytes: ATTACHMENT_LIMITS.promptTextBytesPerFile,
        totalTextBytes: ATTACHMENT_LIMITS.promptTextBytesPerFile,
        estimatedTokens: 32_000,
        availableTokens: 32_000,
      }),
    ).toBeNull();
  });

  it("defines explicit states and does not resurrect removed or accepted attachments", () => {
    expect(canTransitionAttachment("importing", "classifying")).toBe(true);
    expect(canTransitionAttachment("needs_conversion", "converting")).toBe(true);
    expect(canTransitionAttachment("converting", "awaiting_approval")).toBe(true);
    expect(canTransitionAttachment("awaiting_approval", "ready")).toBe(true);
    expect(canTransitionAttachment("ready", "submitting")).toBe(true);
    expect(canTransitionAttachment("submitting", "retained_for_retry")).toBe(true);
    expect(canTransitionAttachment("removed", "ready")).toBe(false);
    expect(canTransitionAttachment("accepted", "ready")).toBe(false);
    expect(canTransitionAttachment("importing", "accepted")).toBe(false);
  });
});
