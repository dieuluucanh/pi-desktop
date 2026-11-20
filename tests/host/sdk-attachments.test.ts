import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  AttachmentDeliveryScope,
  AuthorizedAttachmentAsset,
} from "../../src/shared/attachments";
import {
  dispatchSdkAttachments,
  type SdkAttachmentDispatch,
  type SdkAttachmentSession,
} from "../../src/host/sdk/attachments";

const opaque = (n: number): string =>
  `123e4567-e89b-42d3-a456-${String(426614174000 + n).padStart(12, "0")}`;
const turnId = opaque(1);
const attemptId = opaque(2);
const sessionId = "sdk-test-session";
const gif = Uint8Array.from(
  Buffer.from("R0lGODdhAQABAIEAAP8AAAAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==", "base64"),
);
const gifDigest = createHash("sha256").update(gif).digest("hex");
const acceptedResult = {
  outcome: "accepted" as const,
  turnId,
  attemptId,
  userEntryId: "user-1",
  associationEntryId: "custom-2",
};
const handledResult = { outcome: "handled" as const, turnId, attemptId };
const uncertainResult = { outcome: "uncertain" as const, turnId, attemptId };
const blockedResult = (reason: string) => ({
  outcome: "blocked" as const,
  reasons: [reason],
  turnId,
  attemptId,
});
const scope: AttachmentDeliveryScope = {
  authorityId: opaque(3),
  leaseId: opaque(4),
  profileKey: "a".repeat(64),
  tabId: "test-tab",
  draftId: opaque(5),
  hostGeneration: 1,
  processGeneration: 1,
  sessionId,
  sessionEpoch: 1,
  branchId: null,
  revision: "test-revision",
};

function imageAsset(index: number, bytes: Uint8Array = gif): AuthorizedAttachmentAsset {
  const digest = createHash("sha256").update(bytes).digest("hex");
  const originalId = opaque(20 + index * 2);
  const representationId = opaque(21 + index * 2);
  return {
    original: {
      id: originalId,
      name: `image-${index}.gif`,
      kind: "image",
      bytes: bytes.length,
      sha256: digest,
    },
    representation: {
      id: representationId,
      attachmentId: originalId,
      modality: "image",
      origin: "direct",
      bytes: bytes.length,
      originalSha256: digest,
      representationSha256: digest,
      preparationVersion: "test-v1",
      approved: true,
      warnings: [],
    },
    image: { mime: "image/gif", width: 1, height: 1 },
    approvalDigest: null,
  };
}

function textAsset(): AuthorizedAttachmentAsset {
  const bytes = new TextEncoder().encode("x");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const originalId = opaque(40);
  return {
    original: {
      id: originalId,
      name: "note.txt",
      kind: "text",
      bytes: bytes.length,
      sha256: digest,
    },
    representation: {
      id: opaque(41),
      attachmentId: originalId,
      modality: "text",
      origin: "direct",
      bytes: bytes.length,
      originalSha256: digest,
      representationSha256: digest,
      preparationVersion: "test-v1",
      approved: true,
      warnings: [],
    },
    image: null,
    approvalDigest: null,
  };
}

