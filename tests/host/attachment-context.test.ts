import { describe, expect, it } from "vitest";
import {
  createAttachmentPlanInput,
  estimateAttachmentHistory,
} from "../../src/host/attachment-context";
import {
  ATTACHMENT_LIMITS,
  type AttachmentDeliveryScope,
  type AuthorizedAttachmentAsset,
} from "../../src/shared/attachments";

const scope: AttachmentDeliveryScope = {
  authorityId: "123e4567-e89b-42d3-a456-426614174001",
  leaseId: "123e4567-e89b-42d3-a456-426614174002",
  profileKey: "a".repeat(64),
  tabId: "tab-1",
  draftId: "123e4567-e89b-42d3-a456-426614174003",
  hostGeneration: 1,
  processGeneration: 2,
  sessionId: "session-1",
  sessionEpoch: 1,
  branchId: "leaf-1",
  revision: "rev-7",
};
const textAsset: AuthorizedAttachmentAsset = {
  original: { id: scope.draftId, name: "note.txt", kind: "text", bytes: 4, sha256: "a".repeat(64) },
  representation: {
    id: "123e4567-e89b-42d3-a456-426614174004",
    attachmentId: scope.draftId,
    modality: "text",
    origin: "direct",
    bytes: 4,
    originalSha256: "a".repeat(64),
    representationSha256: "b".repeat(64),
    preparationVersion: "direct-v1",
    approved: true,
    warnings: [],
  },
  image: null,
  approvalDigest: null,
};
const imageAsset: AuthorizedAttachmentAsset = {
  original: {
    id: "123e4567-e89b-42d3-a456-426614174005",
    name: "image.png",
    kind: "image",
    bytes: 8,
    sha256: "c".repeat(64),
  },
  representation: {
    id: "123e4567-e89b-42d3-a456-426614174006",
    attachmentId: "123e4567-e89b-42d3-a456-426614174005",
    modality: "image",
    origin: "direct",
    bytes: 8,
    originalSha256: "c".repeat(64),
    representationSha256: "d".repeat(64),
    preparationVersion: "direct-v1",
    approved: true,
    warnings: [],
  },
  image: { mime: "image/png", width: 128, height: 64 },
  approvalDigest: null,
};

describe("host attachment context estimates", () => {
  it("bounds metadata traversal and counts history image blocks", () => {
    expect(
      estimateAttachmentHistory([
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", data: "abcd" },
          ],
        },
        { role: "assistant", content: "answer" },
      ]),
    ).toMatchObject({ imageCount: 1 });
    expect(estimateAttachmentHistory(null)).toEqual({ bytes: null, imageCount: null });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(estimateAttachmentHistory([cyclic])).toEqual({ bytes: null, imageCount: null });
    expect(
      estimateAttachmentHistory(["x".repeat(ATTACHMENT_LIMITS.estimatedRequestBytes)]),
    ).toEqual({ bytes: null, imageCount: null });
  });

  it("reserves context tokens and estimates images conservatively", () => {
    const input = createAttachmentPlanInput({
      scope,
      model: { provider: "openai", id: "vision", api: "openai-completions" },
      idle: true,
      messages: [{ role: "user", content: "prior" }],
      contextTokens: 2_000,
      contextWindow: 20_000,
      assets: [textAsset, imageAsset],
      text: "check",
      registeredCommand: false,
    });
    expect(input.context).toMatchObject({
      profileKey: scope.profileKey,
      sessionId: scope.sessionId,
      sessionEpoch: scope.sessionEpoch,
      branchId: scope.branchId,
      revision: scope.revision,
      leaseId: scope.leaseId,
      availableContextTokens: 13_904,
      estimatedNewImageTokens: 320,
      historyImageCount: 0,
      registeredCommand: false,
    });
    expect(input.context.estimatedExistingRequestBytes).toBeGreaterThan(0);
    expect(input.assets).toEqual([textAsset, imageAsset]);
  });

  it("fails closed for unknown context measurements and oversized image dimensions", () => {
    const input = createAttachmentPlanInput({
      scope,
      model: null,
      idle: true,
      messages: null,
      contextTokens: null,
      contextWindow: null,
      assets: [{ ...imageAsset, image: { ...imageAsset.image!, width: Number.MAX_SAFE_INTEGER } }],
      text: "",
      registeredCommand: false,
    });
    expect(input.context.availableContextTokens).toBeNull();
    expect(input.context.estimatedExistingRequestBytes).toBeNull();
    expect(input.context.historyImageCount).toBeNull();
    expect(input.context.estimatedNewImageTokens).toBeNull();
  });
});
