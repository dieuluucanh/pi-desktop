import { ATTACHMENT_LIMITS } from "../shared/attachments";
import { frameAttachmentTextSections } from "../shared/attachment-text-envelope";

/** Text preparation is deliberately independent of the SDK and filesystem. */
export type AttachmentTextErrorCode =
  "too_large" | "binary" | "unsupported_encoding" | "invalid_metadata" | "too_many_files";

export class AttachmentTextError extends Error {
  readonly code: AttachmentTextErrorCode;
  constructor(code: AttachmentTextErrorCode, message: string) {
    super(message);
    this.name = "AttachmentTextError";
    this.code = code;
  }
}

export interface DecodedAttachmentText {
  readonly text: string;
  readonly utf8Bom: boolean;
  /** Bytes of the original snapshot, including any BOM. */
  readonly originalBytes: number;
}

/**
 * Strict UTF-8 with an optional UTF-8 BOM. NUL/control bytes are checked over
 * the entire snapshot, not just its first page. Newlines and tabs are preserved.
 * Valid UTF-8 data is not necessarily benign or semantically plain text: the
 * caller must classify signatures first and treat the resulting text as untrusted.
 */
export function decodeAttachmentText(bytes: Uint8Array): DecodedAttachmentText {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > ATTACHMENT_LIMITS.textOriginalBytes) {
    throw new AttachmentTextError("too_large", "attachment exceeds the text byte limit");
  }
  if (
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff) ||
    (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff)
  ) {
    throw new AttachmentTextError("unsupported_encoding", "only UTF-8 text is supported");
  }
  for (const byte of bytes) {
    if (
      (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) ||
      byte === 0x7f
    ) {
      throw new AttachmentTextError("binary", "attachment contains binary control bytes");
    }
  }
  const utf8Bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  try {
    // Strip exactly the optional leading BOM; a second U+FEFF is file content.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      utf8Bom ? bytes.subarray(3) : bytes,
    );
    return { text, utf8Bom, originalBytes: bytes.byteLength };
  } catch {
    throw new AttachmentTextError("unsupported_encoding", "attachment is not valid UTF-8");
  }
}

export interface PreparedTextSection {
  readonly id: string;
  readonly name: string;
  /** SHA-256 of the exact approved text representation, in lowercase hex. */
  readonly representationSha256: string;
  readonly text: string;
}

/**
 * Produce a deterministic, single-line JSON envelope. JSON escaping prevents
 * untrusted filenames/content from syntactically closing the envelope; it does
 * not make instructions inside that content trustworthy or guarantee model
 * behavior. U+2028/U+2029 are escaped too, so they cannot forge visual lines.
 *
 * The framing itself lives in `src/shared/attachment-text-envelope.ts` so the
 * renderer can parse exactly what the host wrote back into transcript cards.
 */
export function renderAttachmentTextSections(sections: readonly PreparedTextSection[]): string {
  const result = frameAttachmentTextSections(sections);
  if (result.ok) return result.framed;
  if (result.reason === "too_many_files") {
    throw new AttachmentTextError("too_many_files", "too many text attachments");
  }
  if (result.reason === "invalid_metadata") {
    throw new AttachmentTextError("invalid_metadata", "invalid attachment text metadata");
  }
  throw new AttachmentTextError("too_large", "attachment text exceeds the byte limits");
}
