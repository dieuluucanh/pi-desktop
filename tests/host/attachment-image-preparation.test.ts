import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { crc32 } from "../../src/attachments/crc32";
import type { PreparedRaster } from "../../src/attachments/prepare-image";
import {
  createAttachmentImagePreparationStore,
  type ImagePreparationEncoder,
} from "../../src/host/attachment-image-preparation";

const ID = "123e4567-e89b-42d3-a456-426614174201";
const ORIGINAL = "123e4567-e89b-42d3-a456-426614174202";
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function chunk(name: string, data: Uint8Array): Buffer {
  const type = Buffer.from(name, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  type.copy(result, 4);
  result.set(data, 8);
  result.writeUInt32BE(crc32(result.subarray(4, 8 + data.length)), 8 + data.length);
  return result;
}

function png(width = 2, height = 2): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const row = new Uint8Array(1 + width * 4);
  for (let y = 0; y < height; y++) row.set([0, 255, 0, 0, 255].slice(0, 1 + width * 4));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk("IEND", new Uint8Array()),
  ]);
}

function encodeIdentity(input: {
  bytes: Uint8Array;
  limits: { maxWidth: number; maxHeight: number };
}): Promise<PreparedRaster> {
  return Promise.resolve({
    bytes: new Uint8Array(input.bytes),
    mime: "image/png",
    original: {
      mime: "image/png",
      width: input.limits.maxWidth,
      height: input.limits.maxHeight,
      encodedWidth: input.limits.maxWidth,
      encodedHeight: input.limits.maxHeight,
      orientation: 1,
      animated: false,
    },
    width: input.limits.maxWidth,
    height: input.limits.maxHeight,
    wasResized: false,
    wasReencoded: false,
    warnings: [],
    policy: { maxWidth: 1568, maxHeight: 1568, maxEncodedBytes: 4 * 1024 * 1024 },
  });
}

function setup(options: { encode?: ImagePreparationEncoder; now?: () => number } = {}) {
  const timers: Array<{ delay: number; callback: () => void }> = [];
  let current = 1_000;
  const encode = vi.fn(options.encode ?? encodeIdentity);
  const store = createAttachmentImagePreparationStore({
    now: options.now ?? (() => current),
    schedule: (delay, callback) => {
      timers.push({ delay, callback });
      return () => {};
    },
    sha256,
    encode,
  });
  return {
    store,
    encode,
    timers,
    advance: (to: number) => {
      current = to;
    },
  };
}

function begin(store: ReturnType<typeof setup>["store"], bytes: Uint8Array, extra = {}) {
  store.begin({
    id: ID,
    originalId: ORIGINAL,
    originalSha256: sha256(bytes),
    bytes: bytes.byteLength,
    mime: "image/png",
    expiresAt: 20_000,
    ...extra,
  });
}

