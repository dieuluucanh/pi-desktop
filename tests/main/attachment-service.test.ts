import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAttachmentStore,
  type AssetOwner,
  type AttachmentStore,
} from "../../src/attachments/store";
import { crc32 } from "../../src/attachments/crc32";
import { boundedIdentityImageEncoder } from "../support/identity-image-encoder";
import { prepareDirectAttachment } from "../../src/attachments/prepare";
import {
  createAttachmentService,
  type AttachmentServiceDeps,
} from "../../src/main/attachment-service";
import { createNodeAttachmentStoreIo } from "../../src/main/attachment-store-io";
import { ATTACHMENT_LIMITS, type AttachmentImportRequest } from "../../src/shared/attachments";

const roots: string[] = [];
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(
  options: {
    store?: (store: AttachmentStore) => AttachmentStore;
    newId?: () => string;
    prepareDirect?: (store: AttachmentStore) => NonNullable<AttachmentServiceDeps["prepareDirect"]>;
    imageThumbnail?: NonNullable<AttachmentServiceDeps["imageThumbnail"]>;
    evaluateReadiness?: NonNullable<AttachmentServiceDeps["evaluateReadiness"]>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "pi-attachment-service-"));
  roots.push(root);
  const io = createNodeAttachmentStoreIo({ root });
  const initialStore = createAttachmentStore({
    profile: "a".repeat(64),
    io,
    newId: randomUUID,
    now: () => 100,
  });
  const live = new Set(["10:tab-1", "10:tab-2"]);
  let now = 100;
  const store = options.store?.(initialStore) ?? initialStore;
  const deps: AttachmentServiceDeps = {
    store,
    ...(options.prepareDirect ? { prepareDirect: options.prepareDirect(store) } : {}),
    ...(options.imageThumbnail ? { imageThumbnail: options.imageThumbnail } : {}),
    ...(options.evaluateReadiness ? { evaluateReadiness: options.evaluateReadiness } : {}),
    authorize: (senderId, tabId) => live.has(`${senderId}:${tabId}`),
    newId: options.newId ?? randomUUID,
    now: () => now,
    createHash: () => {
      const hash = createHash("sha256");
      return {
        update: (chunk) => {
          hash.update(chunk);
        },
        digest: () => hash.digest("hex"),
      };
    },
  };
  return {
    service: createAttachmentService(deps),
    store,
    live,
    setTime: (value: number) => {
      now = value;
    },
  };
}

