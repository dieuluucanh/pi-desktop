/**
 * Image attachments (plan step 6).
 *
 * A pasted or dropped image becomes base64 PNG/JPEG data for `prompt`'s `images`
 * parameter — the host already forwards those straight to the SDK, so no new
 * protocol surface is needed. Images are downscaled first: a 12 MB screenshot
 * sent at full resolution wastes context and can exceed the provider's limit.
 *
 * The resizing half is best effort by design: without `createImageBitmap` or a
 * canvas (jsdom, an exotic runtime) the original data is used unchanged.
 */

/** Longest edge kept when downscaling; matches what vision APIs accept well. */
export const MAX_IMAGE_EDGE = 1568;
export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;

export interface ImageAttachment {
  id: string;
  name: string;
  mimeType: string;
  /** Base64 without the data-URL prefix. */
  data: string;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

/** MIME type for a file name, or null when it is not an image we accept. */
export function imageMimeFromName(name: string): string | null {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? null;
}

export function isImageFile(file: { name: string; type?: string }): boolean {
  if (typeof file.type === "string" && file.type.startsWith("image/")) return true;
  return imageMimeFromName(file.name) !== null;
}

/** Base64 payload of a data URL (`data:image/png;base64,AAAA` → `AAAA`). */
export function dataUrlPayload(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? "" : dataUrl.slice(comma + 1);
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("could not read the image"));
    reader.readAsDataURL(file);
  });
}

/**
 * True when this runtime can decode and resize images. Chromium (the app) can;
 * jsdom cannot, and without this guard the decode promise would never settle
 * there (jsdom's `Image` never fires load for a data URL).
 */
function canDecodeImages(): boolean {
  if (typeof document === "undefined" || typeof Image === "undefined") return false;
  try {
    return document.createElement("canvas").getContext("2d") !== null;
  } catch {
    return false;
  }
}

/**
 * Downscales a data URL when the runtime can do it, and returns the input
 * unchanged otherwise (so a missing canvas never loses the attachment).
 */
export async function downscaleDataUrl(
  dataUrl: string,
  mimeType: string,
  maxEdge: number = MAX_IMAGE_EDGE,
): Promise<{ dataUrl: string; mimeType: string }> {
  if (!canDecodeImages()) {
    return { dataUrl, mimeType };
  }
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("could not decode the image"));
      element.src = dataUrl;
    });
    const longest = Math.max(image.width, image.height);
    if (longest <= maxEdge) return { dataUrl, mimeType };

    const scale = maxEdge / longest;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    const context = canvas.getContext("2d");
    if (!context) return { dataUrl, mimeType };
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    // JPEG keeps screenshots small; PNG stays lossless for diagrams.
    const target = mimeType === "image/png" ? "image/png" : "image/jpeg";
    return { dataUrl: canvas.toDataURL(target, 0.9), mimeType: target };
  } catch {
    return { dataUrl, mimeType };
  }
}

/** Converts a file into an attachment, or null when it is not a usable image. */
export async function fileToAttachment(file: File): Promise<ImageAttachment | null> {
  const declared =
    imageMimeFromName(file.name) ?? (file.type.startsWith("image/") ? file.type : null);
  if (!declared) return null;
  if (file.size > MAX_ATTACHMENT_BYTES) return null;
  const raw = await readAsDataUrl(file);
  if (raw.length === 0) return null;
  const { dataUrl, mimeType } = await downscaleDataUrl(raw, declared);
  return {
    id: `${file.name}:${file.size}:${dataUrl.length}`,
    name: file.name,
    mimeType,
    data: dataUrlPayload(dataUrl),
  };
}
