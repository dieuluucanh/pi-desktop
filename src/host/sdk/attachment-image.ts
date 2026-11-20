import { convertToPng, resizeImage } from "@earendil-works/pi-coding-agent";
import type {
  ImageEncoder,
  ImageEncoderResult,
  ImagePreparationLimits,
} from "../../attachments/prepare-image";
import type { RasterMime } from "../../attachments/image";
import { ATTACHMENT_LIMITS } from "../../shared/attachments";

interface PiImageFunctions {
  convert: typeof convertToPng;
  resize: typeof resizeImage;
}

function decodeBase64(data: unknown, maxBytes: number): Uint8Array | null {
  if (typeof data !== "string" || data.length === 0 || data.length > Math.ceil(maxBytes / 3) * 4)
    return null;
  const bytes = Buffer.from(data, "base64");
  if (bytes.byteLength > maxBytes || bytes.toString("base64") !== data) return null;
  return new Uint8Array(bytes);
}

/** Pi's public image APIs only; no private SDK imports or provider payloads. */
export function createSdkImageEncoder(
  sdk: PiImageFunctions = { convert: convertToPng, resize: resizeImage },
): ImageEncoder {
  return {
    async prepare(
      bytes: Uint8Array,
      mime: RasterMime,
      limits: ImagePreparationLimits,
    ): Promise<ImageEncoderResult | null> {
      let input = bytes;
      let inputMime: string = mime;
      if (mime === "image/bmp") {
        const png = await sdk.convert(Buffer.from(bytes).toString("base64"), mime);
        if (!png || png.mimeType !== "image/png") return null;
        const converted = decodeBase64(png.data, ATTACHMENT_LIMITS.imageOriginalBytes);
        if (!converted) return null;
        input = converted;
        inputMime = "image/png";
      }
      const resized = await sdk.resize(input, inputMime, {
        maxWidth: limits.maxWidth,
        maxHeight: limits.maxHeight,
        maxBytes: limits.maxEncodedBytes,
      });
      if (!resized || resized.data.length > limits.maxEncodedBytes) return null;
      const output = decodeBase64(resized.data, ATTACHMENT_LIMITS.imageOriginalBytes);
      if (!output) return null;
      return {
        bytes: output,
        mime: resized.mimeType,
        originalWidth: resized.originalWidth,
        originalHeight: resized.originalHeight,
        width: resized.width,
        height: resized.height,
        wasResized: resized.wasResized,
      };
    },
  };
}