function fixture(disposition: "started" | "handled" | "queued" | "missing" = "started") {
  let autoResize = false;
  let blockImages = false;
  let nextEntry = 0;
  const entries: unknown[] = [];
  const listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
  const emit = (event: { type: string; [key: string]: unknown }): void => {
    for (const listener of listeners) listener(event);
  };
  const model = {
    provider: "fake",
    id: "model",
    api: "openai-completions",
    input: ["text", "image"],
  };
  const sessionManager = {
    getEntryCount: () => entries.length,
    getEntries: () => [...entries],
    getSessionId: () => sessionId,
    isPersisted: () => entries.some((entry) => (entry as { type?: string }).type === "message"),
    appendCustomEntry: (customType: string, data: unknown) => {
      const id = `custom-${++nextEntry}`;
      entries.push({ type: "custom", customType, data, id });
      return id;
    },
  };
  const prompt = vi.fn(
    async (
      text: string,
      options: {
        preflightResult?: (result: "started" | "handled" | "queued") => void;
        images?: Array<{ type: "image"; mimeType: string; data: string }>;
      },
    ) => {
      if (disposition !== "missing") options.preflightResult?.(disposition);
      if (disposition === "started") {
        const message = {
          role: "user",
          content: [{ type: "text", text }, ...(options.images ?? [])],
        };
        emit({ type: "message_end", message });
        entries.push({ type: "message", id: `user-${++nextEntry}`, message });
      }
    },
  );
  const session = {
    model,
    isIdle: true,
    hasExtensionHandlers: vi.fn(() => false),
    agent: { streamFunction: vi.fn(), onPayload: undefined },
    settingsManager: { getImageAutoResize: () => autoResize, getBlockImages: () => blockImages },
    sessionManager,
    subscribe: (listener: (event: { type: string; [key: string]: unknown }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt,
  };
  const input: SdkAttachmentDispatch = {
    session: session as unknown as SdkAttachmentSession,
    turnId,
    attemptId,
    planId: opaque(42),
    sourceTextSha256: createHash("sha256").update("read this").digest("hex"),
    scope,
    assets: [imageAsset(0)],
    expectedModel: { provider: "fake", id: "model", api: "openai-completions" },
    text: "read this",
    images: [{ bytes: gif, mimeType: "image/gif", representationSha256: gifDigest }],
    revalidate: async () => true,
    isCurrent: () => true,
  };
  return {
    input,
    session,
    model,
    prompt,
    entries,
    emit,
    setResize(value: boolean) {
      autoResize = value;
    },
    setBlock(value: boolean) {
      blockImages = value;
    },
  };
}

describe("official SDK attachment dispatch adapter", () => {
  it("sends local validated bytes as an official image block, not paths or custom provider payloads", async () => {
    const h = fixture();
    expect(await dispatchSdkAttachments(h.input)).toEqual(acceptedResult);
    expect(h.prompt).toHaveBeenCalledOnce();
    const [text, options] = h.prompt.mock.calls[0] ?? [];
    expect(text).toBe("read this");
    expect(options).toMatchObject({
      source: "rpc",
      expandPromptTemplates: false,
      images: [{ type: "image", mimeType: "image/gif", data: Buffer.from(gif).toString("base64") }],
    });
  });

  it("waits for delayed SessionManager persistence before accepting a turn", async () => {
    const h = fixture();
    let message: unknown = null;
    h.prompt.mockImplementationOnce(async (text, options) => {
      options.preflightResult?.("started");
      message = {
        role: "user",
        content: [{ type: "text", text }, ...(options.images ?? [])],
      };
      h.emit({ type: "message_end", message });
    });
    const result = await dispatchSdkAttachments({
      ...h.input,
      sleep: async () => {
        h.entries.push({ type: "message", id: "user-delayed", message });
      },
    });
    expect(result).toMatchObject({
      outcome: "accepted",
      userEntryId: "user-delayed",
      associationEntryId: "custom-1",
    });
    expect(h.entries).toHaveLength(2);
  });

  it("creates non-empty text for image-only requests but rejects requests with no content", async () => {
    const h = fixture();
    await expect(dispatchSdkAttachments({ ...h.input, text: "" })).resolves.toEqual(acceptedResult);
    expect(h.prompt.mock.calls[0]?.[0]).toBe("Please consider the attached files.");
    await expect(dispatchSdkAttachments({ ...h.input, text: "", images: [] })).resolves.toEqual(
      blockedResult("unavailable"),
    );
  });

  it("allows Pi's native auto-resize but honours the explicit block-images setting", async () => {
    const h = fixture();
    // autoResize is Pi's default; it must not disable Desktop image delivery.
    h.setResize(true);
    await expect(dispatchSdkAttachments(h.input)).resolves.toEqual(acceptedResult);
    expect(h.prompt).toHaveBeenCalledOnce();
    h.setBlock(true);
    await expect(dispatchSdkAttachments(h.input)).resolves.toEqual(
      blockedResult("image_pipeline_unsafe"),
    );
  });

  it("leaves text-only requests unaffected by image auto-resize settings", async () => {
    const h = fixture();
    h.setResize(true);
    await expect(
      dispatchSdkAttachments({
        ...h.input,
        images: [],
        assets: [textAsset()],
        text: "untrusted file text",
      }),
    ).resolves.toEqual(acceptedResult);
  });

  it("reports handled, queued and missing preflight without falsely claiming delivery", async () => {
    expect(await dispatchSdkAttachments(fixture("handled").input)).toEqual(handledResult);
    expect(await dispatchSdkAttachments(fixture("queued").input)).toEqual(uncertainResult);
    // A missing disposition is ambiguous, never accepted and never a reason to
    // destroy the session.
    expect(await dispatchSdkAttachments(fixture("missing").input)).toEqual(uncertainResult);
  });

  it("blocks busy, stale, incompatible and forged payloads without calling the SDK", async () => {
    const h = fixture();
    h.session.isIdle = false;
    await expect(dispatchSdkAttachments(h.input)).resolves.toEqual(blockedResult("busy"));
    h.session.isIdle = true;
    await expect(
      dispatchSdkAttachments({
        ...h.input,
        expectedModel: { ...h.input.expectedModel, id: "other" },
      }),
    ).resolves.toEqual(blockedResult("stale_plan"));
    h.model.input = ["text"];
    await expect(dispatchSdkAttachments(h.input)).resolves.toEqual(
      blockedResult("model_modality_unsupported"),
    );
    h.model.input = ["text", "image"];
    await expect(
      dispatchSdkAttachments({
        ...h.input,
        images: [{ bytes: gif, mimeType: "image/png", representationSha256: gifDigest }],
      }),
    ).resolves.toEqual(blockedResult("image_limit_exceeded"));
    expect(h.prompt).not.toHaveBeenCalled();
  });

  it("treats trusted extension hooks as native Pi semantics instead of blocking them", async () => {
    const h = fixture();
    const revalidate = vi.fn(async () => true);
    h.session.hasExtensionHandlers.mockReturnValue(true);
    await expect(dispatchSdkAttachments({ ...h.input, revalidate })).resolves.toEqual(
      acceptedResult,
    );
    // The plan is still revalidated/consumed once immediately before SDK use.
    expect(revalidate).toHaveBeenCalledOnce();
    expect(h.prompt).toHaveBeenCalledOnce();
  });

  it("delivers text through any chat API instead of an artificial allowlist", async () => {
    for (const api of [
      "openai-completions",
      "openai-responses",
      "anthropic-messages",
      "google-generative-ai",
      "mistral-conversations",
    ]) {
      const h = fixture();
      h.model.api = api;
      await expect(
        dispatchSdkAttachments({
          ...h.input,
          images: [],
          assets: [textAsset()],
          expectedModel: { ...h.input.expectedModel, api },
          text: "plain text attachment",
        }),
      ).resolves.toEqual(acceptedResult);
      expect(h.prompt).toHaveBeenCalledOnce();
    }
  });

  it("requires fresh lease/plan revalidation immediately before SDK dispatch", async () => {
    const h = fixture();
    await expect(
      dispatchSdkAttachments({ ...h.input, revalidate: async () => false }),
    ).resolves.toEqual(blockedResult("stale_plan"));
    await expect(
      dispatchSdkAttachments({
        ...h.input,
        revalidate: async () => {
          throw new Error("lease unavailable");
        },
      }),
    ).resolves.toEqual(blockedResult("unavailable"));
    expect(h.prompt).not.toHaveBeenCalled();
  });

  it("rechecks model identity and input limits after asynchronous validation", async () => {
    const h = fixture();
    const first = dispatchSdkAttachments(h.input);
    h.model.id = "changed";
    await expect(first).resolves.toEqual(blockedResult("stale_plan"));
    h.model.id = "model";
    const second = dispatchSdkAttachments(h.input);
    h.model.input = ["text"];
    await expect(second).resolves.toEqual(blockedResult("model_modality_unsupported"));
    expect(h.prompt).not.toHaveBeenCalled();
  });

  it("reports uncertainty when SDK hooks change the model or image policy after dispatch begins", async () => {
    const h = fixture();
    h.prompt.mockImplementationOnce(async (_text, options) => {
      h.model.id = "extension-selected-model";
      options.preflightResult?.("started");
    });
    await expect(dispatchSdkAttachments(h.input)).resolves.toEqual(uncertainResult);
    h.model.id = "model";
    h.prompt.mockImplementationOnce(async (_text, options) => {
      h.setResize(true);
      options.preflightResult?.("started");
    });
    await expect(dispatchSdkAttachments(h.input)).resolves.toEqual(uncertainResult);
  });

  it("copies every image before any asynchronous validation can mutate its payload", async () => {
    const h = fixture();
    const first = new Uint8Array(gif);
    const second = new Uint8Array(gif);
    const expected = Buffer.from(second).toString("base64");
    const pending = dispatchSdkAttachments({
      ...h.input,
      images: [
        { bytes: first, mimeType: "image/gif", representationSha256: gifDigest },
        { bytes: second, mimeType: "image/gif", representationSha256: gifDigest },
      ],
      assets: [imageAsset(0, first), imageAsset(1, second)],
    });
    second[0] = 0;
    expect(await pending).toEqual(acceptedResult);
    expect(h.prompt.mock.calls[0]?.[1]).toMatchObject({
      images: [{ data: expected }, { data: expected }],
    });
  });

  it("rejects image bytes changed after materialization, even when the raster remains valid", async () => {
    const h = fixture();
    const modified = new Uint8Array(gif);
    modified[13] = (modified[13] ?? 0) ^ 1;
    await expect(
      dispatchSdkAttachments({
        ...h.input,
        images: [{ bytes: modified, mimeType: "image/gif", representationSha256: gifDigest }],
      }),
    ).resolves.toEqual(blockedResult("image_limit_exceeded"));
    expect(h.prompt).not.toHaveBeenCalled();
  });

  it("retains the draft on transport failure and reports a generic notice", async () => {
    const h = fixture();
    const notice = vi.fn();
    h.prompt.mockImplementationOnce(async (_text, options) => {
      options.preflightResult?.("started");
      throw new Error("sensitive error");
    });
    expect(await dispatchSdkAttachments({ ...h.input, onLateFailure: notice })).toEqual(
      uncertainResult,
    );
    await Promise.resolve();
    expect(notice).toHaveBeenCalledWith();
  });
});
