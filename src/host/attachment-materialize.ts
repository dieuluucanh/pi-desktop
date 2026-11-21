import { displayRasterDimensions, inspectRaster } from "../attachments/image";
import { DEFAULT_IMAGE_PREPARATION_LIMITS } from "../attachments/prepare-image";
import { renderAttachmentTextSections, type PreparedTextSection } from "../attachments/text";
import {
  ATTACHMENT_DELIVERY_VERSION,
  ATTACHMENT_LIMITS,
  isAttachmentId,
  type AttachmentDeliveryPlan,
  type AuthorizedAttachmentAsset,
} from "../shared/attachments";

/**
 * This port is internal to the host and is implemented from the sealed private
 * transfer reader plus the host-owned planner binding. Every check revalidates
 * the live host mirror of the main-issued lease and current context; neither
 * this port nor a renderer-supplied record grants access. The parent transport
 * enforces bounded chunks and never accepts paths or renderer-supplied bytes.
 */
export interface AttachmentMaterializationPort {
  isCurrent(
    planId: string,
    assets: readonly AuthorizedAttachmentAsset[],
    userText: string,
  ): Promise<boolean>;
  readChunk(representationId: string, offset: number, length: number): Promise<Uint8Array>;
  /** SHA-256 of the supplied host-local bytes. */
  sha256(bytes: Uint8Array): Promise<string>;
}

export interface MaterializedAttachmentPrompt {
  readonly text: string;
  readonly images: readonly {
    readonly bytes: Uint8Array;
    readonly mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    /** Digest bound by the authorized plan; rechecked by the SDK adapter. */
    readonly representationSha256: string;
  }[];
}

