import { ATTACHMENT_LIMITS } from "../shared/attachments";
import { crc32 } from "./crc32";

export type RasterMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp";
export type AttachmentImageErrorCode =
  | "invalid_image"
  | "unsupported_image"
  | "image_too_large"
  | "animation_unsupported"
  | "preparation_failed";

export class AttachmentImageError extends Error {
  readonly code: AttachmentImageErrorCode;
  constructor(code: AttachmentImageErrorCode, message: string) {
    super(message);
    this.name = "AttachmentImageError";
    this.code = code;
  }
}

export interface RasterInfo {
  readonly mime: RasterMime;
  readonly width: number;
  readonly height: number;
  readonly animated: boolean;
  /** JPEG EXIF orientation, when present. Dimensions above are stored pixels. */
  readonly orientation?: number;
  /** Present only for PNG; checked with streaming inflation before decoding. */
  readonly png?: { readonly compressed: readonly Uint8Array[]; readonly inflatedBytes: number };
}

const MAX_EDGE = 32_768;
const MAX_EXPANDED_BYTES = 160 * 1024 * 1024;

function invalid(message = "invalid image structure"): never {
  throw new AttachmentImageError("invalid_image", message);
}
function large(): never {
  throw new AttachmentImageError(
    "image_too_large",
    "image dimensions or decoded size exceed the limit",
  );
}
function unsupported(message: string): never {
  throw new AttachmentImageError("unsupported_image", message);
}
function byte(bytes: Uint8Array, offset: number): number {
  const value = bytes[offset];
  if (value === undefined) return invalid("truncated image");
  return value;
}
function u16le(bytes: Uint8Array, offset: number): number {
  return byte(bytes, offset) + byte(bytes, offset + 1) * 256;
}
function u32le(bytes: Uint8Array, offset: number): number {
  return u16le(bytes, offset) + u16le(bytes, offset + 2) * 65536;
}
function u32be(bytes: Uint8Array, offset: number): number {
  return (
    byte(bytes, offset) * 16777216 +
    byte(bytes, offset + 1) * 65536 +
    byte(bytes, offset + 2) * 256 +
    byte(bytes, offset + 3)
  );
}
function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || length < 0 || offset + length > bytes.length) return invalid("truncated image");
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}
function dimensions(width: number, height: number, frames = 1): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0)
    invalid();
  if (
    width > MAX_EDGE ||
    height > MAX_EDGE ||
    width * height * frames > ATTACHMENT_LIMITS.imagePixels
  )
    large();
}

/** Signatures identify candidates only; full validation and decoding are still required. */
export function detectRasterMime(bytes: Uint8Array): RasterMime | null {
  if (
    bytes.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)
  )
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a"))
    return "image/gif";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP")
    return "image/webp";
  if (bytes.length >= 18 && ascii(bytes, 0, 2) === "BM" && u32le(bytes, 2) === bytes.length)
    return "image/bmp";
  return null;
}

function pngInflatedSize(width: number, height: number, bits: number, interlace: number): number {
  const passes =
    interlace === 0
      ? [[0, 0, 1, 1]]
      : [
          [0, 0, 8, 8],
          [4, 0, 8, 8],
          [0, 4, 4, 8],
          [2, 0, 4, 4],
          [0, 2, 2, 4],
          [1, 0, 2, 2],
          [0, 1, 1, 2],
        ];
  let total = 0;
  for (const pass of passes) {
    const [x = 0, y = 0, dx = 1, dy = 1] = pass;
    const w = Math.max(0, Math.ceil((width - x) / dx));
    const h = Math.max(0, Math.ceil((height - y) / dy));
    if (w && h) total += (1 + Math.ceil((w * bits) / 8)) * h;
  }
  if (!Number.isSafeInteger(total) || total > MAX_EXPANDED_BYTES) large();
  return total;
}

