import { ATTACHMENT_LIMITS } from "../shared/attachments";
import { inspectRaster } from "../attachments/image";
import { verifyPngInflation } from "../attachments/png-inflate";

export interface LegacyImageDto {
  readonly type: "image";
  readonly mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  /** Canonical base64, matching Pi's public ImageContent contract. */
  readonly data: string;
}

export class LegacyImageCompatibilityError extends Error {
  constructor() {
    super("legacy image input is invalid or exceeds the compatibility limit");
    this.name = "LegacyImageCompatibilityError";
  }
}

const MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_ENCODED_IMAGE_BYTES = Math.ceil(ATTACHMENT_LIMITS.imageOriginalBytes / 3) * 4;

function invalid(): never {
  throw new LegacyImageCompatibilityError();
}

/**
 * Bounded compatibility adapter for the old renderer `prompt.images` DTO.
 * New attachments use the main-authorized transfer/plan route instead. Only
 * canonical, sniffed static rasters within app limits reach Pi's public image
 * block contract; paths, data URLs, and arbitrary renderer records are rejected.
 */
export async function validateLegacyImages(
  value: unknown,
  promptText: string,
): Promise<readonly LegacyImageDto[]> {
  if (!Array.isArray(value) || value.length > ATTACHMENT_LIMITS.filesPerDraft) return invalid();
  const textBytes = new TextEncoder().encode(promptText).byteLength;
  if (textBytes > ATTACHMENT_LIMITS.estimatedRequestBytes) return invalid();
  let encodedTotal = 0;
  const images: LegacyImageDto[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return invalid();
    const record = candidate as Record<string, unknown>;
    if (
      Object.keys(record).length !== 3 ||
      !Object.keys(record).every((key) => ["type", "mimeType", "data"].includes(key)) ||
      record.type !== "image" ||
      typeof record.mimeType !== "string" ||
      !MIME_TYPES.has(record.mimeType) ||
      typeof record.data !== "string" ||
      record.data.length === 0 ||
      record.data.length > MAX_ENCODED_IMAGE_BYTES ||
      record.data.length % 4 !== 0 ||
      !BASE64.test(record.data)
    )
      return invalid();
    const bytes = Buffer.from(record.data, "base64");
    if (
      bytes.length === 0 ||
      bytes.length > ATTACHMENT_LIMITS.imageOriginalBytes ||
      bytes.toString("base64") !== record.data
    )
      return invalid();
    encodedTotal += record.data.length;
    if (encodedTotal > ATTACHMENT_LIMITS.imageEncodedBytesTotal) return invalid();
    try {
      const raster = inspectRaster(bytes);
      if (raster.mime !== record.mimeType || raster.animated) return invalid();
      if (raster.mime === "image/png") await verifyPngInflation(raster);
    } catch {
      return invalid();
    }
    images.push(
      Object.freeze({
        type: "image",
        mimeType: record.mimeType as LegacyImageDto["mimeType"],
        data: record.data,
      }),
    );
  }
  if (textBytes + encodedTotal > ATTACHMENT_LIMITS.estimatedRequestBytes) return invalid();
  return Object.freeze(images);
}
