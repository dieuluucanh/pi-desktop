import type { ImageEncoder } from "../../src/attachments/prepare-image";
import { displayRasterDimensions, inspectRaster } from "../../src/attachments/image";

/**
 * Test fixture only: a no-transform encoder for images already within the hard
 * dimension and encoded-size limits. Production images are prepared by the Pi
 * host (`src/host/sdk/attachment-image.ts`); oversized images and BMP fail
 * closed here so tests cannot silently emulate resizing.
 */
export const boundedIdentityImageEncoder: ImageEncoder = {
  async prepare(bytes, mime, limits) {
    if (mime === "image/bmp") return null;
    const source = inspectRaster(bytes);
    const dimensions = displayRasterDimensions(source);
    const base64Bytes = Math.ceil(bytes.byteLength / 3) * 4;
    if (
      dimensions.width > limits.maxWidth ||
      dimensions.height > limits.maxHeight ||
      base64Bytes > limits.maxEncodedBytes
    ) {
      return null;
    }
    return {
      bytes: new Uint8Array(bytes),
      mime: source.mime,
      originalWidth: dimensions.width,
      originalHeight: dimensions.height,
      width: dimensions.width,
      height: dimensions.height,
      wasResized: false,
    };
  },
};