function inspectPng(bytes: Uint8Array): RasterInfo {
  if (bytes.length < 45 || u32be(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== "IHDR") invalid();
  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  dimensions(width, height);
  const depth = byte(bytes, 24);
  const color = byte(bytes, 25);
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const validDepths: Record<number, number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (
    !validDepths[color]?.includes(depth) ||
    byte(bytes, 26) !== 0 ||
    byte(bytes, 27) !== 0 ||
    byte(bytes, 28) > 1
  )
    invalid();
  const inflatedBytes = pngInflatedSize(
    width,
    height,
    depth * (channels[color] ?? 0),
    byte(bytes, 28),
  );
  const compressed: Uint8Array[] = [];
  let offset = 8;
  let finished = false;
  let afterData = false;
  let palette = false;
  let chunks = 0;
  while (offset < bytes.length) {
    if (++chunks > 10_000 || offset + 12 > bytes.length) invalid();
    const length = u32be(bytes, offset);
    const end = offset + 12 + length;
    if (end > bytes.length) invalid();
    const type = ascii(bytes, offset + 4, 4);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== u32be(bytes, end - 4))
      invalid("PNG checksum mismatch");
    if (!/^[A-Za-z]{4}$/.test(type) || type.charCodeAt(2) & 0x20) invalid();
    if (offset !== 8 && type === "IHDR") invalid();
    if (type === "PLTE") {
      if (
        palette ||
        compressed.length ||
        color === 0 ||
        color === 4 ||
        length === 0 ||
        length % 3 !== 0 ||
        length > 768 ||
        (color === 3 && length > 3 * 2 ** depth)
      )
        invalid();
      palette = true;
    }
    if ((type.charCodeAt(0) & 0x20) === 0 && !["IHDR", "PLTE", "IDAT", "IEND"].includes(type))
      invalid();
    if (["acTL", "fcTL", "fdAT"].includes(type))
      throw new AttachmentImageError("animation_unsupported", "animated PNG is not supported");
    if (type === "IDAT") {
      if (afterData || (color === 3 && !palette)) invalid();
      compressed.push(bytes.subarray(offset + 8, end - 4));
    } else if (compressed.length) {
      afterData = true;
    }
    if (type === "IEND") {
      if (length !== 0 || end !== bytes.length || compressed.length === 0) invalid();
      finished = true;
      break;
    }
    offset = end;
  }
  if (!finished) invalid();
  return { mime: "image/png", width, height, animated: false, png: { compressed, inflatedBytes } };
}

function skipGifBlocks(bytes: Uint8Array, start: number): number {
  let offset = start;
  let blocks = 0;
  for (;;) {
    const length = byte(bytes, offset++);
    if (length === 0) return offset;
    if (++blocks > 100_000) large();
    if (offset + length > bytes.length) invalid();
    offset += length;
  }
}

/** Count GIF LZW output without materializing pixels; reject expansion past the frame. */
function verifyGifPixels(
  bytes: Uint8Array,
  start: number,
  minimumBits: number,
  pixels: number,
  work: { codes: number },
): number {
  let offset = start;
  let remaining = 0;
  let blocks = 0;
  let ended = false;
  const nextByte = (): number | null => {
    if (ended) return null;
    if (remaining === 0) {
      remaining = byte(bytes, offset++);
      if (remaining === 0) {
        ended = true;
        return null;
      }
      if (++blocks > 100_000 || offset + remaining > bytes.length) invalid();
    }
    remaining--;
    return byte(bytes, offset++);
  };
  let bits = 0;
  let available = 0;
  const readCode = (length: number): number | null => {
    while (available < length) {
      const value = nextByte();
      if (value === null) return null;
      bits |= value << available;
      available += 8;
    }
    const code = bits & ((1 << length) - 1);
    bits >>>= length;
    available -= length;
    return code;
  };
  const clear = 1 << minimumBits;
  const stop = clear + 1;
  const lengths = new Uint16Array(4096);
  lengths.fill(1, 0, clear);
  let next = stop + 1;
  let codeBits = minimumBits + 1;
  let previous = -1;
  let output = 0;
  let sawClear = false;
  let sawStop = false;
  for (;;) {
    const code = readCode(codeBits);
    if (code === null) break;
    if (++work.codes > 2_000_000) large();
    if (code === clear) {
      next = stop + 1;
      codeBits = minimumBits + 1;
      previous = -1;
      sawClear = true;
      continue;
    }
    if (!sawClear) invalid();
    if (code === stop) {
      sawStop = true;
      break;
    }
    const length =
      code < clear
        ? 1
        : code < next
          ? (lengths[code] ?? 0)
          : code === next && previous >= 0
            ? (lengths[previous] ?? 0) + 1
            : 0;
    if (length === 0) invalid();
    output += length;
    if (output > pixels) invalid("GIF data exceeds its frame dimensions");
    if (previous >= 0 && next < 4096) {
      lengths[next++] = (lengths[previous] ?? 0) + 1;
      if (next === 1 << codeBits && codeBits < 12) codeBits++;
    }
    previous = code;
  }
  if (!sawStop || output !== pixels) invalid("invalid GIF compressed data");
  while (nextByte() !== null) {
    /* consume the remaining sub-blocks */
  }
  return offset;
}

