import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createAttachmentImagePreparationStore } from "../../src/host/attachment-image-preparation";
import { createHostImageEncoder } from "../../src/main/attachment-image-host-encoder";
import { createAttachmentThumbnailCache } from "../../src/main/attachment-thumbnails";
import type { SessionHostPin } from "../../src/main/session-service";
import type { AttachmentPrivateHostMethod } from "../../src/shared/host-protocol";

const ORIGINAL = "123e4567-e89b-42d3-a456-426614174202";
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Wire the real host preparation store behind a fake pin so the test exercises
 * the actual private protocol (framing, chunking, digest checks) end to end.
 */
function fakeHost(options: { tamperDigest?: boolean; failPrepare?: boolean } = {}) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const timers: Array<() => void> = [];
  const encode = vi.fn(
    async (input: { bytes: Uint8Array; limits: { maxWidth: number; maxHeight: number } }) => {
      if (options.failPrepare) throw new Error("prepare failed");
      const thumbnail = input.limits.maxWidth <= 256;
      // A real encoder downscales; the fake returns a small bounded payload so the
      // thumbnail size guard accepts it.
      const bytes = thumbnail ? new Uint8Array(24).fill(9) : new Uint8Array(input.bytes);
      const width = thumbnail ? 16 : input.limits.maxWidth;
      const height = thumbnail ? 16 : input.limits.maxHeight;
      return {
        bytes,
        mime: "image/png" as const,
        original: {
          mime: "image/png" as const,
          width: input.limits.maxWidth,
          height: input.limits.maxHeight,
          encodedWidth: input.limits.maxWidth,
          encodedHeight: input.limits.maxHeight,
          orientation: 1,
          animated: false,
        },
        width,
        height,
        wasResized: false,
        wasReencoded: false,
        warnings: [],
        policy: { maxWidth: 1568, maxHeight: 1568, maxEncodedBytes: 4 * 1024 * 1024 },
      };
    },
  );
  const store = createAttachmentImagePreparationStore({
    now: () => 1_000,
    schedule: (_delay, callback) => {
      timers.push(callback);
      return () => {};
    },
    sha256,
    encode,
  });
  const pin: SessionHostPin = {
    tabId: "tab-1",
    generation: 1,
    processGeneration: 1,
    sessionId: "session-1",
    sessionEpoch: 1,
    attachmentDelivery: { supported: true, version: 1 },
    isCurrent: () => true,
    release: vi.fn(),
    request: async (method: AttachmentPrivateHostMethod, params: unknown) => {
      calls.push({ method, params });
      switch (method) {
        case "attachments.image.begin": {
          const input = params as Parameters<typeof store.begin>[0];
          store.begin(input);
          return { staged: true };
        }
        case "attachments.image.chunk": {
          const input = params as { id: string; offset: number; encoded: string };
          store.chunk(input.id, input.offset, input.encoded);
          return { accepted: true };
        }
        case "attachments.image.prepare": {
          const input = params as {
            id: string;
            limits: { maxWidth: number; maxHeight: number; maxEncodedBytes: number };
          };
          const description = await store.prepare(input.id, input.limits);
          return options.tamperDigest ? { ...description, sha256: "c".repeat(64) } : description;
        }
        case "attachments.image.read": {
          const input = params as {
            id: string;
            part: "prepared" | "thumbnail";
            offset: number;
            length: number;
          };
          return { encoded: store.readChunk(input.id, input.part, input.offset, input.length) };
        }
        case "attachments.image.cancel": {
          const input = params as { id: string };
          store.cancel(input.id);
          return { cancelled: true };
        }
        default:
          throw new Error(`unexpected method ${method}`);
      }
    },
  };
  return { pin, calls, encode, store, timers };
}

function source(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index++) bytes[index] = index % 251;
  return bytes;
}

