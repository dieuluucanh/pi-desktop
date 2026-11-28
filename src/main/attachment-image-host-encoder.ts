import {
  ATTACHMENT_LIMITS,
  validateAttachmentImagePreparationDescription,
} from "../shared/attachments";
import { MAX_FRAME_BYTES } from "../shared/host-protocol";
import type { ImageEncoder, ImageEncoderResult } from "../attachments/prepare-image";
import type { RasterMime } from "../attachments/image";
import type { SessionHostPin } from "./session-service";
import type { AttachmentThumbnailCache } from "./attachment-thumbnails";

/**
 * Main-side adapter for the public SDK image preparation that runs in the Pi
 * host process. Main never imports the SDK: it stages one owner-checked
 * original over the private parent channel, then pulls and independently
 * re-validates the prepared bytes (`prepareRasterImage` inspects and hashes the
 * result again before anything is persisted).
 *
 * A lost reply is ambiguous, so the staging entry is always cancelled in
 * `finally`; a cancel that races a timeout is inert on the host.
 */

const CHUNK = ATTACHMENT_LIMITS.importChunkBytes;

export class HostImagePreparationError extends Error {
  readonly code = "preparation_failed";
  constructor() {
    super("host image preparation is unavailable");
    this.name = "HostImagePreparationError";
  }
}

function fail(): never {
  throw new HostImagePreparationError();
}

function frameFits(method: string, params: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify({ id: 1, method, params })) < MAX_FRAME_BYTES;
  } catch {
    return false;
  }
}

async function request(
  pin: SessionHostPin,
  method:
    | "attachments.image.begin"
    | "attachments.image.chunk"
    | "attachments.image.prepare"
    | "attachments.image.read",
  params: unknown,
): Promise<unknown> {
  if (!frameFits(method, params)) return fail();
  const response = await pin.request(method, params);
  if (response === undefined || response === null) return fail();
  return response;
}

/** Pull one bounded part, verifying the transport's canonical base64 framing. */
async function pull(
  pin: SessionHostPin,
  id: string,
  part: "prepared" | "thumbnail",
  total: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(total) || total <= 0) return fail();
  const output = new Uint8Array(total);
  let offset = 0;
  while (offset < total) {
    const length = Math.min(CHUNK, total - offset);
    const raw = await request(pin, "attachments.image.read", { id, part, offset, length });
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail();
    const record = raw as Record<string, unknown>;
    if (
      Object.keys(record).length !== 1 ||
      !Object.keys(record).every((key) => key === "encoded") ||
      typeof record.encoded !== "string"
    )
      return fail();
    const data = Buffer.from(record.encoded, "base64");
    if (data.length !== length || data.toString("base64") !== record.encoded) return fail();
    output.set(data, offset);
    data.fill(0);
    offset += length;
  }
  return output;
}

export interface HostImageEncoderDeps {
  /** Pin the already-ready session host; never wakes a tab or starts a host. */
  pin(): SessionHostPin;
  newId(): string;
  sha256(bytes: Uint8Array): Promise<string>;
  thumbnails: AttachmentThumbnailCache;
  now?(): number;
}

export function createHostImageEncoder(
  deps: HostImageEncoderDeps,
  scope: { readonly tabId: string; readonly originalId: string },
): ImageEncoder {
  return {
    async prepare(
      bytes: Uint8Array,
      mime: RasterMime,
      limits: { maxWidth: number; maxHeight: number; maxEncodedBytes: number },
    ): Promise<ImageEncoderResult | null> {
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength === 0 ||
        bytes.byteLength > ATTACHMENT_LIMITS.imageOriginalBytes ||
        typeof scope.tabId !== "string" ||
        typeof scope.originalId !== "string"
      )
        return fail();
      const id = deps.newId();
      const pin = deps.pin();
      // Protocol negotiation happens before any staging, including preview
      // preparation, so an old host never receives original image bytes.
      if (!pin.attachmentDelivery.supported) {
        pin.release();
        return fail();
      }
      let staged = false;
      try {
        const originalSha256 = await deps.sha256(new Uint8Array(bytes));
        if (!/^[0-9a-f]{64}$/.test(originalSha256)) return fail();
        // A timeout may still have staged bytes on the host: mark cleanup first.
        staged = true;
        await request(pin, "attachments.image.begin", {
          id,
          originalId: scope.originalId,
          originalSha256,
          bytes: bytes.byteLength,
          mime,
          expiresAt: (deps.now?.() ?? Date.now()) + ATTACHMENT_LIMITS.imagePreparationLifetimeMs,
        });
        for (let offset = 0; offset < bytes.byteLength; offset += CHUNK) {
          const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + CHUNK));
          await request(pin, "attachments.image.chunk", {
            id,
            offset,
            encoded: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString(
              "base64",
            ),
          });
        }
        const description = validateAttachmentImagePreparationDescription(
          await request(pin, "attachments.image.prepare", { id, limits }),
        );
        if (!description) return fail();
        const prepared = await pull(pin, id, "prepared", description.bytes);
        if ((await deps.sha256(new Uint8Array(prepared))) !== description.sha256) return fail();
        if (description.thumbnail) {
          const thumbnail = description.thumbnail;
          try {
            const thumbnailBytes = await pull(pin, id, "thumbnail", thumbnail.bytes);
            if ((await deps.sha256(new Uint8Array(thumbnailBytes))) === thumbnail.sha256) {
              deps.thumbnails.put(description.sha256, {
                bytes: thumbnailBytes,
                mimeType: thumbnail.mimeType,
                width: thumbnail.width,
                height: thumbnail.height,
              });
            }
          } catch {
            // A thumbnail is a preview convenience; it must never fail delivery.
          }
        }
        return {
          bytes: prepared,
          mime: description.mimeType,
          originalWidth: description.originalWidth,
          originalHeight: description.originalHeight,
          width: description.width,
          height: description.height,
          wasResized:
            description.width !== description.originalWidth ||
            description.height !== description.originalHeight,
        };
      } finally {
        if (staged) {
          try {
            await pin.request("attachments.image.cancel", { id });
          } catch {
            // The host's fixed expiry handles a lost or late cancel.
          }
        }
        pin.release();
      }
    },
  };
}