function inspectGif(bytes: Uint8Array): RasterInfo {
  const width = u16le(bytes, 6);
  const height = u16le(bytes, 8);
  dimensions(width, height);
  const packed = byte(bytes, 10);
  let offset = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
  if (offset > bytes.length) invalid();
  let frames = 0;
  let finished = false;
  let items = 0;
  const work = { codes: 0 };
  while (offset < bytes.length) {
    if (++items > 10_000) large();
    const marker = byte(bytes, offset++);
    if (marker === 0x3b) {
      if (offset !== bytes.length || frames === 0) invalid();
      finished = true;
      break;
    }
    if (marker === 0x21) {
      byte(bytes, offset++); // extension label
      offset = skipGifBlocks(bytes, offset);
      continue;
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) invalid();
    const left = u16le(bytes, offset);
    const top = u16le(bytes, offset + 2);
    const frameWidth = u16le(bytes, offset + 4);
    const frameHeight = u16le(bytes, offset + 6);
    const flags = byte(bytes, offset + 8);
    if (!frameWidth || !frameHeight || left + frameWidth > width || top + frameHeight > height)
      invalid();
    frames++;
    if (frames > 256) large();
    dimensions(width, height, frames);
    offset += 9 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0);
    const codeSize = byte(bytes, offset++);
    if (codeSize < 2 || codeSize > 8) invalid();
    offset = verifyGifPixels(bytes, offset, codeSize, frameWidth * frameHeight, work);
  }
  if (!finished) invalid();
  return { mime: "image/gif", width, height, animated: frames > 1 };
}

function hasExifPrefix(bytes: Uint8Array, start: number, end: number): boolean {
  return (
    end - start >= 6 &&
    ascii(bytes, start, 4) === "Exif" &&
    byte(bytes, start + 4) === 0 &&
    byte(bytes, start + 5) === 0
  );
}

function tiffOrientation(bytes: Uint8Array, tiff: number, end: number): number | null {
  if (tiff + 8 > end) invalid();
  const order = ascii(bytes, tiff, 2);
  if (order !== "II" && order !== "MM") invalid();
  const le = order === "II";
  const short = (at: number): number => {
    if (at < tiff || at + 2 > end) invalid();
    return le ? u16le(bytes, at) : byte(bytes, at) * 256 + byte(bytes, at + 1);
  };
  const long = (at: number): number => {
    if (at < tiff || at + 4 > end) invalid();
    return le ? u32le(bytes, at) : u32be(bytes, at);
  };
  if (short(tiff + 2) !== 42) invalid();
  const relative = long(tiff + 4);
  if (relative === 0) return null;
  if (relative < 8) invalid();
  const ifd = tiff + relative;
  const count = short(ifd);
  if (count > 4096 || ifd + 2 + count * 12 + 4 > end) invalid();
  let orientation: number | null = null;
  for (let index = 0; index < count; index++) {
    const entry = ifd + 2 + index * 12;
    if (short(entry) !== 0x0112) continue;
    if (short(entry + 2) !== 3 || long(entry + 4) !== 1) invalid();
    const value = short(entry + 8);
    if (value < 1 || value > 8 || (orientation !== null && orientation !== value)) invalid();
    orientation = value;
  }
  return orientation;
}

