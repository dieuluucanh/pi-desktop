import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAttachmentTransferStore,
  type AttachmentTransferStore,
} from "../../src/host/attachment-transfer";
import {
  ATTACHMENT_LIMITS,
  type AttachmentDeliveryScope,
  type AuthorizedAttachmentAsset,
} from "../../src/shared/attachments";
import { MAX_FRAME_BYTES } from "../../src/shared/host-protocol";

const authorityId = "123e4567-e89b-42d3-a456-426614174001";
const originalId = "123e4567-e89b-42d3-a456-426614174002";
const representationId = "123e4567-e89b-42d3-a456-426614174003";
const hash = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const stores: AttachmentTransferStore[] = [];
const wireId = (ordinal: number): string =>
  authorityId.slice(0, 24) +
  (BigInt(`0x${authorityId.slice(24)}`) ^ BigInt(ordinal)).toString(16).padStart(12, "0");
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  stores.splice(0).forEach((store) => store.dispose());
  vi.useRealTimers();
});

function fixture(size = 16, modality: "text" | "image" = "text") {
  const scope: AttachmentDeliveryScope = {
    authorityId,
    leaseId: wireId(0),
    profileKey: "a".repeat(64),
    tabId: "tab-1",
    draftId: originalId,
    hostGeneration: 1,
    processGeneration: 1,
    sessionId: "session-1",
    sessionEpoch: 1,
    branchId: null,
    revision: "revision-1",
  };
  const data = new Uint8Array(size).fill(97);
  const asset: AuthorizedAttachmentAsset = {
    original: { id: originalId, name: "fixture", kind: modality, bytes: size, sha256: hash(data) },
    representation: {
      id: representationId,
      attachmentId: originalId,
      modality,
      origin: "direct",
      bytes: size,
      originalSha256: hash(data),
      representationSha256: hash(data),
      preparationVersion: "desktop-direct-v1",
      approved: true,
      warnings: [],
    },
    image: modality === "image" ? { mime: "image/png", width: 1, height: 1 } : null,
    approvalDigest: null,
  };
  const state = { current: true, badHash: false };
  const store = createAttachmentTransferStore({
    now: () => Date.now(),
    current: (value) =>
      state.current &&
      value.profileKey === scope.profileKey &&
      value.sessionId === scope.sessionId &&
      value.sessionEpoch === scope.sessionEpoch &&
      value.revision === scope.revision,
    sha256: (value) => (state.badHash ? "0".repeat(64) : hash(value)),
    schedule: (delay, callback) => {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    },
  });
  stores.push(store);
  const begin = (ordinal = 0, assets = [asset]) =>
    store.begin({
      id: wireId(ordinal),
      scope: { ...scope, leaseId: wireId(ordinal) },
      expiresAt: Date.now() + 30_000,
      assets,
    });
  return { store, scope, asset, data, state, begin };
}

