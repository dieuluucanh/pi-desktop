import { ATTACHMENT_LIMITS } from "../shared/attachments";
import {
  ATTACHMENT_CLASSIFICATION_VERSION,
  type AttachmentClassification,
  type AttachmentReason,
} from "../shared/attachments";
import {
  identifyDocumentContainer,
  looksLikeZip,
  type DocumentContainerFormat,
} from "./document-container";
import { detectRasterMime, displayRasterDimensions, inspectRaster, type RasterMime } from "./image";
import { attachmentSuffix, isKnownUnsupportedAttachment } from "./format-hints";
import { decodeAttachmentText } from "./text";

export type AttachmentFormat =
  "text" | "pdf" | DocumentContainerFormat | "png" | "jpeg" | "gif" | "webp" | "bmp";
export type AttachmentClassificationErrorCode =
  "bad_metadata" | "format_mismatch" | "format_unsupported" | "original_too_large";

export class AttachmentClassificationError extends Error {
  readonly code: AttachmentClassificationErrorCode;
  constructor(code: AttachmentClassificationErrorCode, message: string) {
    super(message);
    this.name = "AttachmentClassificationError";
    this.code = code;
  }
}

export type ClassifiedAttachment =
  | {
      readonly kind: "text";
      readonly format: "text";
      readonly mime: "text/plain";
      readonly text: string;
      readonly utf8Bom: boolean;
      readonly empty: boolean;
      readonly warnings: readonly string[];
    }
  | {
      readonly kind: "image";
      readonly format: "png" | "jpeg" | "gif" | "webp" | "bmp";
      readonly mime: RasterMime;
      readonly width: number;
      readonly height: number;
      readonly animated: boolean;
      readonly warnings: readonly string[];
    }
  | {
      readonly kind: "document";
      readonly format: "pdf" | DocumentContainerFormat;
      readonly mime: string;
      readonly needsConversion: true;
      readonly warnings: readonly string[];
    };

const IMAGE_BY_MIME: Record<RasterMime, "png" | "jpeg" | "gif" | "webp" | "bmp"> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};
const EXTENSIONS: Record<string, AttachmentFormat> = {
  txt: "text",
  text: "text",
  md: "text",
  markdown: "text",
  csv: "text",
  tsv: "text",
  json: "text",
  jsonl: "text",
  xml: "text",
  html: "text",
  htm: "text",
  svg: "text",
  pdf: "pdf",
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
  odt: "odt",
  ods: "ods",
  odp: "odp",
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  gif: "gif",
  webp: "webp",
  bmp: "bmp",
};
const MIME_FORMATS: Record<string, AttachmentFormat> = {
  "application/pdf": "pdf",
  "application/json": "text",
  "application/xml": "text",
  "application/javascript": "text",
  "application/xhtml+xml": "text",
  "image/svg+xml": "text",
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/x-ms-bmp": "bmp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.presentation": "odp",
};
function metadata(name: string, mimeType: string): void {
  if (
    typeof name !== "string" ||
    !name.length ||
    name.length > 255 ||
    name.includes("/") ||
    name.includes("\\") ||
    Array.from(name).some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127) ||
    typeof mimeType !== "string" ||
    mimeType.length > 255 ||
    Array.from(mimeType).some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)
  ) {
    throw new AttachmentClassificationError("bad_metadata", "invalid attachment metadata");
  }
}

function mimeHint(mimeType: string): AttachmentFormat | "archive" | null {
  const mime = mimeType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  if (!mime || mime === "application/octet-stream" || mime === "binary/octet-stream") return null;
  if (mime === "application/zip" || mime === "application/x-zip-compressed") return "archive";
  if (Object.hasOwn(MIME_FORMATS, mime)) return MIME_FORMATS[mime] ?? null;
  if (mime.startsWith("text/") || mime.endsWith("+json") || mime.endsWith("+xml")) return "text";
  return null;
}

function checkClaims(name: string, mime: string, actual: AttachmentFormat): readonly string[] {
  const extension = attachmentSuffix(name);
  const extensionFormat = Object.hasOwn(EXTENSIONS, extension) ? EXTENSIONS[extension] : undefined;
  const declared = mimeHint(mime);
  if (
    (extensionFormat && extensionFormat !== actual) ||
    (declared && declared !== "archive" && declared !== actual)
  ) {
    throw new AttachmentClassificationError(
      "format_mismatch",
      "filename or declared type disagrees with attachment content",
    );
  }
  if (declared === "archive" && !["docx", "xlsx", "pptx", "odt", "ods", "odp"].includes(actual)) {
    throw new AttachmentClassificationError(
      "format_mismatch",
      "declared archive type disagrees with attachment content",
    );
  }
  const normalized = mime.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  return normalized &&
    normalized !== "application/octet-stream" &&
    normalized !== "binary/octet-stream" &&
    !declared
    ? ["The declared MIME type was not recognized; content was classified independently."]
    : [];
}

function starts(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((value, index) => bytes[index] === value);
}