describe("attachment service grants", () => {
  it("imports ordered bounded chunks, lists metadata, previews and removes only the owner's snapshot", async () => {
    const { service } = await setup();
    const draft = service.openDraft(10, "tab-1");
    expect(service.openDraft(10, "tab-1")).toEqual(draft);
    const upload = await service.begin(10, {
      draft,
      name: "a.txt",
      mimeType: "text/plain",
      size: 5,
    });
    expect(await service.append(10, draft, upload.token, 0, bytes("he"))).toBe(2);
    expect(await service.append(10, draft, upload.token, 2, bytes("llo"))).toBe(5);
    const asset = await service.commit(10, draft, upload.token);
    expect(asset).toEqual({
      id: upload.attachmentId,
      name: "a.txt",
      mimeType: "text/plain",
      size: 5,
    });
    expect(await service.list(10, draft)).toMatchObject([asset]);
    expect(await service.preview(10, draft, asset.id, 3)).toEqual({
      bytes: bytes("hel"),
      size: 5,
      truncated: true,
      kind: "text",
      mimeType: "text/plain",
    });
    await service.remove(10, draft, asset.id);
    expect(await service.list(10, draft)).toEqual([]);
  });

  it("prepares only selected owner-held originals and releases their representations on remove", async () => {
    const { service, store } = await setup({
      prepareDirect: (attachmentStore) => async (owner: AssetOwner, attachmentId: string) => {
        const result = await prepareDirectAttachment(
          {
            store: attachmentStore,
            encoder: boundedIdentityImageEncoder,
            sha256: async (value) => createHash("sha256").update(value).digest("hex"),
          },
          owner,
          attachmentId,
        );
        return result.status === "ready"
          ? { status: "ready" as const, representationId: result.representation.id }
          : { status: "needs_conversion" as const };
      },
    });
    const draft = service.openDraft(10, "tab-1");
    const upload = await service.begin(10, {
      draft,
      name: "notes.txt",
      mimeType: "text/plain",
      size: 5,
    });
    await service.append(10, draft, upload.token, 0, bytes("hello"));
    const original = await service.commit(10, draft, upload.token);

    const selection = await service.prepareForDelivery(10, draft, [original.id]);
    expect("representationIds" in selection).toBe(true);
    if (!("representationIds" in selection)) throw new Error("expected prepared selection");
    expect(selection.representationIds).toHaveLength(1);
    const assets = await store.list({ kind: "draft", id: draft.draftId });
    expect(assets.map((asset) => asset.kind)).toEqual(["original", "representation"]);
    expect(await service.prepareForDelivery(10, draft, [randomUUID()])).toEqual({
      reasons: ["unavailable"],
    });
    expect(await service.prepareForDelivery(10, draft, [original.id, original.id])).toEqual({
      reasons: ["unavailable"],
    });

    await service.remove(10, draft, original.id);
    expect(await service.list(10, draft)).toEqual([]);
    expect(await store.list({ kind: "draft", id: draft.draftId })).toEqual([]);
  });

  it("fails closed when direct preparation is unavailable or a document needs conversion", async () => {
    const noPipeline = await setup();
    const draft = noPipeline.service.openDraft(10, "tab-1");
    const upload = await noPipeline.service.begin(10, {
      draft,
      name: "notes.txt",
      mimeType: "text/plain",
      size: 1,
    });
    await noPipeline.service.append(10, draft, upload.token, 0, bytes("x"));
    const original = await noPipeline.service.commit(10, draft, upload.token);
    expect(await noPipeline.service.prepareForDelivery(10, draft, [original.id])).toEqual({
      reasons: ["image_pipeline_unsafe"],
    });

    const document = await setup({
      prepareDirect: () => async () => ({ status: "needs_conversion" as const }),
    });
    const documentDraft = document.service.openDraft(10, "tab-1");
    const documentUpload = await document.service.begin(10, {
      draft: documentDraft,
      name: "report.pdf",
      mimeType: "application/pdf",
      size: 1,
    });
    await document.service.append(10, documentDraft, documentUpload.token, 0, bytes("%"));
    const documentOriginal = await document.service.commit(10, documentDraft, documentUpload.token);
    expect(
      await document.service.prepareForDelivery(10, documentDraft, [documentOriginal.id]),
    ).toEqual({ reasons: ["conversion_required"] });
  });

  it("reopens a persisted draft owner with a fresh grant after the main authority resets", async () => {
    const { service } = await setup();
    const draftId = randomUUID();
    const originalGrant = service.openDraft(10, "tab-1", draftId);
    const upload = await service.begin(10, {
      draft: originalGrant,
      name: "saved.txt",
      mimeType: "text/plain",
      size: 4,
    });
    await service.append(10, originalGrant, upload.token, 0, bytes("data"));
    const saved = await service.commit(10, originalGrant, upload.token);
    await service.closeDraft(10, originalGrant);

    const resumedGrant = service.openDraft(10, "tab-1", draftId);
    expect(resumedGrant.draftId).toBe(draftId);
    expect(resumedGrant.token).not.toBe(originalGrant.token);
    expect(await service.list(10, resumedGrant)).toMatchObject([saved]);
  });

  it("issues main-only draft authority only for the authenticated live sender and grant", async () => {
    const { service, live } = await setup();
    const draft = service.openDraft(10, "tab-1");
    const other = service.openDraft(10, "tab-2");
    expect(() => service.authorizeDeliveryDraft(11, draft)).toThrow(/not authorized/);
    expect(() => service.authorizeDeliveryDraft(10, { ...draft, token: randomUUID() })).toThrow();
    expect(() => service.authorizeDeliveryDraft(10, { ...draft, tabId: other.tabId })).toThrow();
    const scope = service.authorizeDeliveryDraft(10, draft);
    expect(scope.owner).toEqual({ kind: "draft", id: draft.token });
    expect(scope.tabId).toBe("tab-1");
    expect(Object.isFrozen(scope.owner)).toBe(true);
    expect(scope.isCurrent()).toBe(true);
    live.delete("10:tab-1");
    expect(scope.isCurrent()).toBe(false);
    live.add("10:tab-1");
    expect(scope.isCurrent()).toBe(false);
    const replacement = service.authorizeDeliveryDraft(10, draft);
    await service.closeDraft(10, draft);
    expect(replacement.isCurrent()).toBe(false);
    const reopened = service.openDraft(10, "tab-1");
    expect(reopened.token).not.toBe(draft.token);
    expect(replacement.isCurrent()).toBe(false);
  });

  it("refuses known media, legacy Office, macro and archive formats before staging", async () => {
    const { service } = await setup();
    const draft = service.openDraft(10, "tab-1");
    for (const [name, mimeType] of [
      ["recording.MP3", "application/octet-stream"],
      ["clip.mp4", "video/mp4"],
      ["book.xlsm", "application/octet-stream"],
      ["old.doc", "application/octet-stream"],
      ["archive.zip", "application/octet-stream"],
      ["plain.txt", "audio/wav"],
    ] as const) {
      await expect(service.begin(10, { draft, name, mimeType, size: 1 })).rejects.toMatchObject({
        code: "unsupported_format",
      });
    }
    // Unknown and extensionless files still require later byte validation.
    const accepted = await service.begin(10, {
      draft,
      name: "zip",
      mimeType: "application/octet-stream",
      size: 1,
    });
    await service.cancel(10, draft, accepted.token);
  });

  it("rejects forged senders, tabs, draft tokens, import tokens and extra fields", async () => {
    const { service } = await setup();
    expect(() => service.openDraft(11, "tab-1")).toThrow(/not authorized/);
    expect(() => service.openDraft(10, "unknown")).toThrow(/not authorized/);
    const draft = service.openDraft(10, "tab-1");
    const other = service.openDraft(10, "tab-2");
    const upload = await service.begin(10, { draft, name: "a", mimeType: "text/plain", size: 1 });
    await expect(service.append(10, other, upload.token, 0, bytes("a"))).rejects.toThrow(
      /not authorized/,
    );
    await expect(service.list(11, draft)).rejects.toThrow(/not authorized/);
    await expect(service.list(10, { ...draft, token: randomUUID() })).rejects.toThrow(
      /not authorized/,
    );
    await expect(
      service.begin(10, {
        draft,
        name: "a",
        mimeType: "text/plain",
        size: 1,
        path: "/etc/passwd",
      } as unknown as AttachmentImportRequest),
    ).rejects.toThrow(/invalid import request/);
    await expect(service.append(10, draft, randomUUID(), 0, bytes("a"))).rejects.toThrow(
      /not authorized/,
    );
    await service.cancel(10, draft, upload.token);
  });

  it("refuses stale offsets, oversized chunks, incomplete commits and replays", async () => {
    const { service } = await setup();
    const draft = service.openDraft(10, "tab-1");
    const upload = await service.begin(10, { draft, name: "a", mimeType: "text/plain", size: 2 });
    await expect(service.commit(10, draft, upload.token)).rejects.toThrow(/incomplete/);
    await expect(service.append(10, draft, upload.token, 1, bytes("a"))).rejects.toThrow(
      /invalid import chunk/,
    );
    await expect(
      service.append(
        10,
        draft,
        upload.token,
        0,
        new Uint8Array(ATTACHMENT_LIMITS.importChunkBytes + 1),
      ),
    ).rejects.toThrow(/invalid import chunk/);
    await service.append(10, draft, upload.token, 0, bytes("a"));
    await expect(service.append(10, draft, upload.token, 0, bytes("a"))).rejects.toThrow(
      /invalid import chunk/,
    );
    await service.append(10, draft, upload.token, 1, bytes("b"));
    await service.commit(10, draft, upload.token);
    await expect(service.commit(10, draft, upload.token)).rejects.toThrow(/not authorized/);
  });

  it("reserves concurrent import slots and reclaims expired grants", async () => {
    const { service, setTime } = await setup();
    const draft = service.openDraft(10, "tab-1");
    const request = { draft, name: "a", mimeType: "text/plain", size: 1 };
    const outcomes = await Promise.allSettled([
      service.begin(10, request),
      service.begin(10, request),
      service.begin(10, request),
    ]);
    expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(2);
    expect(outcomes.filter((value) => value.status === "rejected")).toHaveLength(1);
    setTime(10 * 60_000 + 101);
    expect(await service.begin(10, request)).toHaveProperty("token");
  });

  it("rate-limits tiny chunks without dropping the staged file", async () => {
    const h = await setup({
      store: (store) => ({
        ...store,
        append: async (_id, _owner, offset, chunk) => offset + chunk.length,
      }),
    });
    const draft = h.service.openDraft(10, "tab-1");
    const upload = await h.service.begin(10, {
      draft,
      name: "a",
      mimeType: "text/plain",
      size: ATTACHMENT_LIMITS.importChunksPerMinute + 1,
    });
    for (let i = 0; i < ATTACHMENT_LIMITS.importChunksPerMinute; i++) {
      await h.service.append(10, draft, upload.token, i, bytes("a"));
    }
    await expect(
      h.service.append(
        10,
        draft,
        upload.token,
        ATTACHMENT_LIMITS.importChunksPerMinute,
        bytes("a"),
      ),
    ).rejects.toThrow(/rate limit/);
    h.setTime(60_101);
    await h.service.append(
      10,
      draft,
      upload.token,
      ATTACHMENT_LIMITS.importChunksPerMinute,
      bytes("a"),
    );
    await h.service.cancel(10, draft, upload.token);
  });

  it("copies Buffer chunks before asynchronous storage so caller mutations cannot change them", async () => {
    let release = (): void => {};
    let started = (): void => {};
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await setup({
      store: (store) => ({
        ...store,
        append: async (...args) => {
          started();
          await gate;
          return store.append(...args);
        },
      }),
    });
    const draft = h.service.openDraft(10, "tab-1");
    const upload = await h.service.begin(10, { draft, name: "a", mimeType: "text/plain", size: 1 });
    const original = Buffer.from("a");
    const pending = h.service.append(10, draft, upload.token, 0, original);
    await startedPromise;
    original[0] = 98;
    release();
    await pending;
    const asset = await h.service.commit(10, draft, upload.token);
    expect((await h.service.preview(10, draft, asset.id, 1)).bytes).toEqual(bytes("a"));
  });

  it("cancels an in-flight chunk without committing it", async () => {
    let release = (): void => {};
    let started = (): void => {};
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await setup({
      store: (store) => ({
        ...store,
        append: async (...args) => {
          started();
          await gate;
          return store.append(...args);
        },
      }),
    });
    const draft = h.service.openDraft(10, "tab-1");
    const upload = await h.service.begin(10, { draft, name: "a", mimeType: "text/plain", size: 1 });
    const pending = h.service.append(10, draft, upload.token, 0, bytes("a"));
    await startedPromise;
    const cancelled = h.service.cancel(10, draft, upload.token);
    release();
    await expect(pending).rejects.toThrow(/cancelled/);
    await expect(cancelled).resolves.toBeUndefined();
    expect(await h.service.list(10, draft)).toEqual([]);
    await expect(h.service.commit(10, draft, upload.token)).rejects.toThrow(/not authorized/);
  });

  it("cancels in-flight and idle stages when a tab closes", async () => {
    let release = (): void => {};
    let started = (): void => {};
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await setup({
      store: (store) => ({
        ...store,
        append: async (...args) => {
          started();
          await gate;
          return store.append(...args);
        },
      }),
    });
    const draft = h.service.openDraft(10, "tab-1");
    const first = await h.service.begin(10, { draft, name: "a", mimeType: "text/plain", size: 1 });
    const second = await h.service.begin(10, { draft, name: "b", mimeType: "text/plain", size: 1 });
    const pending = h.service.append(10, draft, first.token, 0, bytes("a"));
    await startedPromise;
    h.live.delete("10:tab-1");
    const cleanup = h.service.reconcileTabs(["tab-2"]);
    release();
    await expect(pending).rejects.toThrow(/cancelled/);
    await cleanup;
    h.live.add("10:tab-1");
    await expect(h.service.commit(10, draft, first.token)).rejects.toThrow(/not authorized/);
    await expect(h.service.commit(10, draft, second.token)).rejects.toThrow(/not authorized/);
    expect(await h.service.list(10, draft)).toEqual([]);
  });

  it("cancels a staged file when its tab becomes unauthorized during a write", async () => {
    let release = (): void => {};
    let started = (): void => {};
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await setup({
      store: (store) => ({
        ...store,
        append: async (...args) => {
          started();
          await gate;
          return store.append(...args);
        },
      }),
    });
    const draft = h.service.openDraft(10, "tab-1");
    const upload = await h.service.begin(10, { draft, name: "a", mimeType: "text/plain", size: 1 });
    const pending = h.service.append(10, draft, upload.token, 0, bytes("a"));
    await startedPromise;
    h.live.delete("10:tab-1");
    release();
    await expect(pending).rejects.toThrow(/not authorized/);
    h.live.add("10:tab-1");
    await expect(h.service.commit(10, draft, upload.token)).rejects.toThrow(/not authorized/);
    expect(await h.service.list(10, draft)).toEqual([]);
  });

  it("poisons a partial write when cleanup fails and only allows cancellation", async () => {
    let failCancel = true;
    const h = await setup({
      store: (store) => ({
        ...store,
        append: async () => {
          throw new Error("partial write");
        },
        cancel: async (...args) => {
          if (failCancel) throw new Error("cleanup failed");
          await store.cancel(...args);
        },
      }),
    });
    const draft = h.service.openDraft(10, "tab-1");
    const upload = await h.service.begin(10, { draft, name: "a", mimeType: "text/plain", size: 1 });
    await expect(h.service.append(10, draft, upload.token, 0, bytes("a"))).rejects.toThrow(
      "partial write",
    );
    await expect(h.service.append(10, draft, upload.token, 0, bytes("a"))).rejects.toThrow(
      /must be cancelled/,
    );
    failCancel = false;
    await h.service.cancel(10, draft, upload.token);
  });

  it("does not reuse a grant token while another begin is waiting on I/O", async () => {
    const first = "123e4567-e89b-42d3-a456-426614174000";
    const repeated = "123e4567-e89b-42d3-b456-426614174001";
    let calls = 0;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await setup({
      newId: () => (calls++ === 0 ? first : repeated),
      store: (store) => ({
        ...store,
        beginOriginal: async (input) => {
          await gate;
          return store.beginOriginal(input);
        },
      }),
    });
    const draft = h.service.openDraft(10, "tab-1");
    const input = { draft, name: "a", mimeType: "text/plain", size: 0 };
    const one = h.service.begin(10, input);
    const two = h.service.begin(10, input);
    await expect(two).rejects.toThrow(/repeated grant/);
    release();
    const upload = await one;
    await h.service.cancel(10, draft, upload.token);
  });
});

