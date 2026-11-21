import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AttachmentStoreError,
  createAttachmentStore,
  type AssetOwner,
  type AttachmentStoreIo,
} from "../../src/attachments/store";
import { ATTACHMENT_LIMITS } from "../../src/shared/attachments";

const PROFILE = "a".repeat(64);
const OTHER_PROFILE = "b".repeat(64);
const DRAFT: AssetOwner = { kind: "draft", id: "tab-1:0" };
const OTHER: AssetOwner = { kind: "draft", id: "tab-2:0" };
const SESSION: AssetOwner = { kind: "session", id: "session-1:branch-1:turn-1" };
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Test port models a process-global writer lock and atomic quota reservations. */
function memoryIo() {
  const manifests = new Map<string, string>();
  const stages = new Map<string, Uint8Array>();
  const reservations = new Map<string, number>();
  const objects = new Map<string, Uint8Array>();
  let tail: Promise<void> = Promise.resolve();
  let failSave = false;
  let failSaveAfterWrite = false;
  let failAppendAfterByte = false;
  let failRemove = false;
  let quota = Number.MAX_SAFE_INTEGER;
  let free = Number.MAX_SAFE_INTEGER;
  const key = (profile: string, id: string): string => `${profile}/${id}`;
  const port: AttachmentStoreIo = {
    async exclusive<T>(operation: () => Promise<T>): Promise<T> {
      const prior = tail;
      let release = (): void => {};
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prior;
      try {
        return await operation();
      } finally {
        release();
      }
    },
    async readManifest(profile) {
      return manifests.get(profile) ?? null;
    },
    async writeManifestAtomic(profile, content) {
      if (failSave) throw new Error("manifest write failed");
      manifests.set(profile, content);
      if (failSaveAfterWrite) throw new Error("manifest acknowledgement lost");
    },
    async createStaging(profile, id, declaredBytes, limits) {
      const k = key(profile, id);
      if (stages.has(k)) throw new Error("staging already exists");
      // Reserve both staging and worst-case temporary promotion space.
      const reserved = [...reservations.values()].reduce((sum, size) => sum + size * 2, 0);
      const stored = [...objects.values()].reduce((sum, value) => sum + value.length, 0);
      if (
        stored + reserved + declaredBytes * 2 > Math.min(quota, limits.storeBytes) ||
        free - reserved - declaredBytes * 2 < limits.freeReserveBytes
      ) {
        throw new AttachmentStoreError("quota_exceeded", "not enough space");
      }
      stages.set(k, new Uint8Array());
      reservations.set(k, declaredBytes);
    },
    async stagingSize(profile, id) {
      return stages.get(key(profile, id))?.byteLength ?? null;
    },
    async appendStaging(profile, id, offset, chunk) {
      const k = key(profile, id);
      const previous = stages.get(k);
      if (!previous || previous.length !== offset) throw new Error("offset mismatch");
      const appended = failAppendAfterByte ? chunk.slice(0, 1) : chunk;
      const next = new Uint8Array(previous.length + appended.length);
      next.set(previous);
      next.set(appended, previous.length);
      stages.set(k, next);
      if (failAppendAfterByte) throw new Error("partial write");
    },
    async hashStaging(profile, id) {
      const data = stages.get(key(profile, id));
      if (!data) throw new Error("missing stage");
      return sha(data);
    },
    async ensureObject(profile, id, digest) {
      const data = stages.get(key(profile, id));
      if (!data || sha(data) !== digest) throw new Error("missing or damaged stage");
      const objectKey = key(profile, digest);
      const existing = objects.get(objectKey);
      if (existing && sha(existing) !== digest) throw new Error("damaged object");
      if (!existing) objects.set(objectKey, data.slice());
    },
    async readObjectPreview(profile, digest, maxBytes) {
      const value = objects.get(key(profile, digest));
      if (!value || sha(value) !== digest) throw new Error("missing or damaged object");
      return { bytes: value.slice(0, maxBytes), size: value.length };
    },
    async readObject(profile, digest, maxBytes) {
      const value = objects.get(key(profile, digest));
      if (!value || sha(value) !== digest) throw new Error("missing or damaged object");
      if (value.length > maxBytes) throw new Error("object exceeds limit");
      return value.slice();
    },
    async removeObject(profile, digest) {
      if (failRemove) throw new Error("cleanup failed");
      objects.delete(key(profile, digest));
    },
    async freeBytes() {
      return free;
    },
    async removeStaging(profile, id) {
      if (failRemove) throw new Error("cleanup failed");
      stages.delete(key(profile, id));
      reservations.delete(key(profile, id));
    },
  };
  return {
    port,
    manifests,
    stages,
    objects,
    failSave(value: boolean) {
      failSave = value;
    },
    failSaveAfterWrite(value: boolean) {
      failSaveAfterWrite = value;
    },
    failAppend(value: boolean) {
      failAppendAfterByte = value;
    },
    failRemove(value: boolean) {
      failRemove = value;
    },
    setQuota(value: number) {
      quota = value;
    },
    setFree(value: number) {
      free = value;
    },
  };
}

