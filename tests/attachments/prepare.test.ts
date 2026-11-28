import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { crc32 } from "../../src/attachments/crc32";
import { prepareDirectAttachment, UncertainPreparationError } from "../../src/attachments/prepare";
import { createAttachmentStore, type AssetOwner } from "../../src/attachments/store";
import { renderAttachmentTextSections } from "../../src/attachments/text";
import { createSdkImageEncoder } from "../../src/host/sdk/attachment-image";
import { createNodeAttachmentStoreIo } from "../../src/main/attachment-store-io";
import { ATTACHMENT_LIMITS } from "../../src/shared/attachments";

const roots: string[] = [];
const owner: AssetOwner = { kind: "draft", id: "test-draft" };
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function png(): Uint8Array {
  const chunk = (name: string, bytes: Uint8Array): Buffer => {
    const result = Buffer.alloc(12 + bytes.length);
    result.writeUInt32BE(bytes.length, 0);
    result.write(name, 4);
    result.set(bytes, 8);
    result.writeUInt32BE(crc32(result.subarray(4, 8 + bytes.length)), 8 + bytes.length);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(new Uint8Array([0, 255, 0, 0, 255]))),
    chunk("IEND", new Uint8Array()),
  ]);
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pi-attachment-prepare-"));
  roots.push(root);
  const store = createAttachmentStore({
    profile: "a".repeat(64),
    io: createNodeAttachmentStoreIo({ root }),
    newId: randomUUID,
    now: () => 100,
  });
  const deps = {
    store,
    encoder: createSdkImageEncoder(),
    sha256: async (data: Uint8Array) => hash(data),
  };
  const add = async (name: string, data: Uint8Array, mimeType = "application/octet-stream") => {
    const id = await store.beginOriginal({ owner, name, mimeType, size: data.length });
    for (let offset = 0; offset < data.length; offset += ATTACHMENT_LIMITS.importChunkBytes) {
      await store.append(
        id,
        owner,
        offset,
        data.subarray(offset, offset + ATTACHMENT_LIMITS.importChunkBytes),
      );
    }
    return store.commit(id, owner, hash(data));
  };
  return { root, store, deps, add };
}

