import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  attachmentTransferFrameFits,
  stageAttachmentDelivery,
} from "../../src/main/attachment-delivery-transfer";
import { createAttachmentSubmissionJournal } from "../../src/main/attachment-submission-journal";
import {
  ATTACHMENT_LIMITS,
  type AttachmentDeliveryScope,
  type AuthorizedAttachmentAsset,
} from "../../src/shared/attachments";
import type { AttachmentDeliveryLease } from "../../src/main/attachment-delivery-leases";
import type { SessionHostPin } from "../../src/main/session-service";
import { MAX_FRAME_BYTES } from "../../src/shared/host-protocol";

const id = (last: string): string => `123e4567-e89b-42d3-a456-42661417400${last}`;
const scope: AttachmentDeliveryScope = {
  authorityId: id("1"),
  leaseId: id("4"),
  profileKey: "a".repeat(64),
  tabId: "tab-1",
  draftId: id("2"),
  hostGeneration: 4,
  processGeneration: 8,
  sessionId: "session-1",
  sessionEpoch: 3,
  branchId: null,
  revision: "revision-1",
};

function memoryJournal() {
  let content: string | null = null;
  return createAttachmentSubmissionJournal({
    root: "/test-attachments",
    profileKey: scope.profileKey,
    now: () => 1_000,
    io: {
      readText: async () => content,
      writeAtomic: async (_path, next) => {
        content = next;
      },
    },
  });
}
function fixture(
  size = ATTACHMENT_LIMITS.importChunkBytes + 17,
  modality: "text" | "image" = size > ATTACHMENT_LIMITS.promptTextBytesPerFile ? "image" : "text",
) {
  const source = new Uint8Array(size);
  for (let index = 0; index < source.length; index++) source[index] = index % 251;
  const representation = {
    id: id("3"),
    attachmentId: id("2"),
    modality,
    origin: "direct" as const,
    bytes: size,
    originalSha256: "b".repeat(64),
    representationSha256: "c".repeat(64),
    preparationVersion: "desktop-direct-v1",
    approved: true,
    warnings: [],
  };
  const asset: AuthorizedAttachmentAsset = {
    original: {
      id: id("2"),
      name: modality === "text" ? "note.txt" : "photo.png",
      kind: modality,
      bytes: size,
      sha256: "b".repeat(64),
    },
    representation,
    image: modality === "image" ? { mime: "image/png", width: 1, height: 1 } : null,
    approvalDigest: null,
  };
  const calls: Array<{ method: string; params: unknown }> = [];
  const arrays: Uint8Array[] = [];
  const controller = new AbortController();
  let authorized = true;
  const close = vi.fn();
  const pin: SessionHostPin = {
    tabId: "tab-1",
    generation: 4,
    processGeneration: 8,
    sessionId: "session-1",
    sessionEpoch: 3,
    isCurrent: () => true,
    release: () => {},
    request: async (method, params) => {
      calls.push({ method, params });
      return method === "attachments.context"
        ? {
            sessionId: scope.sessionId,
            sessionEpoch: scope.sessionEpoch,
            branchId: scope.branchId,
            revision: scope.revision,
          }
        : {};
    },
  };
  const lease: AttachmentDeliveryLease = {
    hostPin: pin,
    id: id("4"),
    scope,
    expiresAt: Date.now() + 20_000,
    signal: controller.signal,
    assets: [asset],
    authorized: () => authorized,
    isCurrent: async () => authorized,
    close,
    readChunk: async (_representationId, offset, length) => {
      const bytes = source.slice(offset, offset + length);
      arrays.push(bytes);
      return bytes;
    },
  };
  return {
    source,
    calls,
    arrays,
    close,
    pin,
    lease,
    journal: memoryJournal(),
    abortLease: () => controller.abort(),
    revoke: () => {
      authorized = false;
    },
  };
}

function stage(h: ReturnType<typeof fixture>, pin: SessionHostPin = h.pin) {
  return stageAttachmentDelivery({ pin, lease: h.lease, journal: h.journal });
}