function pngChunk(name: string, data: Uint8Array): Buffer {
  const type = Buffer.from(name, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  type.copy(result, 4);
  result.set(data, 8);
  result.writeUInt32BE(crc32(result.subarray(4, 8 + data.length)), 8 + data.length);
  return result;
}

/** Valid 2x2 RGBA PNG, small enough for the identity preparation encoder. */
function pngFixture(): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 6;
  const expanded = new Uint8Array((1 + 2 * 4) * 2);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(expanded)),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

describe("attachment image previews", () => {
  it("prepares an image on preview and serves only the cached prepared thumbnail", async () => {
    const thumbnail = {
      bytes: new Uint8Array([9, 9, 9, 9]),
      mimeType: "image/png",
      width: 2,
      height: 2,
    };
    const imageThumbnail = vi.fn(() => thumbnail);
    const source = pngFixture();
    const { service, store } = await setup({
      imageThumbnail,
      prepareDirect: (attachmentStore) => async (owner, attachmentId, context) => {
        expect(context.tabId).toBe("tab-1");
        const prepared = await prepareDirectAttachment(
          {
            store: attachmentStore,
            encoder: boundedIdentityImageEncoder,
            sha256: async (value) => createHash("sha256").update(value).digest("hex"),
          },
          owner,
          attachmentId,
        );
        return prepared.status === "ready"
          ? { status: "ready" as const, representationId: prepared.representation.id }
          : { status: "needs_conversion" as const };
      },
    });
    const draft = service.openDraft(10, "tab-1");
    const upload = await service.begin(10, {
      draft,
      name: "pixel.png",
      mimeType: "image/png",
      size: source.byteLength,
    });
    await service.append(10, draft, upload.token, 0, source);
    const original = await service.commit(10, draft, upload.token);

    const preview = await service.preview(10, draft, original.id, ATTACHMENT_LIMITS.previewBytes);
    expect(preview).toEqual({
      bytes: thumbnail.bytes,
      size: 4,
      truncated: false,
      kind: "image",
      mimeType: "image/png",
    });
    expect(imageThumbnail).toHaveBeenCalledTimes(1);
    const representation = (await store.list({ kind: "draft", id: draft.draftId })).find(
      (asset) => asset.kind === "representation",
    );
    expect(representation?.preparation?.modality).toBe("image");
    expect(imageThumbnail).toHaveBeenCalledWith(representation?.sha256);

    // A second preview reuses the immutable representation instead of re-encoding.
    await service.preview(10, draft, original.id, ATTACHMENT_LIMITS.previewBytes);
    expect(
      (await store.list({ kind: "draft", id: draft.draftId })).filter(
        (asset) => asset.kind === "representation",
      ),
    ).toHaveLength(1);
  });

  it("refuses an image preview when no validated prepared thumbnail exists", async () => {
    const source = pngFixture();
    const withoutPreparation = await setup();
    const draft = withoutPreparation.service.openDraft(10, "tab-1");
    const upload = await withoutPreparation.service.begin(10, {
      draft,
      name: "pixel.png",
      mimeType: "image/png",
      size: source.byteLength,
    });
    await withoutPreparation.service.append(10, draft, upload.token, 0, source);
    const original = await withoutPreparation.service.commit(10, draft, upload.token);
    await expect(
      withoutPreparation.service.preview(10, draft, original.id, ATTACHMENT_LIMITS.previewBytes),
    ).rejects.toThrow();
  });
});

