import { ATTACHMENT_LIMITS, type AttachmentImagePreparationLimits } from "../shared/attachments";
import {
  AttachmentImageError,
  displayRasterDimensions,
  inspectRaster,
  type RasterMime,
} from "./image";
import { verifyPngInflation } from "./png-inflate";

/** Conservative application ceilings apply even when a model reports no limits. */
export const DEFAULT_IMAGE_PREPARATION_LIMITS = {
  maxWidth: 1568,
  maxHeight: 1568,
  maxEncodedBytes: 4 * 1024 * 1024,
} as const;

/** Bounded thumbnail derived from an already prepared image, never an original. */
export const IMAGE_THUMBNAIL_LIMITS: AttachmentImagePreparationLimits = {
  maxWidth: ATTACHMENT_LIMITS.thumbnailMaxDimension,
  maxHeight: ATTACHMENT_LIMITS.thumbnailMaxDimension,
  maxEncodedBytes: ATTACHMENT_LIMITS.previewBytes,
};

export type ImagePreparationLimits = AttachmentImagePreparationLimits;

export interface ImageEncoderResult {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly width: number;
  readonly height: number;
  readonly wasResized: boolean;
}

/** The concrete Pi SDK implementation belongs in src/host/sdk. */
export interface ImageEncoder {
  prepare(
    bytes: Uint8Array,
    mime: RasterMime,
    limits: ImagePreparationLimits,
  ): Promise<ImageEncoderResult | null>;
}

export interface PreparedRaster {
  readonly bytes: Uint8Array;
  readonly mime: Exclude<RasterMime, "image/bmp">;
  readonly original: {
    readonly mime: RasterMime;
    /** Display dimensions after applying EXIF orientation. */
    readonly width: number;
    readonly height: number;
    readonly encodedWidth: number;
    readonly encodedHeight: number;
    readonly orientation: number;
    readonly animated: boolean;
  };
  readonly width: number;
  readonly height: number;
  readonly wasResized: boolean;
  readonly wasReencoded: boolean;
  readonly warnings: readonly string[];
  /** Effective ceiling used for this preparation; a model policy may narrow it. */
  readonly policy: ImagePreparationLimits;
}

/** Canonical policy string hashed into persisted provenance. */
export function imagePreparationPolicy(limits: ImagePreparationLimits): string {
  return `desktop-image-policy-v1:${limits.maxWidth}x${limits.maxHeight}:${limits.maxEncodedBytes}`;
}

/** Reject malformed reported model limits, then clamp them to the app ceiling. */
export function imagePreparationLimits(
  input: Partial<ImagePreparationLimits> = {},
): ImagePreparationLimits {
  const bounded = (value: number | undefined, ceiling: number): number => {
    if (value === undefined) return ceiling;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new AttachmentImageError("preparation_failed", "invalid model image limit");
    }
    return Math.min(value, ceiling);
  };
  return {
    maxWidth: bounded(input.maxWidth, DEFAULT_IMAGE_PREPARATION_LIMITS.maxWidth),
    maxHeight: bounded(input.maxHeight, DEFAULT_IMAGE_PREPARATION_LIMITS.maxHeight),
    maxEncodedBytes: bounded(
      input.maxEncodedBytes,
      DEFAULT_IMAGE_PREPARATION_LIMITS.maxEncodedBytes,
    ),
  };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

/**
 * Validate the source before calling a decoder, and independently validate its
 * output. A failed decoder, invalid metadata, mismatch or over-limit output is
 * an error: there is deliberately no fallback to the original payload.
 */
export async function prepareRasterImage(
  original: Uint8Array,
  encoder: ImageEncoder,
  modelLimits: Partial<ImagePreparationLimits> = {},
): Promise<PreparedRaster> {
  const limits = imagePreparationLimits(modelLimits);
  if (
    !(original instanceof Uint8Array) ||
    original.byteLength > ATTACHMENT_LIMITS.imageOriginalBytes
  ) {
    throw new AttachmentImageError("image_too_large", "image exceeds the original byte limit");
  }
  // Keep the exact bytes inspected stable across asynchronous inflation/decoding.
  const sourceBytes = new Uint8Array(original);
  const source = inspectRaster(sourceBytes);
  if (source.mime === "image/png") await verifyPngInflation(source);
  let result: ImageEncoderResult | null;
  try {
    // The encoder never receives the caller's immutable original buffer.
    result = await encoder.prepare(new Uint8Array(sourceBytes), source.mime, limits);
  } catch {
    throw new AttachmentImageError("preparation_failed", "image decoder failed");
  }
  if (!result || !(result.bytes instanceof Uint8Array)) {
    throw new AttachmentImageError("preparation_failed", "image could not be prepared");
  }
  const encodedBytes = Math.ceil(result.bytes.byteLength / 3) * 4;
  if (encodedBytes > limits.maxEncodedBytes) {
    throw new AttachmentImageError(
      "image_too_large",
      "prepared image exceeds the encoded byte limit",
    );
  }
  const preparedBytes = new Uint8Array(result.bytes);
  const { mime, originalWidth, originalHeight, width, height, wasResized } = result;
  const actual = inspectRaster(preparedBytes);
  if (actual.mime === "image/png") await verifyPngInflation(actual);
  const sourceDisplay = displayRasterDimensions(source);
  const actualDisplay = displayRasterDimensions(actual);
  if (
    actual.mime === "image/bmp" ||
    mime !== actual.mime ||
    actualDisplay.width !== width ||
    actualDisplay.height !== height ||
    originalWidth !== sourceDisplay.width ||
    originalHeight !== sourceDisplay.height ||
    actual.width > limits.maxWidth ||
    actual.height > limits.maxHeight ||
    actualDisplay.width > limits.maxWidth ||
    actualDisplay.height > limits.maxHeight ||
    typeof wasResized !== "boolean" ||
    (!wasResized && (width !== sourceDisplay.width || height !== sourceDisplay.height))
  ) {
    throw new AttachmentImageError(
      "preparation_failed",
      "prepared image does not match its declared limits or metadata",
    );
  }
  const wasReencoded = !sameBytes(sourceBytes, preparedBytes);
  const warnings: string[] = [];
  if (source.animated)
    warnings.push(
      wasReencoded
        ? "Animation may be flattened by image preparation."
        : "Models may use only the first animation frame.",
    );
  if (wasReencoded && actual.mime === "image/jpeg") {
    warnings.push("Image preparation uses lossy JPEG encoding; transparency may be lost.");
  }
  if (source.mime === "image/bmp") warnings.push("BMP was converted to a supported image format.");
  return {
    bytes: preparedBytes,
    mime: actual.mime,
    original: {
      mime: source.mime,
      width: sourceDisplay.width,
      height: sourceDisplay.height,
      encodedWidth: source.width,
      encodedHeight: source.height,
      orientation: source.orientation ?? 1,
      animated: source.animated,
    },
    width: actualDisplay.width,
    height: actualDisplay.height,
    wasResized,
    wasReencoded,
    warnings,
    policy: limits,
  };
}
