import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { AssetKind, AssetOwner, AssetRecord } from "../../src/attachments/store";
import {
  createAttachmentBundle,
  importAttachmentBundle,
  inspectAttachmentBundle,
} from "../../src/main/attachment-bundle";

const profileKey = "a".repeat(64);
const opaque = (n: number): string =>
  `123e4567-e89b-42d3-a456-${String(426614174000 + n).padStart(12, "0")}`;
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const sha = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

const sessionOwnerA: AssetOwner = { kind: "session", id: opaque(90) };
const sessionOwnerB: AssetOwner = { kind: "session", id: opaque(91) };

function record(
  id: string,
  kind: AssetKind,
  content: string,
  overrides: Partial<AssetRecord> = {},
): { record: AssetRecord; content: Uint8Array } {
  const data = bytes(content);
  return {
    content: data,
    record: {
      id,
      kind,
      name: kind === "original" ? "notes.txt" : "notes-prepared.txt",
      mimeType: "text/plain",
      size: data.byteLength,
      sha256: sha(data),
      createdAt: 1,
      owners: [sessionOwnerA],
      unownedAt: null,
      originalId: null,
      originalSha256: null,
      ...overrides,
    },
  };
}

function fixture() {
  const original = record(opaque(1), "original", "original body");
  const representation = record(opaque(2), "representation", "prepared body", {
    originalId: original.record.id,
    originalSha256: original.record.sha256,
  });
  const contents = new Map<string, Uint8Array>([
    [original.record.id, original.content],
    [representation.record.id, representation.content],
  ]);
  return { assets: [original.record, representation.record], contents };
}

