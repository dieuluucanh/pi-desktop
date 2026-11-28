import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createAttachmentPlanner,
  type AttachmentPlanInput,
  type AuthorizedPlanAsset,
} from "../../src/host/attachment-plan";
import { ATTACHMENT_LIMITS } from "../../src/shared/attachments";

const originalId = "123e4567-e89b-42d3-a456-426614174001";
const repId = "123e4567-e89b-42d3-a456-426614174002";
const leaseId = "123e4567-e89b-42d3-a456-426614174003";
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

function fixture() {
  let now = 1000;
  const planner = createAttachmentPlanner({ newId: randomUUID, now: () => now, sha256: digest });
  const asset: AuthorizedPlanAsset = {
    original: {
      id: originalId,
      name: "secret.txt",
      kind: "text",
      bytes: 8,
      sha256: "a".repeat(64),
    },
    representation: {
      id: repId,
      attachmentId: originalId,
      modality: "text",
      origin: "direct",
      bytes: 8,
      originalSha256: "a".repeat(64),
      representationSha256: "b".repeat(64),
      preparationVersion: "desktop-direct-v1",
      approved: true,
      warnings: [],
    },
    image: null,
    approvalDigest: null,
  };
  const input: AttachmentPlanInput = {
    context: {
      profileKey: "c".repeat(64),
      sessionId: "sdk-session",
      sessionEpoch: 1,
      branchId: "leaf",
      revision: "rev-1",
      leaseId,
      idle: true,
      model: { provider: "fake", id: "model-1", api: "openai", input: ["text", "image"] },
      availableContextTokens: 100_000,
      estimatedNewImageTokens: 2_000,
      estimatedExistingRequestBytes: 1_000,
      historyImageCount: 0,
      registeredCommand: false,
    },
    assets: [asset],
    text: "private question",
  };
  const image = (): AuthorizedPlanAsset => ({
    original: { ...asset.original, name: "photo.png", kind: "image", bytes: 256 },
    representation: { ...asset.representation, modality: "image", bytes: 200 },
    image: { mime: "image/png", width: 100, height: 100 },
    approvalDigest: null,
  });
  return {
    planner,
    asset,
    input,
    image,
    setNow(value: number) {
      now = value;
    },
  };
}

function ready(result: ReturnType<ReturnType<typeof createAttachmentPlanner>["plan"]>) {
  if (result.outcome !== "ready") throw new Error(`expected ready: ${result.reasons.join(",")}`);
  return result.plan;
}