/** Display-oriented dimensions are distinct from encoded JPEG/WebP pixel dimensions. */
export function displayRasterDimensions(info: RasterInfo): { width: number; height: number } {
  return (info.orientation ?? 1) >= 5
    ? { width: info.height, height: info.width }
    : { width: info.width, height: info.height };
}

function inspectJpeg(bytes: Uint8Array): RasterInfo {
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawScan = false;
  let finished = false;
  let orientation: number | null = null;
  let markers = 0;
  while (offset < bytes.length) {
    if (++markers > 10_000) large();
    if (byte(bytes, offset++) !== 0xff) invalid();
    while (byte(bytes, offset) === 0xff) offset++;
    const marker = byte(bytes, offset++);
    if (marker === 0xd9) {
      if (offset !== bytes.length || !sawScan || !width) invalid();
      finished = true;
      break;
    }
    if (marker === 0x00 || marker === 0xd8 || marker === 0xdc || (marker >= 0xd0 && marker <= 0xd7))
      invalid();
    if (marker === 0x01) continue;
    const length = byte(bytes, offset) * 256 + byte(bytes, offset + 1);
    if (length < 2 || offset + length > bytes.length) invalid();
    if (marker === 0xe1 && hasExifPrefix(bytes, offset + 2, offset + length)) {
      const value = tiffOrientation(bytes, offset + 8, offset + length);
      if (value !== null) {
        if (orientation !== null && orientation !== value) invalid();
        orientation = value;
      }
    }
    const sof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (sof) {
      if (width || length < 8) invalid();
      height = byte(bytes, offset + 3) * 256 + byte(bytes, offset + 4);
      width = byte(bytes, offset + 5) * 256 + byte(bytes, offset + 6);
      const components = byte(bytes, offset + 7);
      if (!components || length !== 8 + 3 * components) invalid();
      dimensions(width, height);
    }
    offset += length;
    if (marker !== 0xda) continue;
    if (!width) invalid();
    sawScan = true;
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      let next = offset + 1;
      while (next < bytes.length && bytes[next] === 0xff) next++;
      const value = byte(bytes, next);
      if (value === 0 || (value >= 0xd0 && value <= 0xd7)) {
        offset = next + 1;
        continue;
      }
      break;
    }
  }
  if (!finished) invalid();
  return {
    mime: "image/jpeg",
    width,
    height,
    animated: false,
    ...(orientation === null ? {} : { orientation }),
  };
}