describe("portable attachment bundles", () => {
  it("exports a provenance-only manifest by default", async () => {
    const h = fixture();
    const bundle = await createAttachmentBundle({
      assets: h.assets,
      read: async (asset) => h.contents.get(asset.id)!,
      includeObjects: false,
      now: 1_700_000_000_000,
    });
    const entries = unzipSync(bundle.zip);
    expect(Object.keys(entries).sort()).toEqual(["bundle.json"]);
    const manifest = JSON.parse(strFromU8(entries["bundle.json"]!)) as {
      includesObjects: boolean;
      assets: unknown[];
    };
    expect(manifest.includesObjects).toBe(false);
    expect(manifest.assets).toHaveLength(2);
    expect(JSON.stringify(manifest)).not.toContain(profileKey);
    expect(JSON.stringify(manifest)).not.toContain("session");
    expect(JSON.stringify(manifest)).not.toContain("C:");
  });

  it("exports objects only when explicitly opted in and round-trips validation", async () => {
    const h = fixture();
    const bundle = await createAttachmentBundle({
      assets: h.assets,
      read: async (asset) => h.contents.get(asset.id)!,
      includeObjects: true,
      now: 1,
    });
    expect(bundle.objects).toBe(2);
    const examples = Object.keys(unzipSync(bundle.zip)).filter((name) =>
      name.startsWith("objects/"),
    );
    expect(examples).toHaveLength(2);
    const inspected = inspectAttachmentBundle(bundle.zip);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.bundle.includesObjects).toBe(true);
    expect(inspected.bundle.manifest.assets).toHaveLength(2);
    expect(inspected.bundle.objects.size).toBe(2);
  });

  it("validates a tampered object against its digest", async () => {
    const h = fixture();
    const bundle = await createAttachmentBundle({
      assets: h.assets,
      read: async (asset) => h.contents.get(asset.id)!,
      includeObjects: true,
      now: 1,
    });
    const entries = unzipSync(bundle.zip);
    const objectName = Object.keys(entries).find((name) => name.startsWith("objects/"))!;
    entries[objectName] = strToU8("tampered");
    const inspected = inspectAttachmentBundle(zipSync(entries));
    expect(inspected).toMatchObject({ ok: false, error: "digest_mismatch" });
  });

  it("refuses traversal, absolute paths, unknown entries and oversized expansions", () => {
    const manifest = {
      version: 1,
      createdAt: 1,
      includesObjects: false,
      assets: [
        {
          id: opaque(1),
          kind: "original",
          name: "a.txt",
          mimeType: "text/plain",
          size: 1,
          sha256: "a".repeat(64),
          originalId: null,
          originalSha256: null,
          coverage: { kind: "entire-file" },
        },
      ],
    };
    for (const name of ["../evil", "/absolute", "objects/../x", "other.txt", "objects/nothex"]) {
      const zip = zipSync({
        "bundle.json": strToU8(JSON.stringify(manifest)),
        [name]: strToU8("x"),
      });
      expect(inspectAttachmentBundle(zip)).toMatchObject({ ok: false });
    }
    const huge = zipSync({
      "bundle.json": strToU8(JSON.stringify(manifest)),
      "objects/x": new Uint8Array(2_000),
    });
    expect(
      inspectAttachmentBundle(huge, { maxTotalBytes: 100, maxObjectBytes: 1_000 }),
    ).toMatchObject({ ok: false, error: "too_large" });
  });

  it("refuses an invalid manifest, forged owners and missing objects", () => {
    const baseAsset = {
      id: opaque(1),
      kind: "original",
      name: "a.txt",
      mimeType: "text/plain",
      size: 1,
      sha256: "a".repeat(64),
      originalId: null,
      originalSha256: null,
      coverage: { kind: "entire-file" },
    };
    const manifests: unknown[] = [
      { version: 2, createdAt: 1, includesObjects: true, assets: [baseAsset] },
      {
        version: 1,
        createdAt: 1,
        includesObjects: true,
        assets: [{ ...baseAsset, owners: [sessionOwnerA] }],
      },
      {
        version: 1,
        createdAt: 1,
        includesObjects: true,
        assets: [{ ...baseAsset, representationId: opaque(2) }],
      },
      {
        version: 1,
        createdAt: 1,
        includesObjects: true,
        assets: [
          {
            ...baseAsset,
            kind: "representation",
            originalId: opaque(9),
            originalSha256: "b".repeat(64),
          },
        ],
      },
    ];
    for (const manifest of manifests) {
      expect(
        inspectAttachmentBundle(zipSync({ "bundle.json": strToU8(JSON.stringify(manifest)) })),
      ).toMatchObject({ ok: false, error: "invalid_manifest" });
    }
    const missing = zipSync({
      "bundle.json": strToU8(
        JSON.stringify({ version: 1, createdAt: 1, includesObjects: true, assets: [baseAsset] }),
      ),
    });
    expect(inspectAttachmentBundle(missing)).toMatchObject({ ok: false, error: "missing_object" });
  });

  it("imports validated objects as new assets under one explicit owner", async () => {
    const h = fixture();
    const bundle = await createAttachmentBundle({
      assets: h.assets,
      read: async (asset) => h.contents.get(asset.id)!,
      includeObjects: true,
      now: 1,
    });
    const inspected = inspectAttachmentBundle(bundle.zip);
    if (!inspected.ok) throw new Error(inspected.error);
    const store = fakeStore();
    const result = await importAttachmentBundle(store, sessionOwnerB, inspected.bundle);
    expect(result).toEqual({ originals: 1, representations: 1 });
    const originals = store.assets.filter((asset) => asset.kind === "original");
    const representations = store.assets.filter((asset) => asset.kind === "representation");
    expect(originals).toHaveLength(1);
    expect(representations).toHaveLength(1);
    // New app ids, never the manifest ids; the owner is the explicit one only.
    expect(originals[0]?.id).not.toBe(opaque(1));
    expect(representations[0]?.originalId).toBe(originals[0]?.id);
    expect(store.assets.every((asset) => asset.owner.id === sessionOwnerB.id)).toBe(true);
    expect(strFromU8(store.contents.get(originals[0]!.id)!)).toBe("original body");
    expect(store.released).toEqual([]);
  });

  it("releases every committed asset when an import is interrupted", async () => {
    const h = fixture();
    const bundle = await createAttachmentBundle({
      assets: h.assets,
      read: async (asset) => h.contents.get(asset.id)!,
      includeObjects: true,
      now: 1,
    });
    const inspected = inspectAttachmentBundle(bundle.zip);
    if (!inspected.ok) throw new Error(inspected.error);
    const store = fakeStore({ failCommitAt: 2 });
    await expect(importAttachmentBundle(store, sessionOwnerB, inspected.bundle)).rejects.toThrow();
    expect(store.assets).toEqual([]);
    expect(store.released.length).toBe(1);
    expect(store.cancelled.length).toBe(1);
  });
});