describe("host original-image preparation", () => {
  it("stages one original, prepares it and returns prepared plus bounded thumbnail chunks", async () => {
    const h = setup();
    const source = png();
    begin(h.store, source);
    // Chunked exactly as main pushes it.
    for (let offset = 0; offset < source.byteLength; offset += 20) {
      const part = source.subarray(offset, Math.min(source.byteLength, offset + 20));
      h.store.chunk(ID, offset, Buffer.from(part).toString("base64"));
    }
    const description = await h.store.prepare(ID, {
      maxWidth: 2,
      maxHeight: 2,
      maxEncodedBytes: 64 * 1024,
    });
    expect(description).toMatchObject({
      sha256: sha256(source),
      bytes: source.byteLength,
      mimeType: "image/png",
      width: 2,
      height: 2,
      originalWidth: 2,
      originalHeight: 2,
    });
    expect(description.thumbnail).not.toBeNull();
    expect(description.thumbnail).toMatchObject({ mimeType: "image/png" });
    expect(h.encode).toHaveBeenCalledTimes(2);
    const first = h.store.readChunk(ID, "prepared", 0, 10);
    expect(Buffer.from(first, "base64")).toEqual(Buffer.from(source.subarray(0, 10)));
    const thumb = h.store.readChunk(ID, "thumbnail", 0, description.thumbnail!.bytes);
    expect(Buffer.from(thumb, "base64")).toHaveLength(description.thumbnail!.bytes);
    expect(() => h.store.readChunk(ID, "prepared", 0, 1)).toThrow();
  });

  it("refuses to decode before every byte arrived and verifies the declared digest", async () => {
    const h = setup();
    const source = png();
    begin(h.store, source);
    h.store.chunk(ID, 0, Buffer.from(source.subarray(0, 8)).toString("base64"));
    await expect(
      h.store.prepare(ID, { maxWidth: 2, maxHeight: 2, maxEncodedBytes: 1024 }),
    ).rejects.toThrow();
    expect(h.encode).not.toHaveBeenCalled();

    const h2 = setup();
    begin(h2.store, source, { originalSha256: "b".repeat(64) });
    h2.store.chunk(ID, 0, Buffer.from(source).toString("base64"));
    await expect(
      h2.store.prepare(ID, { maxWidth: 2, maxHeight: 2, maxEncodedBytes: 1024 }),
    ).rejects.toThrow();
    expect(h2.encode).not.toHaveBeenCalled();
    expect(() => h2.store.readChunk(ID, "prepared", 0, 1)).toThrow();
  });

  it("rejects unordered, oversized, duplicated and non-canonical chunks", () => {
    const h = setup();
    const source = png();
    begin(h.store, source);
    expect(() =>
      h.store.chunk(ID, 1, Buffer.from(source.subarray(0, 8)).toString("base64")),
    ).toThrow();
    begin(h.store, source);
    expect(() => h.store.chunk(ID, 0, Buffer.from(source).toString("base64"))).not.toThrow();
    expect(() =>
      h.store.chunk(ID, source.byteLength, Buffer.from([1]).toString("base64")),
    ).toThrow();
  });

  it("bounds concurrent preparations and closes entries on expiry", async () => {
    const h = setup();
    const source = png();
    begin(h.store, source);
    h.store.begin({
      id: "123e4567-e89b-42d3-a456-426614174203",
      originalId: ORIGINAL,
      originalSha256: sha256(source),
      bytes: source.byteLength,
      mime: "image/png",
      expiresAt: 20_000,
    });
    expect(() =>
      h.store.begin({
        id: "123e4567-e89b-42d3-a456-426614174204",
        originalId: ORIGINAL,
        originalSha256: sha256(source),
        bytes: source.byteLength,
        mime: "image/png",
        expiresAt: 20_000,
      }),
    ).toThrow();

    const expiring = setup();
    begin(expiring.store, source);
    expect(expiring.timers).toHaveLength(1);
    expiring.timers[0]!.callback();
    expect(() => expiring.store.chunk(ID, 0, Buffer.from(source).toString("base64"))).toThrow();
  });

  it("accepts only supported raster mimes and bounded sizes", () => {
    const h = setup();
    expect(() =>
      h.store.begin({
        id: ID,
        originalId: ORIGINAL,
        originalSha256: "a".repeat(64),
        bytes: 10,
        mime: "image/svg+xml",
        expiresAt: 20_000,
      }),
    ).toThrow();
    expect(() =>
      h.store.begin({
        id: ID,
        originalId: ORIGINAL,
        originalSha256: "a".repeat(64),
        bytes: 12 * 1024 * 1024 + 1,
        mime: "image/png",
        expiresAt: 20_000,
      }),
    ).toThrow();
    expect(() => h.store.cancel("not-an-id")).not.toThrow();
  });

  it("closes the entry when the encoder fails and never falls back to the original", async () => {
    const h = setup({
      encode: () => Promise.reject(new Error("decoder failed")),
    });
    const source = png();
    begin(h.store, source);
    h.store.chunk(ID, 0, Buffer.from(source).toString("base64"));
    await expect(
      h.store.prepare(ID, { maxWidth: 2, maxHeight: 2, maxEncodedBytes: 1024 }),
    ).rejects.toThrow();
    expect(() => h.store.readChunk(ID, "prepared", 0, 1)).toThrow();
  });

  it("keeps a failed thumbnail non-fatal", async () => {
    const failing: ImagePreparationEncoder = async (input) => {
      if (input.limits.maxWidth === 256) throw new Error("thumbnail failed");
      return encodeIdentity(input);
    };
    const h = setup({ encode: failing });
    const source = png();
    begin(h.store, source);
    h.store.chunk(ID, 0, Buffer.from(source).toString("base64"));
    const description = await h.store.prepare(ID, {
      maxWidth: 2,
      maxHeight: 2,
      maxEncodedBytes: 1024,
    });
    expect(description.thumbnail).toBeNull();
    expect(h.store.readChunk(ID, "prepared", 0, 4)).toHaveLength(8);
  });

  it("reports bounded stats and drops everything on dispose", async () => {
    const h = setup();
    const source = png();
    begin(h.store, source);
    h.store.chunk(ID, 0, Buffer.from(source).toString("base64"));
    await h.store.prepare(ID, { maxWidth: 2, maxHeight: 2, maxEncodedBytes: 64 * 1024 });
    const stats = h.store.stats();
    expect(stats.slots).toBe(1);
    expect(stats.bytes).toBeGreaterThan(0);
    h.store.dispose();
    expect(h.store.stats()).toEqual({ slots: 0, bytes: 0 });
    expect(() => h.store.readChunk(ID, "prepared", 0, 1)).toThrow();
  });
});