describe("private main-to-host attachment staging", () => {
  it("streams ordered bounded chunks, seals and retains the lease until explicit cleanup", async () => {
    const h = fixture();
    const staged = await stage(h);
    expect(staged.transferId).toBe(h.lease.id);
    expect(h.calls.map(({ method }) => method)).toEqual([
      "attachments.context",
      "attachments.transfer.begin",
      "attachments.transfer.chunk",
      "attachments.transfer.chunk",
      "attachments.transfer.seal",
    ]);
    const chunks = h.calls.filter(({ method }) => method === "attachments.transfer.chunk");
    expect(chunks.map(({ params }) => (params as { offset: number }).offset)).toEqual([
      0,
      ATTACHMENT_LIMITS.importChunkBytes,
    ]);
    const transferred = Buffer.concat(
      chunks.map(({ params }) => Buffer.from((params as { encoded: string }).encoded, "base64")),
    );
    expect(transferred).toEqual(Buffer.from(h.source));
    expect(h.arrays.every((bytes) => bytes.every((value) => value === 0))).toBe(true);
    expect(h.close).not.toHaveBeenCalled();
    await staged.cancel();
    await staged.cancel();
    expect(h.calls.at(-1)?.method).toBe("attachments.transfer.cancel");
    expect(h.close).toHaveBeenCalledOnce();
  });

  it("recovers a lost prompt reply from the persisted association and deduplicates replay", async () => {
    const h = fixture(8);
    const turnId = id("6");
    const attemptId = id("7");
    const planId = id("5");
    let promptRequest: {
      planId: string;
      turnId: string;
      attemptId: string;
      text: string;
    } | null = null;
    vi.spyOn(h.pin, "request").mockImplementation(async (method, params) => {
      h.calls.push({ method, params });
      if (method === "attachments.context") {
        return {
          sessionId: scope.sessionId,
          sessionEpoch: scope.sessionEpoch,
          branchId: scope.branchId,
          revision: scope.revision,
        };
      }
      if (method === "attachments.plan") {
        return {
          outcome: "ready",
          plan: {
            version: 1,
            id: planId,
            model: { provider: "fake", id: "model", api: "openai-completions" },
            representationIds: [h.lease.assets[0]!.representation.id],
            estimatedTokens: 12,
            blockingReasons: [],
          },
        };
      }
      if (method === "attachments.submissions.list") {
        if (!promptRequest) return { version: 1, associations: [] };
        const assets = h.lease.assets;
        return {
          version: 1,
          associations: [
            {
              associationEntryId: "association-entry-1",
              metadata: {
                version: 1,
                planId: promptRequest.planId,
                turnId: promptRequest.turnId,
                attemptId: promptRequest.attemptId,
                scope: h.lease.scope,
                sourceTextSha256: createHash("sha256")
                  .update(promptRequest.text, "utf8")
                  .digest("hex"),
                userEntryId: "user-entry-1",
                textSha256: createHash("sha256").update(promptRequest.text, "utf8").digest("hex"),
                images: assets
                  .filter((asset) => asset.representation.modality === "image")
                  .map((asset) => ({
                    mimeType: asset.image?.mime ?? "image/png",
                    sha256: asset.representation.representationSha256,
                  })),
                representations: assets.map((asset) => ({
                  representationId: asset.representation.id,
                  representationSha256: asset.representation.representationSha256,
                  originalId: asset.original.id,
                  originalSha256: asset.original.sha256,
                  modality: asset.representation.modality,
                })),
                createdAt: 1_000,
              },
            },
          ],
        };
      }
      if (method === "attachments.prompt") {
        promptRequest = params as {
          planId: string;
          turnId: string;
          attemptId: string;
          text: string;
        };
        throw new Error("prompt reply was lost after host dispatch");
      }
      return {};
    });
    const staged = await stage(h);
    const planned = await staged.plan("Review this note");
    expect(planned).toMatchObject({ outcome: "ready", plan: { id: planId } });
    await expect(
      staged.dispatch({ planId, turnId, attemptId, text: "Review this note" }),
    ).resolves.toEqual({
      outcome: "accepted",
      turnId,
      attemptId,
      userEntryId: "user-entry-1",
      associationEntryId: "association-entry-1",
    });
    await expect(
      staged.dispatch({ planId, turnId, attemptId, text: "Review this note" }),
    ).resolves.toEqual({
      outcome: "accepted",
      turnId,
      attemptId,
      userEntryId: "user-entry-1",
      associationEntryId: "association-entry-1",
    });
    expect(h.close).not.toHaveBeenCalled();
    expect(h.calls.filter(({ method }) => method === "attachments.prompt")).toHaveLength(1);
    expect(h.calls.at(-1)?.method).toBe("attachments.submissions.list");
    await staged.cancel();
    expect(h.close).toHaveBeenCalledOnce();
  });

  it("treats a prompt timeout as uncertain and never retries the dispatch", async () => {
    const h = fixture(8);
    const turnId = id("6");
    const attemptId = id("7");
    const planId = id("5");
    const request = vi.spyOn(h.pin, "request").mockImplementation(async (method, params) => {
      h.calls.push({ method, params });
      if (method === "attachments.context") {
        return {
          sessionId: scope.sessionId,
          sessionEpoch: scope.sessionEpoch,
          branchId: scope.branchId,
          revision: scope.revision,
        };
      }
      if (method === "attachments.plan") {
        return {
          outcome: "ready",
          plan: {
            version: 1,
            id: planId,
            model: { provider: "fake", id: "model", api: "openai-completions" },
            representationIds: [h.lease.assets[0]!.representation.id],
            estimatedTokens: 12,
            blockingReasons: [],
          },
        };
      }
      if (method === "attachments.prompt") throw new Error("timeout");
      if (method === "attachments.submissions.list") return { version: 1, associations: [] };
      return {};
    });
    const staged = await stage(h);
    await staged.plan("Review this note");
    await expect(
      staged.dispatch({ planId, turnId, attemptId, text: "Review this note" }),
    ).resolves.toEqual({ outcome: "uncertain", turnId, attemptId });
    expect(request.mock.calls.filter(([method]) => method === "attachments.prompt")).toHaveLength(
      1,
    );
    await staged.cancel();
  });

  it("cancels host staging when the authoritative lease is revoked", async () => {
    const h = fixture(8);
    const staged = await stage(h);
    h.abortLease();
    await staged.cancel();
    expect(h.calls.at(-1)?.method).toBe("attachments.transfer.cancel");
    expect(h.close).toHaveBeenCalledOnce();
  });

  it("checks the hard host-frame bound and fails closed on non-serializable frames", () => {
    expect(attachmentTransferFrameFits("attachments.transfer.chunk", { encoded: "YQ==" })).toBe(
      true,
    );
    expect(
      attachmentTransferFrameFits("attachments.transfer.begin", {
        padding: "x".repeat(MAX_FRAME_BYTES),
      }),
    ).toBe(false);
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(attachmentTransferFrameFits("attachments.transfer.begin", circular)).toBe(false);
  });

  it("rejects a host branch/revision mismatch before staging any attachment bytes", async () => {
    const h = fixture(8);
    vi.spyOn(h.pin, "request").mockImplementation(async (method, params) => {
      h.calls.push({ method, params });
      return method === "attachments.context"
        ? {
            sessionId: scope.sessionId,
            sessionEpoch: scope.sessionEpoch,
            branchId: scope.branchId,
            revision: "stale-revision",
          }
        : {};
    });
    await expect(stage(h)).rejects.toThrow(/unavailable/);
    expect(h.calls.map(({ method }) => method)).toEqual(["attachments.context"]);
    expect(h.close).toHaveBeenCalledOnce();
  });

  it("rejects a valid but unrelated host pin without sending the lease to that host", async () => {
    const h = fixture(8);
    const wrongHost = { ...h.pin, tabId: "another-tab" };
    await expect(stage(h, wrongHost)).rejects.toThrow(/unavailable/);
    expect(h.calls).toEqual([]);
    expect(h.close).toHaveBeenCalledOnce();
  });

  it("attempts cancellation when begin times out after the host may have consumed it", async () => {
    const h = fixture(8);
    vi.spyOn(h.pin, "request").mockImplementation(async (method, params) => {
      h.calls.push({ method, params });
      if (method === "attachments.context") {
        return {
          sessionId: scope.sessionId,
          sessionEpoch: scope.sessionEpoch,
          branchId: scope.branchId,
          revision: scope.revision,
        };
      }
      if (method === "attachments.transfer.begin") throw new Error("request timed out");
      return {};
    });
    await expect(stage(h)).rejects.toThrow(/unavailable/);
    expect(h.calls.map(({ method }) => method)).toEqual([
      "attachments.context",
      "attachments.transfer.begin",
      "attachments.transfer.cancel",
    ]);
    expect(h.close).toHaveBeenCalledOnce();
  });

  it("shares concurrent cancellation and waits for host cleanup before releasing the lease", async () => {
    const h = fixture(8);
    const staged = await stage(h);
    let finish = (_value: unknown): void => {};
    const pending = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(h.pin, "request").mockImplementation(async (method) => {
      if (method === "attachments.transfer.cancel") return pending;
      return {};
    });
    const first = staged.cancel();
    const second = staged.cancel();
    expect(first).toBe(second);
    expect(h.close).not.toHaveBeenCalled();
    finish({ cancelled: true });
    await Promise.all([first, second]);
    expect(h.close).toHaveBeenCalledOnce();
  });

  it("cancels after a failed chunk, zeroes its temporary bytes, and never attempts later chunks", async () => {
    const h = fixture();
    vi.spyOn(h.pin, "request").mockImplementation(async (method, params) => {
      h.calls.push({ method, params });
      if (method === "attachments.context") {
        return {
          sessionId: scope.sessionId,
          sessionEpoch: scope.sessionEpoch,
          branchId: scope.branchId,
          revision: scope.revision,
        };
      }
      if (method === "attachments.transfer.chunk") throw new Error("host request timed out");
      return {};
    });
    await expect(stage(h)).rejects.toThrow(/unavailable/);
    expect(h.calls.map(({ method }) => method)).toEqual([
      "attachments.context",
      "attachments.transfer.begin",
      "attachments.transfer.chunk",
      "attachments.transfer.cancel",
    ]);
    expect(h.arrays).toHaveLength(1);
    expect(h.arrays[0]?.every((value) => value === 0)).toBe(true);
    expect(h.close).toHaveBeenCalledOnce();
  });

  it("fails closed on lease revocation between bounded chunks and still cleans up", async () => {
    const h = fixture();
    let reads = 0;
    vi.spyOn(h.lease, "readChunk").mockImplementation(async (_id, offset, length) => {
      reads++;
      const chunk = h.source.slice(offset, offset + length);
      h.arrays.push(chunk);
      if (reads === 1) h.revoke();
      return chunk;
    });
    await expect(stage(h)).rejects.toThrow(/unavailable/);
    expect(h.calls.map(({ method }) => method)).toEqual([
      "attachments.context",
      "attachments.transfer.begin",
      "attachments.transfer.cancel",
    ]);
    expect(h.arrays[0]?.every((value) => value === 0)).toBe(true);
    expect(h.close).toHaveBeenCalledOnce();
  });

  it("rejects oversized metadata before the private channel and closes the lease", async () => {
    const h = fixture(1);
    const tooLarge = {
      ...h.lease.assets[0]!,
      representation: {
        ...h.lease.assets[0]!.representation,
        bytes: ATTACHMENT_LIMITS.estimatedRequestBytes + 1,
      },
    };
    Object.defineProperty(h.lease, "assets", { value: [tooLarge] });
    await expect(stage(h)).rejects.toThrow(/unavailable/);
    expect(h.calls).toHaveLength(0);
    expect(h.close).toHaveBeenCalledOnce();
  });
});
