import { ATTACHMENT_LIMITS, type AttachmentRepresentation } from "../shared/attachments";
import { classifyAttachment, type ClassifiedAttachment } from "./classify";
import {
  prepareRasterImage,
  type ImageEncoder,
  type ImagePreparationLimits,
  type PreparedRaster,
} from "./prepare-image";
import type { AssetOwner, AssetRecord, AttachmentStore, DirectPreparationMetadata } from "./store";

export const DIRECT_PREPARATION_VERSION = "desktop-direct-v1";

export interface DirectPreparationDeps {
  readonly store: AttachmentStore;
  readonly encoder: ImageEncoder;
  /** SHA-256 of the supplied bytes as lowercase hexadecimal. */
  sha256(bytes: Uint8Array): Promise<string>;
}

export type DirectPreparationResult =
  | {
      readonly status: "needs_conversion";
      readonly original: AssetRecord;
      readonly classification: Extract<ClassifiedAttachment, { kind: "document" }>;
    }
  | {
      readonly status: "ready";
      readonly original: AssetRecord;
      readonly representation: AttachmentRepresentation;
      readonly asset: AssetRecord;
      readonly details:
        | { readonly kind: "text"; readonly empty: boolean; readonly utf8Bom: boolean }
        | { readonly kind: "image"; readonly image: Omit<PreparedRaster, "bytes"> };
    };

/** A commit may have succeeded even if the storage acknowledgement was lost. */
export class UncertainPreparationError extends Error {
  readonly representationId: string;
  constructor(representationId: string) {
    super("prepared attachment finalization is uncertain; reconcile before retrying");
    this.name = "UncertainPreparationError";
    this.representationId = representationId;
  }
}

/**
 * Read and classify an owner-authorized immutable snapshot; create a separate
 * direct text/image representation. Documents are only identified here: no
 * document bytes are converted or sent without the later consent workflow.
 */
export async function prepareDirectAttachment(
  deps: DirectPreparationDeps,
  owner: AssetOwner,
  attachmentId: string,
  modelLimits: Partial<ImagePreparationLimits> = {},
): Promise<DirectPreparationResult> {
  const { asset: original, bytes } = await deps.store.readForPreparation(
    attachmentId,
    owner,
    ATTACHMENT_LIMITS.documentOriginalBytes,
  );
  if (original.kind !== "original") throw new Error("only original snapshots can be prepared");
  const classified = classifyAttachment({
    name: original.name,
    declaredMime: original.mimeType,
    bytes,
  });
  if (classified.kind === "document")
    return { status: "needs_conversion", original, classification: classified };

  let preparedBytes: Uint8Array;
  let mime: string;
  let warnings = [...classified.warnings];
  let details: Extract<DirectPreparationResult, { status: "ready" }>["details"];
  if (classified.kind === "text") {
    preparedBytes = new TextEncoder().encode(classified.text);
    mime = "text/plain";
    details = { kind: "text", empty: classified.empty, utf8Bom: classified.utf8Bom };
  } else {
    const image = await prepareRasterImage(bytes, deps.encoder, modelLimits);
    preparedBytes = image.bytes;
    mime = image.mime;
    warnings = [...warnings, ...image.warnings];
    const { bytes: _bytes, ...imageDetails } = image;
    details = { kind: "image", image: imageDetails };
  }

  const digest = await deps.sha256(new Uint8Array(preparedBytes));
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("invalid preparation digest");
  const representationId = await deps.store.beginRepresentation({
    owner,
    name: original.name,
    mimeType: mime,
    size: preparedBytes.byteLength,
    originalId: original.id,
    originalSha256: original.sha256,
  });
  let committing = false;
  let asset: AssetRecord;
  try {
    for (
      let offset = 0;
      offset < preparedBytes.byteLength;
      offset += ATTACHMENT_LIMITS.importChunkBytes
    ) {
      const chunk = preparedBytes.subarray(
        offset,
        Math.min(preparedBytes.byteLength, offset + ATTACHMENT_LIMITS.importChunkBytes),
      );
      const next = await deps.store.append(representationId, owner, offset, chunk);
      if (next !== offset + chunk.byteLength)
        throw new Error("prepared attachment write did not advance");
    }
    committing = true;
    asset = await deps.store.commit(representationId, owner, digest);
  } catch (cause) {
    if (committing) throw new UncertainPreparationError(representationId);
    await deps.store.cancel(representationId, owner).catch(() => undefined);
    throw cause;
  }
  const provenance: DirectPreparationMetadata = {
    version: 1,
    modality: classified.kind,
    preparationVersion: DIRECT_PREPARATION_VERSION,
    warnings,
    details:
      details.kind === "text"
        ? details
        : {
            kind: "image",
            mime: details.image.mime,
            width: details.image.width,
            height: details.image.height,
            original: details.image.original,
            wasResized: details.image.wasResized,
            wasReencoded: details.image.wasReencoded,
          },
  };
  try {
    asset = await deps.store.recordDirectPreparation(representationId, owner, provenance);
  } catch {
    // Bytes may already be committed, and provenance publication itself may
    // have succeeded despite a lost acknowledgement. Reconcile before retrying.
    throw new UncertainPreparationError(representationId);
  }
  const representation: AttachmentRepresentation = {
    id: asset.id,
    attachmentId: original.id,
    modality: classified.kind,
    origin: "direct",
    bytes: asset.size,
    originalSha256: original.sha256,
    representationSha256: asset.sha256,
    preparationVersion: DIRECT_PREPARATION_VERSION,
    approved: true,
    warnings,
  };
  return { status: "ready", original, representation, asset, details };
}
