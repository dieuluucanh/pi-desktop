import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAttachmentStore, type AssetOwner } from "../../src/attachments/store";
import { createNodeAttachmentStoreIo } from "../../src/main/attachment-store-io";
import { ATTACHMENT_LIMITS } from "../../src/shared/attachments";

const PROFILE = "a".repeat(64);
const OTHER_PROFILE = "b".repeat(64);
const OWNER: AssetOwner = { kind: "draft", id: "tab-1:0" };
const data = (text: string): Uint8Array => new TextEncoder().encode(text);
const digest = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(options: { freeBytes?: () => Promise<number> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-attachment-store-"));
  roots.push(root);
  const io = createNodeAttachmentStoreIo({ root, ...options });
  const makeStore = (profile = PROFILE) =>
    createAttachmentStore({
      profile,
      io,
      newId: randomUUID,
      now: () => 123,
    });
  return { root, io, store: makeStore(), makeStore };
}

async function add(store: ReturnType<typeof createAttachmentStore>, value: Uint8Array) {
  const id = await store.beginOriginal({
    owner: OWNER,
    name: "notes.txt",
    mimeType: "text/plain",
    size: value.length,
  });
  if (value.length) await store.append(id, OWNER, 0, value);
  return store.commit(id, OWNER, digest(value));
}

describe("Node attachment store I/O", () => {
  it("persists originals and atomic manifests, including across new adapters", async () => {
    const h = await setup();
    const original = await add(h.store, data("hello"));
    const object = join(h.root, "v1", PROFILE, "objects", original.sha256);
    expect(await readFile(object, "utf8")).toBe("hello");
    expect(await h.store.readPreview(original.id, OWNER, 2)).toEqual({
      bytes: data("he"),
      size: 5,
      truncated: true,
    });
    expect(await readdir(join(h.root, "v1", PROFILE, "staging"))).toEqual([]);
    const reopenedIo = createNodeAttachmentStoreIo({ root: h.root });
    const reopened = createAttachmentStore({
      profile: PROFILE,
      io: reopenedIo,
      newId: randomUUID,
      now: () => 124,
    });
    expect(await reopened.list(OWNER)).toEqual([original]);
    expect(await reopened.commit(original.id, OWNER, original.sha256)).toEqual(original);
  });

  it("reads complete verified snapshots privately with limits, ownership and corruption checks", async () => {
    const h = await setup();
    const value = new Uint8Array(ATTACHMENT_LIMITS.previewBytes + 123).fill(97);
    const asset = await add(h.store, value);
    const prepared = await h.store.readForPreparation(asset.id, OWNER, value.length);
    expect(prepared.bytes).toEqual(value);
    expect(prepared.asset.sha256).toBe(digest(value));
    await expect(
      h.store.readForPreparation(asset.id, OWNER, value.length - 1),
    ).rejects.toMatchObject({ code: "quota_exceeded" });
    await expect(
      h.store.readForPreparation(asset.id, { kind: "draft", id: "other" }, value.length),
    ).rejects.toMatchObject({ code: "not_found" });
    const path = join(h.root, "v1", PROFILE, "objects", asset.sha256);
    await writeFile(path, new Uint8Array(value.length).fill(98));
    await expect(h.store.readForPreparation(asset.id, OWNER, value.length)).rejects.toMatchObject({
      code: "digest_mismatch",
    });
  });

  it("deduplicates within, but never across, profile namespaces", async () => {
    const h = await setup();
    await add(h.store, data("same"));
    await add(h.store, data("same"));
    await add(h.makeStore(OTHER_PROFILE), data("same"));
    expect(await readdir(join(h.root, "v1", PROFILE, "objects"))).toHaveLength(1);
    expect(await readdir(join(h.root, "v1", OTHER_PROFILE, "objects"))).toHaveLength(1);
    expect(await h.store.list(OWNER)).toHaveLength(2);
    expect(await h.makeStore(OTHER_PROFILE).list(OWNER)).toHaveLength(1);
  });

  it("serializes separate adapters for the same root", async () => {
    const h = await setup();
    const second = createAttachmentStore({
      profile: PROFILE,
      io: createNodeAttachmentStoreIo({ root: h.root }),
      newId: randomUUID,
      now: () => 123,
    });
    const inputs = Array.from({ length: 10 }, (_, index) => ({
      owner: OWNER,
      name: `${index}.txt`,
      mimeType: "text/plain",
      size: 1,
    }));
    const ids = await Promise.all(
      inputs.map((input, index) => (index % 2 ? second : h.store).beginOriginal(input)),
    );
    expect(new Set(ids).size).toBe(10);
    await expect(h.store.beginOriginal(inputs[0]!)).rejects.toMatchObject({
      code: "quota_exceeded",
    });
  });

  it("keeps reservations across adapter recreation and releases them only on cancellation", async () => {
    const free = ATTACHMENT_LIMITS.freeDiskReserveBytes + 9;
    const h = await setup({ freeBytes: async () => free });
    const id = await h.store.beginOriginal({
      owner: OWNER,
      name: "a",
      mimeType: "text/plain",
      size: 4,
    });
    const reopened = createAttachmentStore({
      profile: PROFILE,
      io: createNodeAttachmentStoreIo({ root: h.root, freeBytes: async () => free }),
      newId: randomUUID,
      now: () => 124,
    });
    await expect(
      reopened.beginOriginal({ owner: OWNER, name: "b", mimeType: "text/plain", size: 1 }),
    ).rejects.toMatchObject({ code: "quota_exceeded" });
    await reopened.cancel(id, OWNER);
    expect(
      await reopened.beginOriginal({ owner: OWNER, name: "b", mimeType: "text/plain", size: 1 }),
    ).toBeTruthy();
  });

  it("refuses a damaged existing object instead of overwriting it", async () => {
    const h = await setup();
    const original = await add(h.store, data("hello"));
    const path = join(h.root, "v1", PROFILE, "objects", original.sha256);
    await writeFile(path, "damaged");
    await expect(h.store.readPreview(original.id, OWNER, 2)).rejects.toMatchObject({
      code: "digest_mismatch",
    });
    const id = await h.store.beginOriginal({
      owner: OWNER,
      name: "b",
      mimeType: "text/plain",
      size: 5,
    });
    await h.store.append(id, OWNER, 0, data("hello"));
    await expect(h.store.commit(id, OWNER, original.sha256)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await readFile(path, "utf8")).toBe("damaged");
    expect(await h.store.stagingSize(id, OWNER)).toBe(5);
  });

  it("does not repair a malformed manifest or follow caller-provided IDs", async () => {
    const h = await setup();
    await h.io.readManifest(PROFILE);
    const path = join(h.root, "v1", PROFILE, "manifest.json");
    await writeFile(path, "{");
    await expect(h.store.list(OWNER)).rejects.toMatchObject({ code: "corrupt_manifest" });
    await expect(
      h.store.beginOriginal({ owner: OWNER, name: "a", mimeType: "text/plain", size: 1 }),
    ).rejects.toMatchObject({ code: "corrupt_manifest" });
    expect(await readFile(path, "utf8")).toBe("{");
    await expect(h.io.stagingSize(PROFILE, "../../other")).rejects.toMatchObject({
      code: "bad_request",
    });
  });

  it("does not delete a pre-existing temp file after exclusive creation fails", async () => {
    const h = await setup();
    const fixed = "123e4567-e89b-42d3-a456-426614174000";
    const io = createNodeAttachmentStoreIo({ root: h.root, newId: () => fixed });
    await io.readManifest(PROFILE);
    const path = join(h.root, "v1", PROFILE, `${fixed}.tmp`);
    await writeFile(path, "keep");
    await expect(io.writeManifestAtomic(PROFILE, "{}")).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path, "utf8")).toBe("keep");
  });

  it("refuses a symlinked staging file when the platform permits creating one", async (context) => {
    const h = await setup();
    const id = await h.store.beginOriginal({
      owner: OWNER,
      name: "a",
      mimeType: "text/plain",
      size: 1,
    });
    const stage = join(h.root, "v1", PROFILE, "staging", `${id}.part`);
    const outside = join(h.root, "outside");
    await writeFile(outside, "x");
    await rm(stage);
    try {
      await symlink(outside, stage, "file");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))
      ) {
        context.skip();
        return;
      }
      throw error;
    }
    await expect(h.store.append(id, OWNER, 0, data("y"))).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await readFile(outside, "utf8")).toBe("x");
  });
});