async function importText(service: Awaited<ReturnType<typeof setup>>["service"]) {
  const draft = service.openDraft(10, "tab-1");
  const upload = await service.begin(10, {
    draft,
    name: "notes.txt",
    mimeType: "text/plain",
    size: 5,
  });
  await service.append(10, draft, upload.token, 0, bytes("hello"));
  const original = await service.commit(10, draft, upload.token);
  return { draft, original };
}

describe("attachment descriptors and readiness", () => {
  it("classifies at import and lists authoritative descriptors", async () => {
    const { service, store } = await setup();
    const { draft, original } = await importText(service);
    const [descriptor] = await service.list(10, draft);
    expect(descriptor).toMatchObject({
      id: original.id,
      name: "notes.txt",
      mimeType: "text/plain",
      originalKind: "text",
      detectedMime: "text/plain",
      status: "ready",
      previewAvailable: true,
      representationId: null,
    });
    const records = await store.list({ kind: "draft", id: draft.draftId });
    expect(records[0]?.classification).toMatchObject({
      version: "desktop-classify-v1",
      kind: "text",
      text: { promptBytes: 5, empty: false },
    });

    const pdfDraft = service.openDraft(10, "tab-2");
    const pdfUpload = await service.begin(10, {
      draft: pdfDraft,
      name: "report.pdf",
      mimeType: "application/pdf",
      size: 9,
    });
    await service.append(10, pdfDraft, pdfUpload.token, 0, bytes("%PDF-1.4\n"));
    await service.commit(10, pdfDraft, pdfUpload.token);
    expect(await service.list(10, pdfDraft)).toMatchObject([
      { originalKind: "pdf", status: "needs_conversion", reason: "conversion_required" },
    ]);
  });

  it("records a mislabeled file as blocked instead of trusting its suffix", async () => {
    const { service } = await setup();
    const draft = service.openDraft(10, "tab-1");
    const upload = await service.begin(10, {
      draft,
      name: "report.pdf",
      mimeType: "application/pdf",
      size: 10,
    });
    await service.append(10, draft, upload.token, 0, bytes("not a pdf!"));
    await service.commit(10, draft, upload.token);
    expect(await service.list(10, draft)).toMatchObject([
      { originalKind: "other", status: "blocked", reason: "format_mismatch" },
    ]);
  });

  it("prepares metadata-only assets and merges the host's per-file verdict", async () => {
    const evaluateReadiness = vi.fn(async (assets) => ({
      ok: true as const,
      verdict: {
        model: { provider: "openai", id: "fixture", api: "openai-completions" },
        revision: "1:7",
        files: assets.map((asset: { id: string }) => ({
          id: asset.id,
          reasons: asset.id === assets[1]?.id ? (["context_limit_exceeded"] as const) : [],
        })),
        reasons: ["context_limit_exceeded"] as const,
        estimatedTokens: 900,
      },
    }));
    const { service } = await setup({
      evaluateReadiness: evaluateReadiness as NonNullable<
        AttachmentServiceDeps["evaluateReadiness"]
      >,
      prepareDirect: (attachmentStore) => async (owner, attachmentId, context) => {
        expect(context).toEqual({ tabId: "tab-1" });
        const prepared = await prepareDirectAttachment(
          {
            store: attachmentStore,
            encoder: boundedIdentityImageEncoder,
            sha256: async (value) => createHash("sha256").update(value).digest("hex"),
          },
          owner,
          attachmentId,
        );
        return prepared.status === "ready"
          ? { status: "ready" as const, representationId: prepared.representation.id }
          : { status: "needs_conversion" as const };
      },
    });
    const { draft, original } = await importText(service);
    const second = await service.begin(10, {
      draft,
      name: "more.txt",
      mimeType: "text/plain",
      size: 5,
    });
    await service.append(10, draft, second.token, 0, bytes("world"));
    const other = await service.commit(10, draft, second.token);

    const readiness = await service.readiness(10, draft, [original.id, other.id], "look");
    expect(readiness).toMatchObject({
      version: 1,
      outcome: "blocked",
      reasons: ["context_limit_exceeded"],
      estimatedTokens: 900,
      model: { provider: "openai", id: "fixture" },
      revision: "1:7",
      files: [
        { id: original.id, status: "ready" },
        { id: other.id, status: "blocked", reasons: ["context_limit_exceeded"] },
      ],
    });
    expect(evaluateReadiness).toHaveBeenCalledTimes(1);
    const [assets] = evaluateReadiness.mock.calls[0] as unknown as [
      Array<Record<string, unknown>>,
      string,
    ];
    // Metadata only: modality/bytes/dimensions, never document or prompt content.
    expect(Object.keys(assets[0] ?? {}).sort()).toEqual(
      ["id", "image", "modality", "originalBytes", "originalKind", "representationBytes"].sort(),
    );
    expect(assets[0]).toMatchObject({ modality: "text", originalKind: "text" });
  });

  it("fails closed for documents and a missing host readiness port", async () => {
    const withoutHost = await setup();
    const { draft } = await importText(withoutHost.service);
    expect(await withoutHost.service.readiness(10, draft, [draft.draftId], "look")).toEqual({
      version: 1,
      outcome: "blocked",
      files: [{ id: draft.draftId, status: "blocked", reasons: ["unavailable"] }],
      reasons: ["unavailable"],
      estimatedTokens: 0,
      model: null,
      revision: "unavailable",
    });
  });
});
