import { createInflate } from "node:zlib";
import { Readable } from "node:stream";
import { AttachmentImageError, type RasterInfo } from "./image";

/**
 * Validate PNG's compressed scanline stream without collecting expanded pixels.
 * PNG's dimensions, bit depth and interlace determine the exact inflated size.
 * This is a decompression bound, not a substitute for the image decoder.
 */
export async function verifyPngInflation(info: RasterInfo): Promise<void> {
  if (info.mime !== "image/png" || !info.png) {
    throw new AttachmentImageError("invalid_image", "PNG metadata is unavailable");
  }
  const { compressed, inflatedBytes } = info.png;
  const inputSize = compressed.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const source = Readable.from(compressed);
  const inflater = createInflate({ chunkSize: 16 * 1024 });
  let outputSize = 0;
  source.pipe(inflater);
  try {
    for await (const chunk of inflater) {
      if (!(chunk instanceof Uint8Array)) throw new Error("invalid inflation output");
      outputSize += chunk.byteLength;
      if (outputSize > inflatedBytes) throw new Error("inflated output exceeds image dimensions");
    }
    if (outputSize !== inflatedBytes || inflater.bytesWritten !== inputSize) {
      throw new Error("invalid PNG compressed data length");
    }
  } catch {
    throw new AttachmentImageError("invalid_image", "invalid or oversized PNG compressed data");
  } finally {
    source.destroy();
    inflater.destroy();
  }
}
