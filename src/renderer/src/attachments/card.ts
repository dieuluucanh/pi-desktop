/**
 * A renderer-side projection of one submitted attachment turn.
 *
 * The card metadata comes from the host-validated SDK association, so this
 * module never infers attribution from filenames or marker-like prose. The
 * persisted user message is the submitted content: text sections are accepted
 * only when they match the card's files exactly (id, order, name, byte count),
 * and images only when the persisted image blocks map one-to-one in order to
 * the card's image files. Anything else degrades to ordinary Pi content.
 *
 * Original bytes are never read here: the transcript shows what Pi persisted,
 * not a second copy of the user's file.
 */
import type {
  AttachmentTranscriptCard,
  AttachmentTranscriptFile,
} from "../../../shared/attachments";
import {
  parseAttachmentTextEnvelope,
  type AttachmentTextEnvelopeSection,
} from "../../../shared/attachment-text-envelope";
import type { TranscriptBlock, TranscriptMessage } from "../session/session-events";

const RASTER_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type AttachmentSubmittedUnavailableReason =
  "missing_text_section" | "missing_image" | "unverified_image";

export type AttachmentSubmittedContent =
  | { readonly kind: "text"; readonly section: AttachmentTextEnvelopeSection }
  | { readonly kind: "image"; readonly mimeType: string; readonly data: string }
  | {
      readonly kind: "unavailable";
      readonly reason: AttachmentSubmittedUnavailableReason;
    };

export interface AttachmentCardFileView {
  readonly file: AttachmentTranscriptFile;
  readonly submitted: AttachmentSubmittedContent;
  /** False when the SDK association predates provenance display details. */
  readonly provenanceRecorded: boolean;
}

export interface AttachmentCardView {
  readonly card: AttachmentTranscriptCard;
  /** The user's own words, with a validated managed envelope removed. */
  readonly prose: string;
  /**
   * True only when the persisted text matched the trusted card exactly (or no
   * managed text was expected). False means the raw text stays ordinary Pi
   * content and the card attributes nothing.
   */
  readonly grouped: boolean;
  /** True only when every persisted image block mapped to a card image. */
  readonly imagesSubmitted: boolean;
  /** The exact persisted text, for the explicit "copy submitted content" action. */
  readonly fullText: string;
  readonly files: readonly AttachmentCardFileView[];
}

function textBlocksOf(blocks: readonly TranscriptBlock[]): string[] {
  const texts: string[] = [];
  for (const block of blocks) if (block.kind === "text") texts.push(block.text);
  return texts;
}

function imageBlocksOf(
  blocks: readonly TranscriptBlock[],
): Array<{ mimeType: string; data: string }> {
  const images: Array<{ mimeType: string; data: string }> = [];
  for (const block of blocks) {
    if (block.kind === "image") images.push({ mimeType: block.mimeType, data: block.data });
  }
  return images;
}

function expectedTextSections(
  files: readonly AttachmentTranscriptFile[],
): Array<{ id: string; name: string | undefined; representationBytes: number | undefined }> {
  return files.map((file) => ({
    id: file.originalId,
    name: file.display?.name,
    representationBytes: file.display?.representationBytes,
  }));
}

/**
 * Map persisted image blocks to card image files in order.
 *
 * The host materializes images in plan order, so index i refers to image file
 * i. A count mismatch, an unknown raster MIME, an empty payload or a mismatch
 * with the recorded prepared dimension block means nothing is attributed: the
 * transcript keeps rendering the raw images as Pi history.
 */
function mapSubmittedImages(
  files: readonly AttachmentTranscriptFile[],
  blocks: ReadonlyArray<{ mimeType: string; data: string }>,
): Map<string, { mimeType: string; data: string }> | null {
  if (files.length === 0) return blocks.length === 0 ? new Map() : null;
  if (blocks.length !== files.length) return null;
  const mapped = new Map<string, { mimeType: string; data: string }>();
  for (const [index, file] of files.entries()) {
    const block = blocks[index];
    if (!block || block.data.length === 0 || !RASTER_MIMES.has(block.mimeType)) return null;
    const recorded = file.display?.image;
    if (recorded && recorded.mime !== block.mimeType) return null;
    mapped.set(file.representationId, {
      mimeType: block.mimeType,
      data: block.data,
    });
  }
  return mapped;
}