function harness(profile = PROFILE, io = memoryIo()) {
  let next = 0;
  const store = createAttachmentStore({
    profile,
    io: io.port,
    newId: () => `123e4567-e89b-42d3-a456-${String(++next).padStart(12, "0")}`,
    now: () => 1234,
  });
  const add = async (text: string, name = "notes.txt", owner = DRAFT) => {
    const data = bytes(text);
    const id = await store.beginOriginal({
      owner,
      name,
      mimeType: "text/plain",
      size: data.length,
    });
    if (data.length) await store.append(id, owner, 0, data);
    return store.commit(id, owner, sha(data));
  };
  return { store, io, add };
}

describe("attachment snapshot store", () => {
  it("preserves a referenced stage when manifest publication succeeds but its acknowledgement fails", async () => {
    const { store, io } = harness();
    io.failSaveAfterWrite(true);
    await expect(
      store.beginOriginal({ owner: DRAFT, name: "file.txt", mimeType: "text/plain", size: 5 }),
    ).rejects.toThrow(/acknowledgement lost/);
    expect(io.stages.size).toBe(1);
    const manifest = JSON.parse(io.manifests.get(PROFILE) ?? "") as { staging: { id: string }[] };
    const stageId = manifest.staging[0]?.id;
    expect(stageId).toBeTruthy();
    expect(await store.stagingSize(stageId ?? "", DRAFT)).toBe(0);
    io.failSaveAfterWrite(false);
    await store.cancel(stageId ?? "", DRAFT);
    expect(io.stages.size).toBe(0);
  });

  it("authorizes bounded internal preparation reads without exposing mutable storage", async () => {
    const { store, add, io } = harness();
    const asset = await add("hello");
    const result = await store.readForPreparation(asset.id, DRAFT, 5);
    expect(result).toEqual({ asset, bytes: bytes("hello") });
    result.bytes[0] = 0;
    expect(await store.readForPreparation(asset.id, DRAFT, 5)).toEqual({
      asset,
      bytes: bytes("hello"),
    });
    await expect(store.readForPreparation(asset.id, OTHER, 5)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(store.readForPreparation(asset.id, DRAFT, 4)).rejects.toMatchObject({
      code: "quota_exceeded",
    });
    await expect(
      store.readForPreparation(asset.id, DRAFT, ATTACHMENT_LIMITS.documentOriginalBytes + 1),
    ).rejects.toMatchObject({ code: "bad_request" });
    io.objects.set(`${PROFILE}/${asset.sha256}`, bytes("wrong"));
    await expect(store.readForPreparation(asset.id, DRAFT, 5)).rejects.toThrow(/damaged/);
  });

  it("stages bounded chunks and commits an immutable, owner-scoped snapshot", async () => {
    const { store, io } = harness();
    const id = await store.beginOriginal({
      owner: DRAFT,
      name: "notes.txt",
      mimeType: "text/plain",
      size: 5,
    });
    expect(await store.append(id, DRAFT, 0, bytes("he"))).toBe(2);
    expect(await store.append(id, DRAFT, 2, bytes("llo"))).toBe(5);
    const result = await store.commit(id, DRAFT, sha(bytes("hello")));
    expect(result).toMatchObject({
      id,
      size: 5,
      sha256: sha(bytes("hello")),
      owners: [DRAFT],
      originalId: null,
    });
    expect(io.stages.size).toBe(0);
    expect(io.objects.size).toBe(1);
    expect(await store.list(DRAFT)).toEqual([result]);
    expect(await store.list(OTHER)).toEqual([]);
    await expect(store.append(id, DRAFT, 0, bytes("x"))).rejects.toMatchObject({
      code: "not_found",
    });
    // Caller mutations never mutate the manifest or another owner's projection.
    (result.owners as AssetOwner[]).push(OTHER);
    expect((await store.list(DRAFT))[0]?.owners).toEqual([DRAFT]);
  });

  it("only returns bounded previews to an owner", async () => {
    const h = harness();
    const asset = await h.add("hello");
    expect(await h.store.readPreview(asset.id, DRAFT, 3)).toEqual({
      bytes: bytes("hel"),
      size: 5,
      truncated: true,
    });
    await expect(h.store.readPreview(asset.id, OTHER, 3)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      h.store.readPreview(asset.id, DRAFT, ATTACHMENT_LIMITS.previewBytes + 1),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("checks size, digest, offsets, chunk size and owners without losing the stage", async () => {
    const { store } = harness();
    const id = await store.beginOriginal({
      owner: DRAFT,
      name: "a",
      mimeType: "text/plain",
      size: 3,
    });
    await expect(store.append(id, OTHER, 0, bytes("x"))).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(store.append(id, DRAFT, 1, bytes("x"))).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      store.append(id, DRAFT, 0, new Uint8Array(ATTACHMENT_LIMITS.importChunkBytes + 1)),
    ).rejects.toMatchObject({ code: "bad_request" });
    await store.append(id, DRAFT, 0, bytes("ab"));
    await expect(store.append(id, DRAFT, 0, bytes("ab"))).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(store.commit(id, DRAFT, sha(bytes("abc")))).rejects.toMatchObject({
      code: "size_mismatch",
    });
    await store.append(id, DRAFT, 2, bytes("c"));
    await expect(store.commit(id, DRAFT, sha(bytes("bad")))).rejects.toMatchObject({
      code: "digest_mismatch",
    });
    expect(await store.stagingSize(id, DRAFT)).toBe(3);
    expect((await store.commit(id, DRAFT, sha(bytes("abc")))).size).toBe(3);
  });

  it("recovers from a partial write and can be recreated after a crash", async () => {
    const h = harness();
    const id = await h.store.beginOriginal({
      owner: DRAFT,
      name: "a",
      mimeType: "text/plain",
      size: 3,
    });
    h.io.failAppend(true);
    await expect(h.store.append(id, DRAFT, 0, bytes("abc"))).rejects.toThrow("partial write");
    h.io.failAppend(false);
    const resumed = harness(PROFILE, h.io).store;
    expect(await resumed.stagingSize(id, DRAFT)).toBe(1);
    await resumed.append(id, DRAFT, 1, bytes("bc"));
    expect((await resumed.commit(id, DRAFT, sha(bytes("abc")))).sha256).toBe(sha(bytes("abc")));
  });

  it("retains the stage if manifest commit fails and retries an acknowledged commit idempotently", async () => {
    const h = harness();
    const id = await h.store.beginOriginal({
      owner: DRAFT,
      name: "a",
      mimeType: "text/plain",
      size: 3,
    });
    await h.store.append(id, DRAFT, 0, bytes("abc"));
    const before = h.io.manifests.get(PROFILE);
    h.io.failSave(true);
    await expect(h.store.commit(id, DRAFT, sha(bytes("abc")))).rejects.toThrow(
      "manifest write failed",
    );
    expect(h.io.manifests.get(PROFILE)).toBe(before);
    expect(await h.store.stagingSize(id, DRAFT)).toBe(3);
    h.io.failSave(false);
    h.io.failRemove(true);
    const result = await h.store.commit(id, DRAFT, sha(bytes("abc")));
    expect(h.io.stages.size).toBe(1);
    h.io.failRemove(false);
    expect(await h.store.commit(id, DRAFT, sha(bytes("abc")))).toEqual(result);
    expect(h.io.stages.size).toBe(0);
    await expect(h.store.commit(id, DRAFT, sha(bytes("other")))).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("reads version-one/two manifests without rewriting them and upgrades only on a successful write", async () => {
    const h = harness();
    const legacy = JSON.stringify({ version: 1, staging: [], assets: [] });
    h.io.manifests.set(PROFILE, legacy);
    expect(await h.store.list(DRAFT)).toEqual([]);
    expect(h.io.manifests.get(PROFILE)).toBe(legacy);
    await h.store.beginOriginal({ owner: DRAFT, name: "a.txt", mimeType: "text/plain", size: 0 });
    expect(JSON.parse(h.io.manifests.get(PROFILE) ?? "").version).toBe(3);
  });

  it("records immutable owner-scoped direct provenance without trusting unknown assets", async () => {
    const h = harness();
    const original = await h.add("hello");
    const id = await h.store.beginRepresentation({
      owner: DRAFT,
      name: "a.txt",
      mimeType: "text/plain",
      size: 5,
      originalId: original.id,
      originalSha256: original.sha256,
    });
    await h.store.append(id, DRAFT, 0, bytes("hello"));
    await h.store.commit(id, DRAFT, sha(bytes("hello")));
    const metadata = {
      version: 1 as const,
      modality: "text" as const,
      preparationVersion: "desktop-direct-v1",
      warnings: ["test warning"],
      details: { kind: "text" as const, empty: false, utf8Bom: false },
    };
    await expect(h.store.recordDirectPreparation(id, OTHER, metadata)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      h.store.recordDirectPreparation(original.id, DRAFT, metadata),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      h.store.recordDirectPreparation(id, DRAFT, {
        ...metadata,
        details: { ...metadata.details, empty: true },
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    const recorded = await h.store.recordDirectPreparation(id, DRAFT, metadata);
    expect(recorded.preparation).toEqual(metadata);
    expect(await h.store.recordDirectPreparation(id, DRAFT, metadata)).toEqual(recorded);
    await expect(
      h.store.recordDirectPreparation(id, DRAFT, { ...metadata, preparationVersion: "other" }),
    ).rejects.toMatchObject({ code: "conflict" });
    (recorded.preparation?.warnings as string[]).push("local mutation");
    expect((await h.store.list(DRAFT)).find((asset) => asset.id === id)?.preparation).toEqual(
      metadata,
    );
  });

  it("treats malformed persisted provenance as corruption without repairing user data", async () => {
    const h = harness();
    const original = await h.add("hello");
    const id = await h.store.beginRepresentation({
      owner: DRAFT,
      name: "a.txt",
      mimeType: "text/plain",
      size: 5,
      originalId: original.id,
      originalSha256: original.sha256,
    });
    await h.store.append(id, DRAFT, 0, bytes("hello"));
    await h.store.commit(id, DRAFT, sha(bytes("hello")));
    await h.store.recordDirectPreparation(id, DRAFT, {
      version: 1,
      modality: "text",
      preparationVersion: "direct-v1",
      warnings: [],
      details: { kind: "text", empty: false, utf8Bom: false },
    });
    const parsed = JSON.parse(h.io.manifests.get(PROFILE) ?? "") as {
      assets: { id: string; preparation?: { details: { empty: boolean } } }[];
    };
    const entry = parsed.assets.find((asset) => asset.id === id);
    if (!entry?.preparation) throw new Error("missing test provenance");
    entry.preparation.details.empty = true;
    const corrupt = JSON.stringify(parsed);
    h.io.manifests.set(PROFILE, corrupt);
    await expect(h.store.list(DRAFT)).rejects.toMatchObject({ code: "corrupt_manifest" });
    expect(h.io.manifests.get(PROFILE)).toBe(corrupt);
  });

  it("keeps malformed, unknown-version and unknown-field manifests untouched", async () => {
    const h = harness();
    for (const raw of [
      "{",
      JSON.stringify({ version: 3, staging: [], assets: [] }),
      JSON.stringify({ version: 1, staging: [], assets: [], future: true }),
      JSON.stringify({ version: 1, staging: [{ id: "bad" }], assets: [] }),
    ]) {
      h.io.manifests.set(PROFILE, raw);
      await expect(
        h.store.beginOriginal({ owner: DRAFT, name: "a", mimeType: "text/plain", size: 1 }),
      ).rejects.toMatchObject({ code: "corrupt_manifest" });
      expect(h.io.manifests.get(PROFILE)).toBe(raw);
      expect(h.io.stages.size).toBe(0);
    }
  });

  it("cleans up an uncommitted stage when its initial manifest save fails", async () => {
    const h = harness();
    h.io.failSave(true);
    await expect(
      h.store.beginOriginal({ owner: DRAFT, name: "a", mimeType: "text/plain", size: 1 }),
    ).rejects.toThrow();
    expect(h.io.stages.size).toBe(0);
    expect(h.io.manifests.has(PROFILE)).toBe(false);
  });

  it("keeps distinct IDs for same-name files and deduplicates identical bytes only within a profile", async () => {
    const h = harness();
    const a = await h.add("one");
    const b = await h.add("two");
    const c = await h.add("one");
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    expect(h.io.objects.size).toBe(2);
    const other = harness(OTHER_PROFILE, h.io);
    await other.add("one");
    expect(h.io.objects.size).toBe(3);
    expect(await other.store.list(DRAFT)).toHaveLength(1);
    await expect(other.store.stagingSize(a.id, DRAFT)).rejects.toMatchObject({ code: "not_found" });
  });

  it("binds representations to the original digest and owner", async () => {
    const h = harness();
    const original = await h.add("original");
    await expect(
      h.store.beginRepresentation({
        owner: OTHER,
        name: "a.txt",
        mimeType: "text/plain",
        size: 1,
        originalId: original.id,
        originalSha256: original.sha256,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      h.store.beginRepresentation({
        owner: DRAFT,
        name: "a.txt",
        mimeType: "text/plain",
        size: 1,
        originalId: original.id,
        originalSha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const id = await h.store.beginRepresentation({
      owner: DRAFT,
      name: "a.txt",
      mimeType: "text/plain",
      size: 1,
      originalId: original.id,
      originalSha256: original.sha256,
    });
    await h.store.append(id, DRAFT, 0, bytes("x"));
    expect(await h.store.commit(id, DRAFT, sha(bytes("x")))).toMatchObject({
      kind: "representation",
      originalId: original.id,
      originalSha256: original.sha256,
    });
    await expect(h.store.addOwner(id, DRAFT, SESSION)).rejects.toMatchObject({ code: "not_found" });
    await h.store.addOwner(original.id, DRAFT, SESSION);
    await h.store.addOwner(id, DRAFT, SESSION);
    await expect(h.store.releaseOwner(original.id, DRAFT)).rejects.toMatchObject({
      code: "conflict",
    });
    await h.store.releaseOwner(id, DRAFT);
    await h.store.releaseOwner(original.id, DRAFT);
    expect(await h.store.list(SESSION)).toHaveLength(2);
  });

  it("reports immutable owners by asset id for main-only reconciliation", async () => {
    const h = harness();
    const original = await h.add("data");
    expect(await h.store.owners(original.id)).toEqual([DRAFT]);
    await h.store.addOwner(original.id, DRAFT, SESSION);
    expect(await h.store.owners(original.id)).toEqual([DRAFT, SESSION]);
    // Caller mutation cannot change the manifest projection.
    const owners = await h.store.owners(original.id);
    (owners as AssetOwner[]).push(OTHER);
    expect(await h.store.owners(original.id)).toEqual([DRAFT, SESSION]);
    expect(await h.store.owners("123e4567-e89b-42d3-a456-426614174999")).toEqual([]);
    await expect(h.store.owners("not-an-id")).rejects.toMatchObject({ code: "bad_request" });
  });

  it("tracks shared owners without deleting originals when an owner releases them", async () => {
    const h = harness();
    const original = await h.add("data");
    await h.store.addOwner(original.id, DRAFT, SESSION);
    await h.store.addOwner(original.id, DRAFT, SESSION);
    await h.store.releaseOwner(original.id, DRAFT);
    expect(await h.store.list(DRAFT)).toEqual([]);
    expect((await h.store.list(SESSION))[0]?.owners).toEqual([SESSION]);
    await h.store.releaseOwner(original.id, SESSION);
    expect(h.io.objects.size).toBe(1);
    expect(JSON.parse(h.io.manifests.get(PROFILE) ?? "{}").assets[0].unownedAt).toBe(1234);
  });

  it("enforces global reservations, free-space reserve, per-draft count and cancellation", async () => {
    const h = harness();
    h.io.setQuota(1);
    await expect(
      h.store.beginOriginal({ owner: DRAFT, name: "a", mimeType: "text/plain", size: 1 }),
    ).rejects.toMatchObject({ code: "quota_exceeded" });
    h.io.setQuota(Number.MAX_SAFE_INTEGER);
    h.io.setFree(ATTACHMENT_LIMITS.freeDiskReserveBytes);
    await expect(
      h.store.beginOriginal({ owner: DRAFT, name: "a", mimeType: "text/plain", size: 1 }),
    ).rejects.toMatchObject({ code: "quota_exceeded" });
    h.io.setFree(Number.MAX_SAFE_INTEGER);
    const ids = await Promise.all(
      Array.from({ length: 10 }, () =>
        h.store.beginOriginal({ owner: DRAFT, name: "a", mimeType: "text/plain", size: 1 }),
      ),
    );
    await expect(
      h.store.beginOriginal({ owner: DRAFT, name: "a", mimeType: "text/plain", size: 1 }),
    ).rejects.toMatchObject({ code: "quota_exceeded" });
    await h.store.cancel(ids[0]!, DRAFT);
    expect(
      await h.store.beginOriginal({ owner: DRAFT, name: "a", mimeType: "text/plain", size: 1 }),
    ).toBeTruthy();
  });

  it("enforces draft quotas when adding an owner to an existing original", async () => {
    const h = harness();
    const existing = await h.add("data", "a.txt", SESSION);
    await Promise.all(
      Array.from({ length: 10 }, () =>
        h.store.beginOriginal({ owner: DRAFT, name: "a", mimeType: "text/plain", size: 1 }),
      ),
    );
    await expect(h.store.addOwner(existing.id, SESSION, DRAFT)).rejects.toMatchObject({
      code: "quota_exceeded",
    });
  });

  it("rejects invalid names, profile keys and oversized originals before creating data", async () => {
    const h = harness();
    expect(() => harness("../profile")).toThrow();
    for (const name of ["../secret", "C:\\secret", "bad\0name", ""]) {
      await expect(
        h.store.beginOriginal({ owner: DRAFT, name, mimeType: "text/plain", size: 1 }),
      ).rejects.toMatchObject({ code: "bad_request" });
    }
    await expect(
      h.store.beginOriginal({
        owner: DRAFT,
        name: "a",
        mimeType: "text/plain",
        size: ATTACHMENT_LIMITS.documentOriginalBytes + 1,
      }),
    ).rejects.toMatchObject({ code: "quota_exceeded" });
    expect(h.io.stages.size).toBe(0);
  });
});

describe("persisted attachment classification", () => {
  it("records immutable classification for originals only", async () => {
    const h = harness();
    const original = await h.add("hello");
    const classification = {
      version: "desktop-classify-v1" as const,
      kind: "text" as const,
      format: "text",
      detectedMime: "text/plain",
      warnings: [],
      text: { promptBytes: 5, empty: false },
      image: null,
      failure: null,
    };
    await expect(
      h.store.recordClassification(original.id, OTHER, classification),
    ).rejects.toMatchObject({ code: "not_found" });

    const representationId = await h.store.beginRepresentation({
      owner: DRAFT,
      name: "a.txt",
      mimeType: "text/plain",
      size: 5,
      originalId: original.id,
      originalSha256: original.sha256,
    });
    await h.store.append(representationId, DRAFT, 0, bytes("hello"));
    await h.store.commit(representationId, DRAFT, sha(bytes("hello")));
    await expect(
      h.store.recordClassification(representationId, DRAFT, classification),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      h.store.recordClassification(original.id, DRAFT, {
        ...classification,
        text: null,
      } as never),
    ).rejects.toMatchObject({ code: "bad_request" });

    const recorded = await h.store.recordClassification(original.id, DRAFT, classification);
    expect(recorded.classification).toEqual(classification);
    expect(await h.store.recordClassification(original.id, DRAFT, classification)).toEqual(
      recorded,
    );
    await expect(
      h.store.recordClassification(original.id, DRAFT, {
        ...classification,
        warnings: ["changed"],
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    // The persisted manifest round-trips the record under strict validation.
    const reloaded = h.store.list(DRAFT);
    expect((await reloaded).map((asset) => asset.classification?.kind)).toEqual([
      "text",
      undefined,
    ]);
  });

  it("tombstones a retired durable owner and releases only its assets", async () => {
    const h = harness();
    const original = await h.add("snapshot", "a.txt");
    const repData = bytes("prepared");
    const repId = await h.store.beginRepresentation({
      owner: DRAFT,
      name: "rep.txt",
      mimeType: "text/plain",
      size: repData.length,
      originalId: original.id,
      originalSha256: original.sha256,
    });
    await h.store.append(repId, DRAFT, 0, repData);
    const representation = await h.store.commit(repId, DRAFT, sha(repData));
    for (const id of [original.id, representation.id]) {
      await h.store.addOwner(id, DRAFT, SESSION);
    }
    await h.store.releaseOwner(representation.id, DRAFT);
    await h.store.releaseOwner(original.id, DRAFT);

    await expect(
      h.store.retireOwners([DRAFT as AssetOwner], 30 * 24 * 3_600_000),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(h.store.retireOwners([SESSION], 30 * 24 * 3_600_000)).resolves.toEqual({
      assets: 2,
      tombstones: 1,
    });
    expect(await h.store.owners(original.id)).toEqual([]);
    expect(await h.store.owners(representation.id)).toEqual([]);
    const inventory = await h.store.inventory();
    expect(inventory.tombstones).toEqual([
      {
        owner: SESSION,
        deletedAt: 1234,
        expiresAt: 1234 + 30 * 24 * 3_600_000,
        assetIds: [original.id, representation.id],
      },
    ]);
    expect(inventory.assets.every((asset) => asset.unownedAt === 1234)).toBe(true);
    expect(await h.store.isRetired(SESSION)).toBe(true);

    await expect(h.store.clearTombstone(SESSION)).resolves.toBe(1);
    expect(await h.store.isRetired(SESSION)).toBe(false);
    expect((await h.store.inventory()).tombstones).toEqual([]);
  });

  it("keeps a shared asset owned and unowned by nobody else", async () => {
    const h = harness();
    const original = await h.add("shared", "shared.txt", SESSION);
    await h.store.addOwner(original.id, SESSION, OTHER);

    await h.store.retireOwners([SESSION], 1_000);
    expect(await h.store.owners(original.id)).toEqual([OTHER]);
    expect((await h.store.list(OTHER))[0]?.unownedAt).toBeNull();

    await h.store.releaseOwner(original.id, OTHER);
    expect(await h.store.owners(original.id)).toEqual([]);
    expect((await h.store.inventory()).assets[0]?.unownedAt).toBe(1234);
  });

  it("removes only unowned, unreferenced assets and retries failed object cleanup", async () => {
    const h = harness();
    const original = await h.add("content", "a.txt");
    const repData = bytes("prepared");
    const repId = await h.store.beginRepresentation({
      owner: DRAFT,
      name: "rep.txt",
      mimeType: "text/plain",
      size: repData.length,
      originalId: original.id,
      originalSha256: original.sha256,
    });
    await h.store.append(repId, DRAFT, 0, repData);
    const representation = await h.store.commit(repId, DRAFT, sha(repData));

    await expect(h.store.removeAsset(original.id)).rejects.toMatchObject({ code: "conflict" });
    expect(await h.store.owners(original.id)).toEqual([DRAFT]);
    // No owner release means no deletion: the store never evicts referenced data.
    expect(h.io.objects.size).toBe(2);

    // A cleanup failure leaves the manifest record gone but the digest pending.
    await h.store.releaseOwner(representation.id, DRAFT);
    await h.store.releaseOwner(original.id, DRAFT);
    h.io.failRemove(true);
    await h.store.removeAsset(representation.id);
    expect((await h.store.inventory()).pendingRemovals).toEqual([representation.sha256]);
    expect(h.io.objects.size).toBe(2);

    h.io.failRemove(false);
    await expect(h.store.retryObjectRemovals()).resolves.toBe(1);
    expect((await h.store.inventory()).pendingRemovals).toEqual([]);
    expect(h.io.objects.size).toBe(1);
    await h.store.removeAsset(original.id);
    expect(h.io.objects.size).toBe(0);
  });

  it("never deletes an object whose digest is shared by another asset", async () => {
    const h = harness();
    const first = await h.add("same", "one.txt");
    const second = await h.add("same", "two.txt");
    expect(first.sha256).toBe(second.sha256);
    expect(h.io.objects.size).toBe(1);
    await h.store.releaseOwner(first.id, DRAFT);
    await h.store.removeAsset(first.id);
    expect(h.io.objects.size).toBe(1);
    await h.store.releaseOwner(second.id, DRAFT);
    await h.store.removeAsset(second.id);
    expect(h.io.objects.size).toBe(0);
  });

  it("migrates a v2 manifest and exposes bounded inventory and free space", async () => {
    const h = harness();
    const original = await h.add("legacy");
    const manifest = JSON.parse(h.io.manifests.get(PROFILE) ?? "") as {
      tombstones?: unknown;
      pendingRemovals?: unknown;
    };
    const legacy = { ...manifest, version: 2 };
    delete legacy.tombstones;
    delete legacy.pendingRemovals;
    h.io.manifests.set(PROFILE, JSON.stringify(legacy));

    const inventory = await h.store.inventory();
    expect(inventory.tombstones).toEqual([]);
    expect(inventory.pendingRemovals).toEqual([]);
    expect(inventory.freeBytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(inventory.assets.map((asset) => asset.id)).toEqual([original.id]);
    expect(inventory.staging).toEqual([]);

    await h.store.addOwner(original.id, DRAFT, SESSION);
    await h.store.retireOwners([SESSION], 1_000);
    const saved = JSON.parse(h.io.manifests.get(PROFILE) ?? "") as { version: number };
    expect(saved.version).toBe(3);
  });

  it("rejects a tombstone that points at an unknown asset", async () => {
    const h = harness();
    await h.add("data");
    const manifest = JSON.parse(h.io.manifests.get(PROFILE) ?? "") as Record<string, unknown>;
    h.io.manifests.set(
      PROFILE,
      JSON.stringify({
        ...manifest,
        version: 3,
        tombstones: [
          {
            owner: { kind: "session", id: "session-x" },
            deletedAt: 1,
            expiresAt: 2,
            assetIds: ["123e4567-e89b-42d3-a456-426614174999"],
          },
        ],
        pendingRemovals: [],
      }),
    );
    await expect(h.store.inventory()).rejects.toMatchObject({ code: "corrupt_manifest" });
  });
});