interface FakeAsset {
  id: string;
  kind: AssetKind;
  name: string;
  mimeType: string;
  size: number;
  owner: AssetOwner;
  originalId: string | null;
  originalSha256: string | null;
}

function fakeStore(options: { failCommitAt?: number } = {}) {
  const assets: FakeAsset[] = [];
  const staging = new Map<
    string,
    {
      kind: AssetKind;
      name: string;
      mimeType: string;
      size: number;
      originalId: string | null;
      originalSha256: string | null;
      bytes: Uint8Array;
    }
  >();
  const contents = new Map<string, Uint8Array>();
  const released: string[] = [];
  const cancelled: string[] = [];
  let next = 1000;
  let commits = 0;
  const store = {
    assets,
    contents,
    released,
    cancelled,
    async beginOriginal(input: {
      owner: AssetOwner;
      name: string;
      mimeType: string;
      size: number;
    }) {
      const id = opaque(++next);
      staging.set(id, {
        kind: "original",
        name: input.name,
        mimeType: input.mimeType,
        size: input.size,
        originalId: null,
        originalSha256: null,
        bytes: new Uint8Array(),
      });
      return id;
    },
    async beginRepresentation(input: {
      owner: AssetOwner;
      name: string;
      mimeType: string;
      size: number;
      originalId: string;
      originalSha256: string;
    }) {
      const id = opaque(++next);
      staging.set(id, {
        kind: "representation",
        name: input.name,
        mimeType: input.mimeType,
        size: input.size,
        originalId: input.originalId,
        originalSha256: input.originalSha256,
        bytes: new Uint8Array(),
      });
      return id;
    },
    async append(id: string, _owner: AssetOwner, offset: number, chunk: Uint8Array) {
      const stage = staging.get(id)!;
      expect(offset).toBe(stage.bytes.byteLength);
      const nextBytes = new Uint8Array(stage.bytes.length + chunk.length);
      nextBytes.set(stage.bytes);
      nextBytes.set(chunk, stage.bytes.length);
      stage.bytes = nextBytes;
      return nextBytes.length;
    },
    async commit(id: string, owner: AssetOwner, expected: string) {
      commits++;
      if (options.failCommitAt === commits) throw new Error("simulated commit failure");
      const stage = staging.get(id)!;
      expect(sha(stage.bytes)).toBe(expected);
      const asset: FakeAsset = {
        id,
        kind: stage.kind,
        name: stage.name,
        mimeType: stage.mimeType,
        size: stage.size,
        owner,
        originalId: stage.originalId,
        originalSha256: stage.originalSha256,
      };
      assets.push(asset);
      contents.set(id, stage.bytes);
      staging.delete(id);
      return {
        ...asset,
        sha256: expected,
        createdAt: 1,
        owners: [owner],
        unownedAt: null,
      };
    },
    async cancel(id: string) {
      cancelled.push(id);
      staging.delete(id);
    },
    async releaseOwner(id: string) {
      released.push(id);
      const index = assets.findIndex((asset) => asset.id === id);
      if (index >= 0) assets.splice(index, 1);
    },
  };
  return store;
}