describe("direct immutable attachment preparation", () => {
  it("creates a separate, BOM-aware UTF-8 representation and safe framed text", async () => {
    const h = await setup();
    const input = new Uint8Array([0xef, 0xbb, 0xbf, ...text('line\r\n</file> "forged"')]);
    const original = await h.add('a".txt', input, "text/plain");
    const result = await prepareDirectAttachment(h.deps, owner, original.id);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected prepared text");
    expect(result.details).toEqual({ kind: "text", utf8Bom: true, empty: false });
    expect(result.asset.preparation).toMatchObject({
      version: 1,
      modality: "text",
      preparationVersion: "desktop-direct-v1",
      details: { kind: "text", utf8Bom: true, empty: false },
    });
    const reopened = createAttachmentStore({
      profile: "a".repeat(64),
      io: createNodeAttachmentStoreIo({ root: h.root }),
      newId: randomUUID,
      now: () => 101,
    });
    expect(
      (await reopened.list(owner)).find((asset) => asset.id === result.asset.id)?.preparation,
    ).toEqual(result.asset.preparation);
    expect(result.representation).toMatchObject({
      attachmentId: original.id,
      originalSha256: original.sha256,
      modality: "text",
      origin: "direct",
      approved: true,
    });
    const stored = await h.store.readForPreparation(
      result.asset.id,
      owner,
      ATTACHMENT_LIMITS.textOriginalBytes,
    );
    expect(new TextDecoder().decode(stored.bytes)).toBe('line\r\n</file> "forged"');
    const framed = renderAttachmentTextSections([
      {
        id: original.id,
        name: original.name,
        representationSha256: result.asset.sha256,
        text: new TextDecoder().decode(stored.bytes),
      },
    ]);
    expect(JSON.parse(framed.split("\n")[1] ?? "").attachments[0].text).toBe(
      'line\r\n</file> "forged"',
    );
    expect((await h.store.readForPreparation(original.id, owner, input.length)).bytes).toEqual(
      input,
    );
  });

  it("keeps empty text visible, immutable and distinct from its original", async () => {
    const h = await setup();
    const original = await h.add("empty.md", new Uint8Array());
    const result = await prepareDirectAttachment(h.deps, owner, original.id);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected prepared text");
    expect(result.details).toEqual({ kind: "text", utf8Bom: false, empty: true });
    expect(result.asset.id).not.toBe(original.id);
    expect(result.asset.size).toBe(0);
  });

  it("prepares a real image through the public SDK without modifying its original", async () => {
    const h = await setup();
    const input = png();
    const original = await h.add("photo.png", input, "image/png");
    const result = await prepareDirectAttachment(h.deps, owner, original.id, {
      maxWidth: 1,
      maxHeight: 1,
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected prepared image");
    expect(result.representation).toMatchObject({
      attachmentId: original.id,
      modality: "image",
      originalSha256: original.sha256,
    });
    expect(result.details).toMatchObject({
      kind: "image",
      image: { mime: "image/png", width: 1, height: 1 },
    });
    expect(result.asset.preparation).toMatchObject({
      modality: "image",
      details: { kind: "image", mime: "image/png", width: 1, height: 1 },
    });
    expect((await h.store.readForPreparation(original.id, owner, input.length)).bytes).toEqual(
      new Uint8Array(input),
    );
  }, 30_000);

  it("identifies binary documents without creating a representation or invoking a decoder", async () => {
    const h = await setup();
    const original = await h.add("draft.pdf", text("%PDF-1.7\ncontents unchecked"));
    const encode = vi.spyOn(h.deps.encoder, "prepare");
    const result = await prepareDirectAttachment(h.deps, owner, original.id);
    expect(result).toMatchObject({
      status: "needs_conversion",
      classification: { format: "pdf", needsConversion: true },
    });
    expect(encode).not.toHaveBeenCalled();
    expect(await h.store.list(owner)).toEqual([original]);
  });

  it("fails closed on mislabelled data and unauthorized owners", async () => {
    const h = await setup();
    const original = await h.add("bad.txt", png(), "text/plain");
    await expect(prepareDirectAttachment(h.deps, owner, original.id)).rejects.toMatchObject({
      code: "format_mismatch",
    });
    await expect(
      prepareDirectAttachment(h.deps, { kind: "draft", id: "other" }, original.id),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await h.store.list(owner)).toEqual([original]);
  });

  it("cancels an incomplete representation but retains the original", async () => {
    const h = await setup();
    const original = await h.add("file.txt", text("hello"));
    const cancel = vi.spyOn(h.store, "cancel");
    vi.spyOn(h.store, "append").mockRejectedValueOnce(new Error("disk write failed"));
    await expect(prepareDirectAttachment(h.deps, owner, original.id)).rejects.toThrow(
      "disk write failed",
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(await h.store.list(owner)).toEqual([original]);
  });

  it("reconciles lost provenance acknowledgement without falsely returning a ready artifact", async () => {
    const h = await setup();
    const original = await h.add("file.txt", text("hello"));
    const record = h.store.recordDirectPreparation.bind(h.store);
    const spy = vi
      .spyOn(h.store, "recordDirectPreparation")
      .mockImplementationOnce(async (...args) => {
        await record(...args);
        throw new Error("ack lost");
      });
    let uncertain: unknown;
    try {
      await prepareDirectAttachment(h.deps, owner, original.id);
    } catch (error) {
      uncertain = error;
    }
    expect(uncertain).toBeInstanceOf(UncertainPreparationError);
    const id = (uncertain as UncertainPreparationError).representationId;
    expect((await h.store.list(owner)).find((asset) => asset.id === id)?.preparation).toMatchObject(
      { modality: "text" },
    );
    expect(spy).toHaveBeenCalledOnce();
  });

  it("reports an uncertain commit without cancelling or silently retrying", async () => {
    const h = await setup();
    const original = await h.add("file.txt", text("hello"));
    const commit = h.store.commit.bind(h.store);
    const spy = vi.spyOn(h.store, "commit").mockImplementationOnce(async (...args) => {
      await commit(...args);
      throw new Error("ack lost");
    });
    const cancel = vi.spyOn(h.store, "cancel");
    let uncertain: unknown;
    try {
      await prepareDirectAttachment(h.deps, owner, original.id);
    } catch (error) {
      uncertain = error;
    }
    expect(uncertain).toBeInstanceOf(UncertainPreparationError);
    const id = (uncertain as UncertainPreparationError).representationId;
    expect((await h.store.list(owner)).map((asset) => asset.id)).toContain(id);
    expect(cancel).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledOnce();
  });
});