export class AttachmentMaterializationError extends Error {
  constructor(readonly code: "unavailable" | "stale_plan" | "invalid_content") {
    super(`attachment materialization failed: ${code}`);
    this.name = "AttachmentMaterializationError";
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function fail(code: AttachmentMaterializationError["code"]): never {
  throw new AttachmentMaterializationError(code);
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validate(
  plan: AttachmentDeliveryPlan,
  assets: readonly AuthorizedAttachmentAsset[],
  text: string,
): void {
  if (
    !plan ||
    plan.version !== ATTACHMENT_DELIVERY_VERSION ||
    !isAttachmentId(plan.id) ||
    !Array.isArray(plan.blockingReasons) ||
    plan.blockingReasons.length !== 0 ||
    !Array.isArray(plan.representationIds) ||
    !Array.isArray(assets) ||
    assets.length === 0 ||
    assets.length > ATTACHMENT_LIMITS.filesPerDraft ||
    assets.length !== plan.representationIds.length ||
    typeof text !== "string" ||
    text.length >
      ATTACHMENT_LIMITS.promptTextBytesTotal + ATTACHMENT_LIMITS.promptTextEstimatedTokens ||
    !wellFormed(text)
  )
    return fail("unavailable");
  let textBytes = 0;
  let imageBytes = 0;
  let originalBytes = 0;
  const originals = new Set<string>();
  const representations = new Set<string>();
  for (const [index, asset] of assets.entries()) {
    const original = asset?.original;
    const rep = asset?.representation;
    if (
      !original ||
      !rep ||
      !isAttachmentId(original.id) ||
      typeof original.name !== "string" ||
      original.name.length === 0 ||
      original.name.length > 255 ||
      original.name.includes("/") ||
      original.name.includes("\\") ||
      Array.from(original.name as string).some(
        (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
      ) ||
      !wellFormed(original.name) ||
      !isAttachmentId(rep.id) ||
      plan.representationIds[index] !== rep.id ||
      originals.has(original.id) ||
      representations.has(rep.id) ||
      rep.attachmentId !== original.id ||
      !SHA256.test(original.sha256) ||
      !SHA256.test(rep.originalSha256) ||
      !SHA256.test(rep.representationSha256) ||
      rep.originalSha256 !== original.sha256 ||
      !count(original.bytes) ||
      !count(rep.bytes) ||
      (rep.origin !== "direct" && rep.origin !== "converted") ||
      rep.approved !== true ||
      (rep.origin === "direct" && asset.approvalDigest !== null) ||
      (rep.origin === "converted" &&
        (rep.modality !== "text" ||
          asset.approvalDigest === null ||
          !SHA256.test(asset.approvalDigest))) ||
      typeof rep.preparationVersion !== "string" ||
      rep.preparationVersion.length === 0 ||
      rep.preparationVersion.length > 128 ||
      !Array.isArray(rep.warnings) ||
      rep.warnings.length > 64 ||
      rep.warnings.some((warning: unknown) => typeof warning !== "string" || warning.length > 512)
    )
      return fail("unavailable");
    originals.add(original.id);
    representations.add(rep.id);
    originalBytes += original.bytes;
    if (rep.modality === "text") {
      if (
        (rep.origin === "converted"
          ? !["pdf", "word", "spreadsheet", "presentation"].includes(original.kind)
          : original.kind !== "text") ||
        asset.image !== null ||
        original.bytes > ATTACHMENT_LIMITS.textOriginalBytes ||
        rep.bytes > ATTACHMENT_LIMITS.promptTextBytesPerFile
      )
        return fail("unavailable");
      textBytes += rep.bytes;
    } else if (rep.modality === "image") {
      const image = asset.image;
      if (
        original.kind !== "image" ||
        !image ||
        !IMAGE_MIMES.has(image.mime) ||
        !count(image.width) ||
        !count(image.height) ||
        image.width === 0 ||
        image.height === 0 ||
        image.width > DEFAULT_IMAGE_PREPARATION_LIMITS.maxWidth ||
        image.height > DEFAULT_IMAGE_PREPARATION_LIMITS.maxHeight ||
        original.bytes > ATTACHMENT_LIMITS.imageOriginalBytes ||
        rep.bytes === 0 ||
        rep.bytes > ATTACHMENT_LIMITS.imageOriginalBytes ||
        Math.ceil(rep.bytes / 3) * 4 > DEFAULT_IMAGE_PREPARATION_LIMITS.maxEncodedBytes
      )
        return fail("unavailable");
      imageBytes += Math.ceil(rep.bytes / 3) * 4;
    } else {
      return fail("unavailable");
    }
  }
  if (
    originalBytes > ATTACHMENT_LIMITS.draftOriginalBytes ||
    textBytes > ATTACHMENT_LIMITS.promptTextBytesTotal ||
    imageBytes > ATTACHMENT_LIMITS.imageEncodedBytesTotal
  )
    return fail("unavailable");
}

function decodePreparedText(bytes: Uint8Array): string {
  for (const byte of bytes) {
    if (
      (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) ||
      byte === 0x7f
    )
      return fail("invalid_content");
  }
  try {
    // Preparation removed exactly one source BOM. A second BOM is content.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail("invalid_content");
  }
}

/**
 * Copy, bound and digest-check main-authorized representations inside the host.
 * This performs no SDK dispatch and cannot authenticate the port or make the
 * final revalidation atomic with dispatch; production wiring must do both.
 */
export async function materializeAttachmentPrompt(
  port: AttachmentMaterializationPort,
  plan: AttachmentDeliveryPlan,
  authorizedAssets: readonly AuthorizedAttachmentAsset[],
  userText: string,
): Promise<MaterializedAttachmentPrompt> {
  let planId: string;
  let assets: readonly AuthorizedAttachmentAsset[];
  try {
    // Validate bounded fields before copying, and copy only the known schema:
    // extra properties must not trigger unbounded structured cloning.
    validate(plan, authorizedAssets, userText);
    planId = plan.id;
    assets = authorizedAssets.map(({ original, representation, image, approvalDigest }) => ({
      original: {
        id: original.id,
        name: original.name,
        kind: original.kind,
        bytes: original.bytes,
        sha256: original.sha256,
      },
      representation: {
        id: representation.id,
        attachmentId: representation.attachmentId,
        modality: representation.modality,
        origin: representation.origin,
        bytes: representation.bytes,
        originalSha256: representation.originalSha256,
        representationSha256: representation.representationSha256,
        preparationVersion: representation.preparationVersion,
        approved: representation.approved,
        warnings: [...representation.warnings],
      },
      image: image ? { mime: image.mime, width: image.width, height: image.height } : null,
      approvalDigest,
    }));
  } catch (error) {
    if (error instanceof AttachmentMaterializationError) throw error;
    return fail("unavailable");
  }
  const current = async (): Promise<void> => {
    try {
      if ((await port.isCurrent(planId, structuredClone(assets), userText)) === true) return;
    } catch {
      // No port errors, file names or content are included in the result.
    }
    return fail("stale_plan");
  };
  const buffers: Uint8Array[] = [];
  try {
    await current();
    const sections: PreparedTextSection[] = [];
    const images: MaterializedAttachmentPrompt["images"][number][] = [];
    for (const asset of assets) {
      const rep = asset.representation;
      const data = new Uint8Array(rep.bytes);
      buffers.push(data);
      for (let offset = 0; offset < data.length;) {
        const length = Math.min(ATTACHMENT_LIMITS.importChunkBytes, data.length - offset);
        await current();
        const chunk = await port.readChunk(rep.id, offset, length);
        if (!(chunk instanceof Uint8Array) || chunk.byteLength !== length)
          return fail("unavailable");
        // Copy before any further await; the port may reuse its input buffer.
        data.set(chunk, offset);
        offset += length;
        await current();
      }
      await current();
      const digest = await port.sha256(new Uint8Array(data));
      if (digest !== rep.representationSha256) return fail("invalid_content");
      await current();
      if (rep.modality === "text") {
        sections.push({
          id: asset.original.id,
          name: asset.original.name,
          representationSha256: rep.representationSha256,
          text: decodePreparedText(data),
        });
      } else {
        const info = inspectRaster(data);
        const dimensions = displayRasterDimensions(info);
        if (
          !asset.image ||
          info.mime === "image/bmp" ||
          info.mime !== asset.image.mime ||
          dimensions.width !== asset.image.width ||
          dimensions.height !== asset.image.height
        )
          return fail("invalid_content");
        images.push({
          bytes: data,
          mimeType: info.mime,
          representationSha256: rep.representationSha256,
        });
      }
    }
    const framed = sections.length ? renderAttachmentTextSections(sections) : "";
    const text = userText && framed ? `${userText}\n\n${framed}` : userText || framed;
    const maxText =
      ATTACHMENT_LIMITS.promptTextBytesTotal + ATTACHMENT_LIMITS.promptTextEstimatedTokens;
    if (new TextEncoder().encode(text).byteLength > maxText) return fail("unavailable");
    await current();
    return { text, images };
  } catch (error) {
    for (const bytes of buffers) bytes.fill(0);
    if (error instanceof AttachmentMaterializationError) throw error;
    return fail("invalid_content");
  }
}