describe("bounded private attachment transfer receiver", () => {
  it("stages a multi-megabyte representation using bounded canonical chunks, then reads exact bytes", async () => {
    // Transport-only fixture: image/raster validity remains the preparation and
    // materializer's responsibility; this proves bounded byte transport, not SDK delivery.
    const h = fixture(2 * 1024 * 1024, "image");
    h.begin();
    let frames = 0;
    for (let offset = 0; offset < h.data.length; offset += ATTACHMENT_LIMITS.importChunkBytes) {
      const encoded = Buffer.from(
        h.data.subarray(offset, offset + ATTACHMENT_LIMITS.importChunkBytes),
      ).toString("base64");
      const frame = JSON.stringify({
        id: frames,
        method: "private attachment chunk",
        params: { id: wireId(0), representationId, offset, encoded },
      });
      expect(Buffer.byteLength(frame)).toBeLessThan(MAX_FRAME_BYTES);
      expect(encoded.length).toBeLessThanOrEqual(
        Math.ceil(ATTACHMENT_LIMITS.importChunkBytes / 3) * 4,
      );
      h.store.chunk(wireId(0), representationId, offset, encoded);
      frames++;
    }
    expect(frames).toBe(8);
    const reader = h.store.seal(wireId(0));
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < h.data.length; offset += ATTACHMENT_LIMITS.importChunkBytes) {
      chunks.push(
        await reader.readChunk(
          representationId,
          offset,
          Math.min(ATTACHMENT_LIMITS.importChunkBytes, h.data.length - offset),
        ),
      );
    }
    expect(hash(Buffer.concat(chunks))).toBe(hash(h.data));
    expect(h.store.stats()).toEqual({ slots: 1, reservedBytes: h.data.length });
    reader.close();
    expect(h.store.stats()).toEqual({ slots: 0, reservedBytes: 0 });
  });

  it("supports an explicitly empty text representation without inventing content", async () => {
    const h = fixture(0);
    h.begin();
    const reader = h.store.seal(wireId(0));
    expect(reader.assets[0]?.representation.bytes).toBe(0);
    expect(await reader.isCurrent()).toBe(true);
    reader.close();
  });

  it("rejects premature sealing and digest mismatch while releasing reservations", () => {
    const h = fixture();
    h.begin();
    expect(() => h.store.seal(wireId(0))).toThrow();
    expect(h.store.stats().slots).toBe(0);
    h.begin(1);
    h.store.chunk(wireId(1), representationId, 0, Buffer.from(h.data).toString("base64"));
    h.state.badHash = true;
    expect(() => h.store.seal(wireId(1))).toThrow();
    expect(h.store.stats().reservedBytes).toBe(0);
  });

  it.each(["offset", "representation", "noncanonical", "oversized", "overflow"] as const)(
    "rejects %s chunks and invalidates the transfer permanently",
    (kind) => {
      const h = fixture();
      h.begin();
      const encoded =
        kind === "noncanonical"
          ? "YQ"
          : Buffer.from(
              kind === "oversized"
                ? new Uint8Array(ATTACHMENT_LIMITS.importChunkBytes + 1)
                : kind === "overflow"
                  ? new Uint8Array(h.data.length + 1)
                  : h.data,
            ).toString("base64");
      expect(() =>
        h.store.chunk(
          wireId(0),
          kind === "representation" ? originalId : representationId,
          kind === "offset" ? 1 : 0,
          encoded,
        ),
      ).toThrow();
      expect(h.store.stats().slots).toBe(0);
      expect(() => h.store.seal(wireId(0))).toThrow();
    },
  );

  it("wipes decoded temporary bytes even when canonical validation rejects a chunk", () => {
    const h = fixture();
    h.begin();
    const temporary = Buffer.from([1, 2, 3]);
    const decode = vi.spyOn(Buffer, "from").mockReturnValueOnce(temporary);
    try {
      expect(() => h.store.chunk(wireId(0), representationId, 0, "AA==")).toThrow();
    } finally {
      decode.mockRestore();
    }
    expect([...temporary]).toEqual([0, 0, 0]);
    expect(h.store.stats().slots).toBe(0);
  });

  it("rejects replayed chunks and ordered-read violations", async () => {
    const h = fixture();
    h.begin();
    h.store.chunk(
      wireId(0),
      representationId,
      0,
      Buffer.from(h.data.subarray(0, 1)).toString("base64"),
    );
    expect(() => h.store.chunk(wireId(0), representationId, 0, "YQ==")).toThrow();
    h.begin(1);
    h.store.chunk(wireId(1), representationId, 0, Buffer.from(h.data).toString("base64"));
    const reader = h.store.seal(wireId(1));
    await expect(reader.readChunk(representationId, 1, 1)).rejects.toThrow();
    expect(h.store.stats().slots).toBe(0);
  });

  it("reserves a bounded number of transfers and refuses retired IDs without lifetime tombstones", () => {
    const h = fixture();
    h.begin(0);
    h.begin(1);
    expect(() => h.begin(2)).toThrow();
    expect(h.store.stats()).toEqual({ slots: 2, reservedBytes: h.data.length * 2 });
    h.store.cancel(wireId(0));
    expect(() => h.begin(0)).toThrow();
    h.begin(3);
    h.store.cancel(wireId(0));
    expect(h.store.stats().slots).toBe(2);
    expect(() =>
      h.store.begin({
        id: wireId(4),
        scope: { ...h.scope, authorityId: originalId },
        expiresAt: Date.now() + 30_000,
        assets: [h.asset],
      }),
    ).toThrow();
  });

  it("drops unknown metadata fields and snapshots all expected digests before later caller mutation", async () => {
    const h = fixture();
    const asset = { ...h.asset, unwanted: { bytes: "not part of the contract" } };
    h.begin(0, [asset]);
    (asset.representation as { representationSha256: string }).representationSha256 = "0".repeat(
      64,
    );
    h.store.chunk(wireId(0), representationId, 0, Buffer.from(h.data).toString("base64"));
    const reader = h.store.seal(wireId(0));
    expect(reader.assets[0]).not.toHaveProperty("unwanted");
    expect(reader.assets[0]?.representation.representationSha256).toBe(hash(h.data));
  });

  it.each(["text", "image"] as const)(
    "rejects over-limit %s metadata before any payload allocation",
    (kind) => {
      const h = fixture(1, kind);
      const asset = {
        ...h.asset,
        representation: {
          ...h.asset.representation,
          bytes:
            kind === "text"
              ? ATTACHMENT_LIMITS.promptTextBytesPerFile + 1
              : ATTACHMENT_LIMITS.imageOriginalBytes + 1,
        },
      };
      expect(() => h.begin(0, [asset])).toThrow();
      expect(h.store.stats()).toEqual({ slots: 0, reservedBytes: 0 });
    },
  );

  it("revokes on host context loss, expires hard, and never revives a stale reader", async () => {
    const h = fixture();
    h.begin();
    h.store.chunk(wireId(0), representationId, 0, Buffer.from(h.data).toString("base64"));
    const reader = h.store.seal(wireId(0));
    h.state.current = false;
    expect(await reader.isCurrent()).toBe(false);
    h.state.current = true;
    expect(await reader.isCurrent()).toBe(false);
    h.begin(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.store.stats().slots).toBe(0);
    expect(() => h.store.seal(wireId(1))).toThrow();
    h.store.dispose();
    expect(() => h.begin(2)).toThrow();
  });

  it("refuses forged scope fields and unsupported conversion representations", () => {
    const h = fixture();
    expect(() =>
      h.store.begin({
        id: wireId(0),
        scope: { ...h.scope, sessionEpoch: 2 },
        expiresAt: Date.now() + 30_000,
        assets: [h.asset],
      }),
    ).toThrow();
    expect(() =>
      h.begin(0, [
        { ...h.asset, representation: { ...h.asset.representation, origin: "converted" } },
      ]),
    ).toThrow();
    expect(h.store.stats().slots).toBe(0);
  });
});
