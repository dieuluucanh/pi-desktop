import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareDirectAttachment } from "../../src/attachments/prepare";
import {
  createAttachmentStore,
  type AssetOwner,
  type AttachmentStore,
} from "../../src/attachments/store";
import {
  openDirectDeliveryReader,
  readDirectDeliveryAsset,
  resolveDirectDeliveryAssets,
} from "../../src/main/attachment-delivery-assets";
import { createNodeAttachmentStoreIo } from "../../src/main/attachment-store-io";
import { ATTACHMENT_LIMITS } from "../../src/shared/attachments";

const PROFILE = "a".repeat(64);
const OWNER: AssetOwner = { kind: "draft", id: "draft-a" };
const OTHER: AssetOwner = { kind: "draft", id: "draft-b" };
const roots: string[] = [];
const encode = (s: string): Uint8Array => new TextEncoder().encode(s);
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const digest = async (bytes: Uint8Array): Promise<string> => sha(bytes);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pi-delivery-assets-"));
  roots.push(root);
  const io = createNodeAttachmentStoreIo({ root });
  const store = createAttachmentStore({ profile: PROFILE, io, newId: randomUUID, now: () => 100 });
  const otherProfile = createAttachmentStore({
    profile: "b".repeat(64),
    io,
    newId: randomUUID,
    now: () => 100,
  });
  const add = async (content: string, name = "notes.txt") => {
    const data = encode(content);
    const id = await store.beginOriginal({
      owner: OWNER,
      name,
      mimeType: "text/plain",
      size: data.length,
    });
    for (let offset = 0; offset < data.length; offset += ATTACHMENT_LIMITS.importChunkBytes)
      await store.append(
        id,
        OWNER,
        offset,
        data.subarray(offset, offset + ATTACHMENT_LIMITS.importChunkBytes),
      );
    const original = await store.commit(id, OWNER, sha(data));
    const prepared = await prepareDirectAttachment(
      { store, encoder: { prepare: async () => null }, sha256: digest },
      OWNER,
      id,
    );
    if (prepared.status !== "ready") throw new Error("expected direct representation");
    return { original, prepared };
  };
  return { root, store, otherProfile, add };
}