describe("host image encoder", () => {
  it("stages, prepares and verifies the prepared bytes, then cancels and releases", async () => {
    const host = fakeHost();
    const thumbnails = createAttachmentThumbnailCache();
    const encoder = createHostImageEncoder(
      {
        pin: () => host.pin,
        newId: () => "123e4567-e89b-42d3-a456-426614174205",
        sha256: async (bytes) => sha256(bytes),
        thumbnails,
      },
      { tabId: "tab-1", originalId: ORIGINAL },
    );
    const bytes = source(300 * 1024);
    const result = await encoder.prepare(bytes, "image/png", {
      maxWidth: 1568,
      maxHeight: 1568,
      maxEncodedBytes: 4 * 1024 * 1024,
    });
    expect(result).toMatchObject({
      mime: "image/png",
      width: 1568,
      height: 1568,
      originalWidth: 1568,
      originalHeight: 1568,
      wasResized: false,
    });
    expect(result?.bytes).toEqual(bytes);
    const chunkCalls = host.calls.filter((call) => call.method === "attachments.image.chunk");
    expect(chunkCalls.length).toBe(2);
    expect(
      chunkCalls.every(
        (call) =>
          Buffer.from((call.params as { encoded: string }).encoded, "base64").byteLength <=
          256 * 1024,
      ),
    ).toBe(true);
    expect(host.calls.at(-1)?.method).toBe("attachments.image.cancel");
    expect(host.pin.release).toHaveBeenCalledTimes(1);
    // Thumbnail is cached by the prepared digest only.
    expect(thumbnails.get(sha256(bytes))).toMatchObject({
      mimeType: "image/png",
      width: 16,
      height: 16,
    });
  });

  it("fails closed and cleans up when the host digest does not match the bytes", async () => {
    const host = fakeHost({ tamperDigest: true });
    const encoder = createHostImageEncoder(
      {
        pin: () => host.pin,
        newId: () => "123e4567-e89b-42d3-a456-426614174206",
        sha256: async (bytes) => sha256(bytes),
        thumbnails: createAttachmentThumbnailCache(),
      },
      { tabId: "tab-1", originalId: ORIGINAL },
    );
    await expect(
      encoder.prepare(source(32), "image/png", {
        maxWidth: 64,
        maxHeight: 64,
        maxEncodedBytes: 1024,
      }),
    ).rejects.toThrow();
    expect(host.calls.at(-1)?.method).toBe("attachments.image.cancel");
    expect(host.pin.release).toHaveBeenCalledTimes(1);
  });

  it("fails closed when preparation itself fails", async () => {
    const host = fakeHost({ failPrepare: true });
    const encoder = createHostImageEncoder(
      {
        pin: () => host.pin,
        newId: () => "123e4567-e89b-42d3-a456-426614174207",
        sha256: async (bytes) => sha256(bytes),
        thumbnails: createAttachmentThumbnailCache(),
      },
      { tabId: "tab-1", originalId: ORIGINAL },
    );
    await expect(
      encoder.prepare(source(8), "image/png", {
        maxWidth: 8,
        maxHeight: 8,
        maxEncodedBytes: 1024,
      }),
    ).rejects.toThrow();
    expect(host.pin.release).toHaveBeenCalledTimes(1);
  });

  it("refuses a source above the application original limit without touching the host", async () => {
    const host = fakeHost();
    const encoder = createHostImageEncoder(
      {
        pin: () => host.pin,
        newId: () => "123e4567-e89b-42d3-a456-426614174208",
        sha256: async (bytes) => sha256(bytes),
        thumbnails: createAttachmentThumbnailCache(),
      },
      { tabId: "tab-1", originalId: ORIGINAL },
    );
    await expect(
      encoder.prepare(new Uint8Array(12 * 1024 * 1024 + 1), "image/png", {
        maxWidth: 64,
        maxHeight: 64,
        maxEncodedBytes: 1024,
      }),
    ).rejects.toThrow();
    expect(host.calls).toHaveLength(0);
    expect(host.pin.release).not.toHaveBeenCalled();
  });
});

describe("host image encoder negotiation", () => {
  it("refuses an unsupported host before staging a single byte", async () => {
    const host = fakeHost();
    const pin = {
      ...host.pin,
      attachmentDelivery: { supported: false as const, reason: "old" as const },
    };
    const encoder = createHostImageEncoder(
      {
        pin: () => pin,
        newId: () => "123e4567-e89b-42d3-a456-426614174209",
        sha256: async (bytes) => sha256(bytes),
        thumbnails: createAttachmentThumbnailCache(),
      },
      { tabId: "tab-1", originalId: ORIGINAL },
    );
    await expect(
      encoder.prepare(source(8), "image/png", {
        maxWidth: 8,
        maxHeight: 8,
        maxEncodedBytes: 1024,
      }),
    ).rejects.toThrow();
    expect(host.calls).toHaveLength(0);
    expect(pin.release).toHaveBeenCalledTimes(1);
  });
});
