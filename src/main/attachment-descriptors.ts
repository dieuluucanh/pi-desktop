import { DIRECT_PREPARATION_VERSION } from "../attachments/prepare";
import type { AssetRecord } from "../attachments/store";
import type {
  AttachmentClassification,
  AttachmentDescriptor,
  AttachmentOriginalKind,
  AttachmentReason,
} from "../shared/attachments";

/**
 * Main-only projection from immutable store records + a persisted
 * classification to the renderer-safe `AttachmentDescriptor`. It never reads
 * bytes, never trusts the declared MIME, and never claims delivery readiness
 * that only the host's model/context pass can establish.
 */

export function originalKindForClassification(
  classification: AttachmentClassification,
): AttachmentOriginalKind {
  if (classification.kind === "text") return "text";
  if (classification.kind === "image") return "image";
  if (classification.kind === "document") {
    switch (classification.format) {
      case "pdf":
        return "pdf";
      case "docx":
      case "odt":
        return "word";
      case "xlsx":
      case "ods":
        return "spreadsheet";
      case "pptx":
      case "odp":
        return "presentation";
      default:
        return "other";
    }
  }
  return "other";
}

/** Reuse an immutable direct representation of the current original only. */
export function preparedRepresentation(
  assets: readonly AssetRecord[],
  original: AssetRecord,
): AssetRecord | null {
  return (
    assets.find(
      (asset) =>
        asset.kind === "representation" &&
        asset.originalId === original.id &&
        asset.originalSha256 === original.sha256 &&
        asset.preparation?.version === 1 &&
        asset.preparation.preparationVersion === DIRECT_PREPARATION_VERSION,
    ) ?? null
  );
}

export function preparedImageRepresentation(
  assets: readonly AssetRecord[],
  original: AssetRecord,
): AssetRecord | null {
  const representation = preparedRepresentation(assets, original);
  return representation?.preparation?.modality === "image" ? representation : null;
}

function statusFor(classification: AttachmentClassification): {
  status: AttachmentDescriptor["status"];
  reason: AttachmentReason | null;
} {
  if (classification.kind === "unsupported" || classification.kind === "failed") {
    return { status: "blocked", reason: classification.failure ?? "classification_failed" };
  }
  if (classification.kind === "document") {
    return { status: "needs_conversion", reason: "conversion_required" };
  }
  // Direct text/image: classified and eligible. Preparation happens on demand
  // (preview) or at send, so a missing representation is not a blocker here.
  return { status: "ready", reason: null };
}

export function describeAttachment(
  original: AssetRecord,
  assets: readonly AssetRecord[],
  classification: AttachmentClassification,
): AttachmentDescriptor {
  const representation = preparedRepresentation(assets, original);
  const { status, reason } = statusFor(classification);
  return {
    id: original.id,
    name: original.name,
    mimeType: original.mimeType,
    size: original.size,
    originalKind: originalKindForClassification(classification),
    detectedMime:
      classification.detectedMime ?? (classification.kind === "text" ? "text/plain" : null),
    status,
    reason,
    representationId: representation?.id ?? null,
    previewAvailable:
      classification.kind === "text" ||
      (classification.kind === "image" && classification.image !== null),
    warnings: [...classification.warnings],
  };
}