function submittedContentOf(
  file: AttachmentTranscriptFile,
  state: {
    readonly grouped: boolean;
    readonly sections: ReadonlyMap<string, AttachmentTextEnvelopeSection>;
    readonly mappedImages: ReadonlyMap<string, { mimeType: string; data: string }> | null;
    readonly imagePosition: ReadonlyMap<string, number>;
  },
): AttachmentSubmittedContent {
  if (file.modality === "text") {
    const section = state.grouped ? state.sections.get(file.originalId) : undefined;
    return section
      ? { kind: "text", section }
      : { kind: "unavailable", reason: "missing_text_section" };
  }
  const image = state.mappedImages?.get(file.representationId);
  if (image) return { kind: "image", mimeType: image.mimeType, data: image.data };
  return {
    kind: "unavailable",
    reason: state.imagePosition.has(file.representationId) ? "missing_image" : "unverified_image",
  };
}

/** Build the transcript projection for one message, or null when it has no card. */
export function attachmentCardView(message: TranscriptMessage): AttachmentCardView | null {
  const card = message.attachmentCard;
  if (!card || message.role !== "user") return null;

  const textBlocks = textBlocksOf(message.blocks);
  const fullText = textBlocks.join("\n");
  const textFiles = card.files.filter((file) => file.modality === "text");
  const imageFiles = card.files.filter((file) => file.modality === "image");

  let grouped = true;
  let prose = fullText;
  let sections = new Map<string, AttachmentTextEnvelopeSection>();
  if (textFiles.length > 0) {
    const parsed =
      textBlocks.length === 1
        ? parseAttachmentTextEnvelope(fullText, expectedTextSections(textFiles))
        : null;
    if (parsed) {
      prose = parsed.prose;
      sections = new Map(parsed.sections.map((section) => [section.id, section]));
    } else {
      grouped = false;
    }
  }

  const mappedImages = mapSubmittedImages(imageFiles, imageBlocksOf(message.blocks));
  const imagesSubmitted = imageFiles.length === 0 || mappedImages !== null;
  const imagePosition = new Map(imageFiles.map((file, index) => [file.representationId, index]));

  const files = card.files.map((file): AttachmentCardFileView => {
    const submitted = submittedContentOf(file, { grouped, sections, mappedImages, imagePosition });
    return {
      file,
      submitted,
      provenanceRecorded: file.display !== undefined,
    };
  });

  return { card, prose, grouped, imagesSubmitted, fullText, files };
}

/**
 * The user's own words of a managed send, or null when nothing grouped.
 *
 * A managed envelope is megabytes of file content, not what they typed. Prompt
 * history must recall the prose, never the envelope. Null means the text did
 * not validate against the card, so the caller keeps the raw message as is.
 */
export function groupedUserProse(message: PromptLikeMessage): string | null {
  const card = message.attachmentCard;
  if (!card) return null;
  const textBlocks = message.blocks.flatMap((block) =>
    block.kind === "text" && typeof block.text === "string" ? [block.text] : [],
  );
  if (textBlocks.length !== 1) return null;
  const only = textBlocks[0];
  if (only === undefined) return null;
  const textFiles = card.files.filter((file) => file.modality === "text");
  if (textFiles.length === 0) return null;
  const parsed = parseAttachmentTextEnvelope(only, expectedTextSections(textFiles));
  return parsed ? parsed.prose : null;
}

interface PromptLikeMessage {
  readonly blocks: readonly { readonly kind: string; readonly text?: string | undefined }[];
  readonly attachmentCard?: AttachmentTranscriptCard | undefined;
}