describe("host attachment planning", () => {
  it("makes a bounded, content-free plan and consumes it only once", () => {
    const h = fixture();
    const plan = ready(h.planner.plan(h.input));
    expect(plan).toMatchObject({ version: 1, representationIds: [repId], blockingReasons: [] });
    expect(JSON.stringify(plan)).not.toContain("private question");
    expect(JSON.stringify(plan)).not.toContain("secret.txt");
    expect(h.planner.isCurrent(plan.id, h.input)).toBe(true);
    expect(h.planner.consume(plan.id, h.input)).toBe(true);
    expect(h.planner.consume(plan.id, h.input)).toBe(false);
  });

  it("does not bind approval to malformed Unicode that official providers rewrite", () => {
    const h = fixture();
    expect(h.planner.plan({ ...h.input, text: "approved\ud800text" })).toEqual({
      outcome: "blocked",
      reasons: ["unavailable"],
    });
  });

  it("invalidates changes to text, model, session/branch, lease, ownership or provenance", () => {
    const h = fixture();
    const plan = ready(h.planner.plan(h.input));
    const modifications: AttachmentPlanInput[] = [
      { ...h.input, text: "different" },
      { ...h.input, context: { ...h.input.context, sessionId: "other" } },
      { ...h.input, context: { ...h.input.context, sessionEpoch: 2 } },
      { ...h.input, context: { ...h.input.context, branchId: null } },
      { ...h.input, context: { ...h.input.context, profileKey: "d".repeat(64) } },
      { ...h.input, context: { ...h.input.context, revision: "rev-2" } },
      { ...h.input, context: { ...h.input.context, leaseId: randomUUID() } },
      {
        ...h.input,
        context: {
          ...h.input.context,
          model: { provider: "fake", id: "model-2", api: "openai", input: ["text", "image"] },
        },
      },
      {
        ...h.input,
        context: {
          ...h.input.context,
          model: {
            provider: "fake",
            id: "model-1",
            api: "openai",
            input: ["text", "image"],
            inputLimits: { maxRequestBytes: 1000000 },
          },
        },
      },
      {
        ...h.input,
        assets: [{ ...h.asset, original: { ...h.asset.original, name: "renamed.txt" } }],
      },
      {
        ...h.input,
        assets: [
          {
            ...h.asset,
            representation: { ...h.asset.representation, representationSha256: "e".repeat(64) },
          },
        ],
      },
      {
        ...h.input,
        assets: [
          { ...h.asset, representation: { ...h.asset.representation, preparationVersion: "v2" } },
        ],
      },
      {
        ...h.input,
        assets: [
          {
            ...h.asset,
            representation: { ...h.asset.representation, originalSha256: "f".repeat(64) },
          },
        ],
      },
    ];
    for (const modified of modifications)
      expect(h.planner.isCurrent(plan.id, modified)).toBe(false);
    expect(h.planner.isCurrent(plan.id, h.input)).toBe(true);
  });

  it("expires plans, rejects clock rollback and fails closed on invalid IDs/hashes", () => {
    const h = fixture();
    const first = ready(h.planner.plan(h.input));
    h.setNow(999);
    expect(h.planner.isCurrent(first.id, h.input)).toBe(false);
    h.setNow(1000);
    const second = ready(h.planner.plan(h.input));
    h.setNow(61_000);
    expect(h.planner.isCurrent(second.id, h.input)).toBe(false);
    const invalid = createAttachmentPlanner({ newId: () => "../x", now: () => 1, sha256: digest });
    expect(invalid.plan(h.input)).toEqual({ outcome: "blocked", reasons: ["unavailable"] });
    const failingHash = createAttachmentPlanner({
      newId: randomUUID,
      now: () => 1,
      sha256: () => {
        throw new Error("hash failed");
      },
    });
    expect(failingHash.plan(h.input)).toEqual({ outcome: "blocked", reasons: ["unavailable"] });
  });

  it("blocks stale/ineligible sessions, commands and missing context evidence", () => {
    const h = fixture();
    for (const [change, reason] of [
      [{ idle: false }, "busy"],
      [{ registeredCommand: true }, "command_unsupported"],
      [{ historyImageCount: null }, "unavailable"],
      [{ availableContextTokens: null }, "unavailable"],
      [{ leaseId: "forged" }, "unavailable"],
    ] as const) {
      expect(
        h.planner.plan({ ...h.input, context: { ...h.input.context, ...change } }),
      ).toMatchObject({ outcome: "blocked", reasons: expect.arrayContaining([reason]) });
    }
  });

  it("fails closed on unknown model capabilities and rejects images for text-only models, including history", () => {
    const h = fixture();
    const unknown = { ...h.input.context, model: null };
    expect(h.planner.plan({ ...h.input, context: unknown })).toMatchObject({
      outcome: "blocked",
      reasons: expect.arrayContaining(["model_unknown"]),
    });
    const textOnly = {
      ...h.input.context,
      model: { provider: "fake", id: "text", api: "openai", input: ["text"] },
    };
    expect(h.planner.plan({ ...h.input, assets: [h.image()], context: textOnly })).toMatchObject({
      outcome: "blocked",
      reasons: expect.arrayContaining(["model_modality_unsupported"]),
    });
    expect(
      h.planner.plan({ ...h.input, context: { ...textOnly, historyImageCount: 1 } }),
    ).toMatchObject({
      outcome: "blocked",
      reasons: expect.arrayContaining(["model_modality_unsupported"]),
    });
  });

  it("requires conversion approval evidence and never allows native document blocks", () => {
    const h = fixture();
    const pending: AuthorizedPlanAsset = {
      ...h.asset,
      original: { ...h.asset.original, kind: "pdf" },
      representation: { ...h.asset.representation, origin: "converted", approved: false },
      approvalDigest: null,
    };
    expect(h.planner.plan({ ...h.input, assets: [pending] })).toMatchObject({
      outcome: "blocked",
      reasons: expect.arrayContaining(["approval_required"]),
    });
    const forged = { ...pending, representation: { ...pending.representation, approved: true } };
    expect(h.planner.plan({ ...h.input, assets: [forged] })).toMatchObject({
      outcome: "blocked",
      reasons: expect.arrayContaining(["unavailable"]),
    });
    const approved = { ...forged, approvalDigest: "f".repeat(64) };
    expect(h.planner.plan({ ...h.input, assets: [approved] }).outcome).toBe("ready");
    const native = {
      ...approved,
      representation: { ...approved.representation, modality: "document" as const },
    };
    expect(h.planner.plan({ ...h.input, assets: [native] })).toMatchObject({
      outcome: "blocked",
      reasons: expect.arrayContaining(["sdk_document_unsupported"]),
    });
  });

  it("requires a model-aware image token estimate and accounts for it against context", () => {
    const h = fixture();
    expect(
      h.planner.plan({
        ...h.input,
        assets: [h.image()],
        context: { ...h.input.context, estimatedNewImageTokens: null },
      }),
    ).toMatchObject({ outcome: "blocked", reasons: expect.arrayContaining(["unavailable"]) });
    expect(
      h.planner.plan({
        ...h.input,
        assets: [h.image()],
        context: {
          ...h.input.context,
          estimatedNewImageTokens: 3_000,
          availableContextTokens: 2_000,
        },
      }),
    ).toMatchObject({
      outcome: "blocked",
      reasons: expect.arrayContaining(["context_limit_exceeded"]),
    });
    const plan = ready(h.planner.plan({ ...h.input, assets: [h.image()] }));
    expect(plan.estimatedTokens).toBeGreaterThan(2_000);
  });

  it("enforces original, text, context, image count, image byte and request budgets", () => {
    const h = fixture();
    const huge = {
      ...h.asset,
      representation: {
        ...h.asset.representation,
        bytes: ATTACHMENT_LIMITS.promptTextBytesPerFile + 1,
      },
    };
    expect(h.planner.plan({ ...h.input, assets: [huge] })).toMatchObject({
      outcome: "blocked",
      reasons: expect.arrayContaining(["text_limit_exceeded"]),
    });
    expect(
      h.planner.plan({ ...h.input, context: { ...h.input.context, availableContextTokens: 100 } }),
    ).toMatchObject({
      outcome: "blocked",
      reasons: expect.arrayContaining(["context_limit_exceeded"]),
    });
    const oversized = { ...h.image(), image: { mime: "image/png", width: 2000, height: 100 } };
    expect(h.planner.plan({ ...h.input, assets: [oversized] })).toMatchObject({
      outcome: "blocked",
      reasons: expect.arrayContaining(["image_limit_exceeded"]),
    });
    const limitedModel = {
      provider: "fake",
      id: "model",
      api: "openai",
      input: ["text", "image"],
      inputLimits: { images: { maxPerRequest: 1 } },
    };
    expect(
      h.planner.plan({
        ...h.input,
        assets: [h.image()],
        context: { ...h.input.context, model: limitedModel, historyImageCount: 1 },
      }),
    ).toMatchObject({
      outcome: "blocked",
      reasons: expect.arrayContaining(["image_limit_exceeded"]),
    });
    const requestLimited = { ...limitedModel, inputLimits: { maxRequestBytes: 100, images: {} } };
    expect(
      h.planner.plan({ ...h.input, context: { ...h.input.context, model: requestLimited } }),
    ).toMatchObject({
      outcome: "blocked",
      reasons: expect.arrayContaining(["context_limit_exceeded"]),
    });
    expect(
      h.planner.plan({
        ...h.input,
        context: { ...h.input.context, model: requestLimited, estimatedExistingRequestBytes: null },
      }),
    ).toMatchObject({ outcome: "blocked", reasons: expect.arrayContaining(["unavailable"]) });
  });

  it("rejects duplicate, malformed, missing or over-counted records", () => {
    const h = fixture();
    expect(h.planner.plan({ ...h.input, assets: [h.asset, h.asset] })).toMatchObject({
      outcome: "blocked",
      reasons: expect.arrayContaining(["unavailable"]),
    });
    expect(h.planner.plan({ ...h.input, assets: [] })).toMatchObject({
      outcome: "blocked",
      reasons: expect.arrayContaining(["too_many_files"]),
    });
    expect(
      h.planner.plan({ ...h.input, assets: Array.from({ length: 11 }, () => h.asset) }),
    ).toMatchObject({ outcome: "blocked", reasons: expect.arrayContaining(["too_many_files"]) });
    const bad = { ...h.asset, original: { ...h.asset.original, id: "../../etc" } };
    expect(h.planner.plan({ ...h.input, assets: [bad] })).toMatchObject({
      outcome: "blocked",
      reasons: expect.arrayContaining(["unavailable"]),
    });
  });
});