function inspectWebp(bytes: Uint8Array): RasterInfo {
  if (u32le(bytes, 4) + 8 !== bytes.length) invalid();
  let offset = 12;
  let width = 0;
  let height = 0;
  let canvasWidth = 0;
  let canvasHeight = 0;
  let orientation: number | null = null;
  let chunks = 0;
  while (offset < bytes.length) {
    if (++chunks > 10_000) large();
    const type = ascii(bytes, offset, 4);
    const length = u32le(bytes, offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end + (length & 1) > bytes.length) invalid();
    if (type === "ANIM" || type === "ANMF")
      throw new AttachmentImageError("animation_unsupported", "animated WebP is not supported");
    if (type === "EXIF") {
      const tiff = hasExifPrefix(bytes, start, end) ? start + 6 : start;
      const value = tiffOrientation(bytes, tiff, end);
      if (value !== null) {
        if (orientation !== null && orientation !== value) invalid();
        orientation = value;
      }
    } else if (type === "VP8X") {
      if (length !== 10 || canvasWidth) invalid();
      if (byte(bytes, start) & 2) {
        throw new AttachmentImageError("animation_unsupported", "animated WebP is not supported");
      }
      canvasWidth =
        1 + byte(bytes, start + 4) + byte(bytes, start + 5) * 256 + byte(bytes, start + 6) * 65536;
      canvasHeight =
        1 + byte(bytes, start + 7) + byte(bytes, start + 8) * 256 + byte(bytes, start + 9) * 65536;
      dimensions(canvasWidth, canvasHeight);
    } else if (type === "VP8 ") {
      if (
        width ||
        length < 10 ||
        byte(bytes, start) & 1 ||
        byte(bytes, start + 3) !== 0x9d ||
        byte(bytes, start + 4) !== 0x01 ||
        byte(bytes, start + 5) !== 0x2a
      )
        invalid();
      width = u16le(bytes, start + 6) & 0x3fff;
      height = u16le(bytes, start + 8) & 0x3fff;
    } else if (type === "VP8L") {
      if (width || length < 5 || byte(bytes, start) !== 0x2f || byte(bytes, start + 4) & 0xe0)
        invalid();
      width = 1 + byte(bytes, start + 1) + ((byte(bytes, start + 2) & 0x3f) << 8);
      height =
        1 +
        (byte(bytes, start + 2) >> 6) +
        (byte(bytes, start + 3) << 2) +
        ((byte(bytes, start + 4) & 0x0f) << 10);
    }
    offset = end + (length & 1);
  }
  dimensions(width, height);
  if (canvasWidth && (canvasWidth !== width || canvasHeight !== height)) invalid();
  return {
    mime: "image/webp",
    width,
    height,
    animated: false,
    ...(orientation === null ? {} : { orientation }),
  };
}

function inspectBmp(bytes: Uint8Array): RasterInfo {
  if (bytes.length < 54 || u32le(bytes, 2) !== bytes.length || u32le(bytes, 14) < 40) invalid();
  const offset = u32le(bytes, 10);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getInt32(18, true);
  const signedHeight = view.getInt32(22, true);
  const height = Math.abs(signedHeight);
  const bits = u16le(bytes, 28);
  const compression = u32le(bytes, 30);
  const dibSize = u32le(bytes, 14);
  if (14 + dibSize > bytes.length) invalid();
  if (
    u16le(bytes, 26) !== 1 ||
    ![1, 4, 8, 16, 24, 32].includes(bits) ||
    (compression !== 0 && !(compression === 3 && (bits === 16 || bits === 32)))
  ) {
    unsupported("compressed or unsupported BMP encoding");
  }
  dimensions(width, height);
  let minimumOffset = 14 + dibSize;
  if (compression === 3) {
    if (dibSize !== 40 && dibSize < 52) invalid();
    if (dibSize === 40) minimumOffset += 12;
    if (minimumOffset > bytes.length) invalid();
    const red = u32le(bytes, 54);
    const green = u32le(bytes, 58);
    const blue = u32le(bytes, 62);
    if (
      !red ||
      !green ||
      !blue ||
      red & green ||
      red & blue ||
      green & blue ||
      (bits === 16 && (red > 0xffff || green > 0xffff || blue > 0xffff))
    )
      invalid();
  }
  if (bits <= 8) {
    const declaredColors = u32le(bytes, 46);
    const colors = declaredColors || 2 ** bits;
    if (colors > 2 ** bits) invalid();
    minimumOffset += colors * 4;
  }
  const stride = Math.ceil((width * bits) / 32) * 4;
  if (stride * height > MAX_EXPANDED_BYTES) large();
  if (offset < minimumOffset || offset + stride * height > bytes.length) invalid();
  return { mime: "image/bmp", width, height, animated: false };
}

/** Header/structure limits precede any image decoder; they do not replace decoding. */
export function inspectRaster(bytes: Uint8Array): RasterInfo {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > ATTACHMENT_LIMITS.imageOriginalBytes)
    large();
  const mime = detectRasterMime(bytes);
  if (mime === "image/png") return inspectPng(bytes);
  if (mime === "image/jpeg") return inspectJpeg(bytes);
  if (mime === "image/gif") return inspectGif(bytes);
  if (mime === "image/webp") return inspectWebp(bytes);
  if (mime === "image/bmp") return inspectBmp(bytes);
  return unsupported("unsupported image signature");
}