function knownBinary(bytes: Uint8Array): boolean {
  return (
    starts(bytes, [0x7f, 0x45, 0x4c, 0x46]) ||
    starts(bytes, [0x4d, 0x5a]) ||
    starts(bytes, [0x1f, 0x8b]) ||
    starts(bytes, [0x52, 0x61, 0x72, 0x21]) ||
    starts(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) ||
    starts(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) ||
    starts(bytes, [0x49, 0x44, 0x33]) ||
    starts(bytes, [0x66, 0x4c, 0x61, 0x43]) ||
    starts(bytes, [0x4f, 0x67, 0x67, 0x53]) ||
    (bytes.length >= 12 &&
      bytes[4] === 0x66 &&
      bytes[5] === 0x74 &&
      bytes[6] === 0x79 &&
      bytes[7] === 0x70)
  );
}

/**
 * Classify complete snapshot bytes, never renderer-provided MIME alone. Package
 * recognition only offers a future conversion; it does not validate PDF bodies,
 * execute files, or authorize delivery. Direct markup remains inert text.
 */
export function classifyAttachment(input: {
  name: string;
  declaredMime: string;
  bytes: Uint8Array;
}): ClassifiedAttachment {
  const { name, declaredMime, bytes } = input;
  metadata(name, declaredMime);
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength > ATTACHMENT_LIMITS.documentOriginalBytes
  ) {
    throw new AttachmentClassificationError(
      "original_too_large",
      "attachment exceeds the original byte limit",
    );
  }
  if (isKnownUnsupportedAttachment(name, declaredMime)) {
    throw new AttachmentClassificationError(
      "format_unsupported",
      "this file family is not supported",
    );
  }
  const imageMime = detectRasterMime(bytes);
  if (imageMime) {
    const format = IMAGE_BY_MIME[imageMime];
    const warnings = checkClaims(name, declaredMime, format);
    const image = inspectRaster(bytes);
    const display = displayRasterDimensions(image);
    return {
      kind: "image",
      format,
      mime: image.mime,
      width: display.width,
      height: display.height,
      animated: image.animated,
      warnings,
    };
  }
  if (starts(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    const warnings = checkClaims(name, declaredMime, "pdf");
    if (
      bytes.length < 9 ||
      (bytes[5] !== 0x31 && bytes[5] !== 0x32) ||
      bytes[6] !== 0x2e ||
      (bytes[7] ?? 0) < 0x30 ||
      (bytes[7] ?? 255) > 0x39
    ) {
      throw new AttachmentClassificationError("format_unsupported", "invalid PDF header");
    }
    return {
      kind: "document",
      format: "pdf",
      mime: "application/pdf",
      needsConversion: true,
      warnings: [...warnings, "PDF structure and encryption are checked only during conversion."],
    };
  }
  if (looksLikeZip(bytes)) {
    const identity = identifyDocumentContainer(bytes);
    const warnings = checkClaims(name, declaredMime, identity.format);
    return {
      kind: "document",
      ...identity,
      needsConversion: true,
      warnings: [
        ...warnings,
        "Document contents require separate validation and explicit local conversion.",
      ],
    };
  }
  if (knownBinary(bytes))
    throw new AttachmentClassificationError(
      "format_unsupported",
      "this binary file is not supported",
    );
  const warnings = checkClaims(name, declaredMime, "text");
  const decoded = decodeAttachmentText(bytes);
  return {
    kind: "text",
    format: "text",
    mime: "text/plain",
    text: decoded.text,
    utf8Bom: decoded.utf8Bom,
    empty: decoded.text.length === 0,
    warnings,
  };
}

const FAILURE_REASONS: Record<AttachmentClassificationErrorCode, AttachmentReason> = {
  bad_metadata: "classification_failed",
  format_mismatch: "format_mismatch",
  format_unsupported: "format_unsupported",
  original_too_large: "original_too_large",
};

/**
 * Persistable projection of one classification attempt. A failure is recorded
 * as data (never an empty classification) so the descriptor can explain it
 * without re-reading bytes or trusting the filename/declared MIME.
 */
export function classificationForAttachment(input: {
  name: string;
  declaredMime: string;
  bytes: Uint8Array;
}): AttachmentClassification {
  const base = {
    version: ATTACHMENT_CLASSIFICATION_VERSION,
  } as const;
  try {
    const classified = classifyAttachment(input);
    if (classified.kind === "text") {
      return {
        ...base,
        kind: "text",
        format: classified.format,
        detectedMime: classified.mime,
        warnings: [...classified.warnings],
        text: {
          promptBytes: new TextEncoder().encode(classified.text).byteLength,
          empty: classified.empty,
        },
        image: null,
        failure: null,
      };
    }
    if (classified.kind === "image") {
      return {
        ...base,
        kind: "image",
        format: classified.format,
        detectedMime: classified.mime,
        warnings: [...classified.warnings],
        text: null,
        image: {
          width: classified.width,
          height: classified.height,
          animated: classified.animated,
        },
        failure: null,
      };
    }
    return {
      ...base,
      kind: "document",
      format: classified.format,
      detectedMime: classified.mime,
      warnings: [...classified.warnings],
      text: null,
      image: null,
      failure: null,
    };
  } catch (error) {
    const code = error instanceof AttachmentClassificationError ? error.code : "format_unsupported";
    const failure = FAILURE_REASONS[code] ?? "classification_failed";
    return {
      ...base,
      kind:
        failure === "format_unsupported" || failure === "format_mismatch"
          ? "unsupported"
          : "failed",
      format: null,
      detectedMime: null,
      warnings: [],
      text: null,
      image: null,
      failure,
    };
  }
}