describe("main-only direct delivery asset resolution", () => {
  it("projects real prepared assets in order and reads exact independently verified bytes", async () => {
    const h = await setup();
    const a = await h.add("first", 'a".txt');
    const b = await h.add("\ufeffsecond", "b.txt");
    const assets = await resolveDirectDeliveryAssets(h.store, OWNER, [
      b.prepared.asset.id,
      a.prepared.asset.id,
    ]);
    expect(assets.map((asset) => asset.original.id)).toEqual([b.original.id, a.original.id]);
    expect(assets[1]).toEqual({
      original: {
        id: a.original.id,
        name: a.original.name,
        kind: "text",
        bytes: 5,
        sha256: a.original.sha256,
      },
      representation: a.prepared.representation,
      image: null,
      approvalDigest: null,
    });
    expect(await readDirectDeliveryAsset(h.store, OWNER, assets[1]!, digest)).toEqual(
      encode("first"),
    );
    const bytes = await readDirectDeliveryAsset(h.store, OWNER, assets[0]!, digest);
    expect(bytes).toEqual(encode("second"));
    bytes[0] = 0;
    expect(await readDirectDeliveryAsset(h.store, OWNER, assets[0]!, digest)).toEqual(
      encode("second"),
    );
  });

  it("rejects guessed IDs, another owner/profile, duplicates and unprepared records", async () => {
    const h = await setup();
    const a = await h.add("text");
    const id = a.prepared.asset.id;
    for (const [store, owner, ids] of [
      [h.store, OTHER, [id]],
      [h.otherProfile, OWNER, [id]],
      [h.store, OWNER, [randomUUID()]],
      [h.store, OWNER, ["../outside"]],
      [h.store, OWNER, [id, id]],
      [h.store, OWNER, [a.original.id]],
      [h.store, OWNER, []],
    ] as const) {
      await expect(resolveDirectDeliveryAssets(store, owner, ids)).rejects.toMatchObject({
        code: "unavailable",
      });
    }
    const unpreparedId = await h.store.beginRepresentation({
      owner: OWNER,
      name: "notes.txt",
      mimeType: "text/plain",
      size: 1,
      originalId: a.original.id,
      originalSha256: a.original.sha256,
    });
    await h.store.append(unpreparedId, OWNER, 0, encode("x"));
    await h.store.commit(unpreparedId, OWNER, sha(encode("x")));
    await expect(resolveDirectDeliveryAssets(h.store, OWNER, [unpreparedId])).rejects.toMatchObject(
      { code: "unavailable" },
    );
  });

  it("rejects forged records, corrupted returned bytes and digests independently of the store port", async () => {
    const h = await setup();
    const a = await h.add("hello");
    const [asset] = await resolveDirectDeliveryAssets(h.store, OWNER, [a.prepared.asset.id]);
    if (!asset) throw new Error("missing asset");
    await expect(
      readDirectDeliveryAsset(
        h.store,
        OWNER,
        {
          ...asset,
          representation: { ...asset.representation, representationSha256: "c".repeat(64) },
        },
        digest,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    const corrupt: AttachmentStore = {
      ...h.store,
      readForPreparation: async (...args) => ({
        ...(await h.store.readForPreparation(...args)),
        bytes: encode("wrong"),
      }),
    };
    await expect(readDirectDeliveryAsset(corrupt, OWNER, asset, digest)).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(
      readDirectDeliveryAsset(h.store, OWNER, asset, async () => "forged"),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("fails if ownership disappears during the read or hashing and preserves manifest corruption", async () => {
    const h = await setup();
    const a = await h.add("hello");
    const [asset] = await resolveDirectDeliveryAssets(h.store, OWNER, [a.prepared.asset.id]);
    if (!asset) throw new Error("missing asset");
    const hasher = vi.fn(async (data: Uint8Array) => {
      await h.store.releaseOwner(a.prepared.asset.id, OWNER);
      return sha(data);
    });
    await expect(readDirectDeliveryAsset(h.store, OWNER, asset, hasher)).rejects.toMatchObject({
      code: "unavailable",
    });
    const manifest = join(h.root, "v1", PROFILE, "manifest.json");
    await writeFile(manifest, "not json");
    await expect(
      resolveDirectDeliveryAssets(h.store, OWNER, [a.prepared.asset.id]),
    ).rejects.toMatchObject({ code: "corrupt_manifest" });
  });

  it("serves bounded ordered chunks without exposing mutable cached bytes", async () => {
    const h = await setup();
    const empty = await h.add("");
    const a = await h.add("hello");
    const reader = await openDirectDeliveryReader({
      store: h.store,
      owner: OWNER,
      representationIds: [empty.prepared.asset.id, a.prepared.asset.id],
      leaseCurrent: async () => true,
      sha256: digest,
    });
    const projection = reader.assets;
    (projection[1]!.representation.warnings as string[]).push("forged");
    expect(reader.assets[1]!.representation.warnings).not.toContain("forged");
    expect(await reader.readChunk(a.prepared.asset.id, 0, 2)).toEqual(encode("he"));
    expect(await reader.readChunk(a.prepared.asset.id, 2, 3)).toEqual(encode("llo"));
    expect(await reader.isCurrent()).toBe(true);
    reader.close();
    expect(await reader.isCurrent()).toBe(false);
    await expect(reader.readChunk(a.prepared.asset.id, 0, 1)).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("permanently revokes a reader on stale lease, lost ownership or invalid offsets", async () => {
    const h = await setup();
    const a = await h.add("hello");
    let live = true;
    const options = {
      store: h.store,
      owner: OWNER,
      representationIds: [a.prepared.asset.id],
      leaseCurrent: async () => live,
      sha256: digest,
    };
    const stale = await openDirectDeliveryReader(options);
    live = false;
    expect(await stale.isCurrent()).toBe(false);
    live = true;
    expect(await stale.isCurrent()).toBe(false);
    const invalid = await openDirectDeliveryReader(options);
    await expect(invalid.readChunk(a.prepared.asset.id, 1, 1)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(await invalid.isCurrent()).toBe(false);
    const removed = await openDirectDeliveryReader(options);
    expect(await removed.readChunk(a.prepared.asset.id, 0, 2)).toEqual(encode("he"));
    await h.store.releaseOwner(a.prepared.asset.id, OWNER);
    await expect(removed.readChunk(a.prepared.asset.id, 2, 3)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(await removed.isCurrent()).toBe(false);
  });

  it("does not return bytes after the reader is closed during hashing", async () => {
    const h = await setup();
    const a = await h.add("hello");
    let resume = (): void => {};
    let signal = (): void => {};
    const waiting = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const reader = await openDirectDeliveryReader({
      store: h.store,
      owner: OWNER,
      representationIds: [a.prepared.asset.id],
      leaseCurrent: async () => true,
      sha256: async (value) => {
        signal();
        await waiting;
        return sha(value);
      },
    });
    const pending = reader.readChunk(a.prepared.asset.id, 0, 5);
    await entered;
    reader.close();
    resume();
    await expect(pending).rejects.toMatchObject({ code: "unavailable" });
    expect(await reader.isCurrent()).toBe(false);
  });

  it("keeps an empty file distinct and rejects representations over the prompt limit", async () => {
    const h = await setup();
    const empty = await h.add("");
    const [asset] = await resolveDirectDeliveryAssets(h.store, OWNER, [empty.prepared.asset.id]);
    if (!asset) throw new Error("missing asset");
    expect(await readDirectDeliveryAsset(h.store, OWNER, asset, digest)).toEqual(new Uint8Array());
    const large = await h.add("a".repeat(ATTACHMENT_LIMITS.promptTextBytesPerFile + 1));
    await expect(
      resolveDirectDeliveryAssets(h.store, OWNER, [large.prepared.asset.id]),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});
