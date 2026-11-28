import { isDeepStrictEqual } from "node:util";
import { DIRECT_PREPARATION_VERSION } from "../attachments/prepare";
import { DEFAULT_IMAGE_PREPARATION_LIMITS } from "../attachments/prepare-image";
import type { AssetOwner, AssetRecord, AttachmentStore } from "../attachments/store";
import {
  ATTACHMENT_LIMITS,
  isAttachmentId,
  type AttachmentOriginalKind,
  type AuthorizedAttachmentAsset,
} from "../shared/attachments";
import type { ConversionApprovalRecord } from "../shared/conversion";

/**
 * Main-only asset resolution used by the attachment lease authority. An owner,
 * ID, or returned record is NOT a permission. The caller must authenticate the
 * draft, profile, session and host, hold a live pin, and revalidate it across
 * every await and at dispatch. Never expose these functions directly over IPC.
 *
 * Converted representations are deliberately excluded until their independent
 * approval and provenance authority exists. No manifest writes happen here.
 */
export class DeliveryAssetError extends Error {
  readonly code = "unavailable";
  constructor() {
    super("attachment delivery asset is unavailable");
    this.name = "DeliveryAssetError";
  }
}

function unavailable(): never {
  throw new DeliveryAssetError();
}

const ORIGINAL_KINDS: readonly string[] = [
  "text",
  "image",
  "pdf",
  "word",
  "spreadsheet",
  "presentation",
  "audio",
  "video",
  "other",
];

function originalKindOf(original: AssetRecord): AttachmentOriginalKind {
  const kind = original.classification?.kind;
  return kind && ORIGINAL_KINDS.includes(kind) ? (kind as AttachmentOriginalKind) : "other";
}

export interface ConversionApprovalPort {
  approvalFor(representationId: string): Promise<ConversionApprovalRecord | null>;
}

function project(
  original: AssetRecord,
  asset: AssetRecord,
  owner: AssetOwner,
  approval: ConversionApprovalRecord | null,
): AuthorizedAttachmentAsset {
  if (asset.conversion) {
    const conversion = asset.conversion.conversion;
    if (
      !approval ||
      asset.kind !== "representation" ||
      original.kind !== "original" ||
      asset.originalId !== original.id ||
      asset.originalSha256 !== original.sha256 ||
      asset.mimeType !== "text/plain" ||
      asset.size > ATTACHMENT_LIMITS.promptTextBytesPerFile ||
      conversion.contractVersion !== 1 ||
      approval.owner.kind !== owner.kind ||
      approval.owner.id !== owner.id ||
      approval.originalId !== original.id ||
      approval.originalSha256 !== original.sha256 ||
      approval.representationId !== asset.id ||
      approval.representationSha256 !== asset.sha256 ||
      approval.proposalDigest !== conversion.proposalDigest ||
      approval.selectionDigest !== conversion.selectionDigest ||
      !isDeepStrictEqual(approval.converter, conversion.converter)
    ) {
      return unavailable();
    }
    return {
      original: {
        id: original.id,
        name: original.name,
        kind: originalKindOf(original),
        bytes: original.size,
        sha256: original.sha256,
      },
      representation: {
        id: asset.id,
        attachmentId: original.id,
        modality: "text",
        origin: "converted",
        bytes: asset.size,
        originalSha256: original.sha256,
        representationSha256: asset.sha256,
        preparationVersion: asset.conversion.preparationVersion,
        approved: true,
        warnings: [...asset.conversion.warnings],
      },
      image: null,
      approvalDigest: approval.approvalDigest,
    };
  }
  const preparation = asset.preparation;
  if (
    original.kind !== "original" ||
    asset.kind !== "representation" ||
    asset.originalId !== original.id ||
    asset.originalSha256 !== original.sha256 ||
    !preparation ||
    preparation.version !== 1 ||
    preparation.preparationVersion !== DIRECT_PREPARATION_VERSION ||
    preparation.details.kind !== preparation.modality
  )
    return unavailable();

  const modality = preparation.modality;
  if (modality === "text") {
    if (
      preparation.details.kind !== "text" ||
      asset.mimeType !== "text/plain" ||
      original.size > ATTACHMENT_LIMITS.textOriginalBytes ||
      asset.size > ATTACHMENT_LIMITS.promptTextBytesPerFile
    )
      return unavailable();
  } else if (
    preparation.details.kind !== "image" ||
    original.size > ATTACHMENT_LIMITS.imageOriginalBytes ||
    asset.size === 0 ||
    asset.size > ATTACHMENT_LIMITS.imageOriginalBytes ||
    Math.ceil(asset.size / 3) * 4 > DEFAULT_IMAGE_PREPARATION_LIMITS.maxEncodedBytes
  ) {
    return unavailable();
  }

  return {
    original: {
      id: original.id,
      name: original.name,
      kind: modality,
      bytes: original.size,
      sha256: original.sha256,
    },
    representation: {
      id: asset.id,
      attachmentId: original.id,
      modality,
      origin: "direct",
      bytes: asset.size,
      originalSha256: original.sha256,
      representationSha256: asset.sha256,
      preparationVersion: preparation.preparationVersion,
      approved: true,
      warnings: [...preparation.warnings],
    },
    image:
      preparation.details.kind === "image"
        ? {
            mime: preparation.details.mime,
            width: preparation.details.width,
            height: preparation.details.height,
          }
        : null,
    approvalDigest: null,
  };
}

/** Resolve selectors exclusively against the authenticated owner's manifest. */
export async function resolveDirectDeliveryAssets(
  store: AttachmentStore,
  owner: AssetOwner,
  representationIds: readonly string[],
  approvals?: ConversionApprovalPort,
): Promise<readonly AuthorizedAttachmentAsset[]> {
  if (
    !Array.isArray(representationIds) ||
    representationIds.length === 0 ||
    representationIds.length > ATTACHMENT_LIMITS.filesPerDraft ||
    representationIds.some((id) => !isAttachmentId(id)) ||
    new Set(representationIds).size !== representationIds.length
  )
    return unavailable();
  // Snapshot caller-owned selectors before awaiting the store.
  const ids = [...representationIds];
  const records = await store.list({ ...owner });
  const byId = new Map(records.map((asset) => [asset.id, asset]));
  const originals = new Set<string>();
  let originalBytes = 0;
  let textBytes = 0;
  let imageBytes = 0;
  const result: AuthorizedAttachmentAsset[] = [];
  for (const id of ids) {
    const asset = byId.get(id);
    const original = asset?.originalId ? byId.get(asset.originalId) : undefined;
    if (!asset || !original || originals.has(original.id)) return unavailable();
    originals.add(original.id);
    const approval = asset.conversion && approvals ? await approvals.approvalFor(asset.id) : null;
    const item = project(original, asset, owner, approval);
    originalBytes += item.original.bytes;
    if (item.representation.modality === "text") textBytes += item.representation.bytes;
    else imageBytes += Math.ceil(item.representation.bytes / 3) * 4;
    result.push(item);
  }
  if (
    originalBytes > ATTACHMENT_LIMITS.draftOriginalBytes ||
    textBytes > ATTACHMENT_LIMITS.promptTextBytesTotal ||
    imageBytes > ATTACHMENT_LIMITS.imageEncodedBytesTotal
  )
    return unavailable();
  return result;
}

/**
 * Read one exact direct representation inside main. The store checks ownership,
 * size and its object digest; this helper independently checks the returned
 * bytes and compares fresh manifest projections on both sides of the read.
 * The full buffer is internal: the private main-to-host transport sends bounded
 * chunks, never one host frame, and never exposes these bytes to the renderer.
 */
export async function readDirectDeliveryAsset(
  store: AttachmentStore,
  owner: AssetOwner,
  expected: AuthorizedAttachmentAsset,
  sha256: (bytes: Uint8Array) => Promise<string>,
  approvals?: ConversionApprovalPort,
): Promise<Uint8Array> {
  const snapshot = structuredClone(expected);
  const id = snapshot?.representation?.id;
  if (!isAttachmentId(id) || typeof sha256 !== "function") return unavailable();
  const ownerSnapshot = { ...owner };
  const before = await resolveDirectDeliveryAssets(store, ownerSnapshot, [id], approvals);
  if (!isDeepStrictEqual(before[0], snapshot)) return unavailable();
  const result = await store.readForPreparation(id, ownerSnapshot, snapshot.representation.bytes);
  if (
    result.asset.id !== id ||
    result.asset.sha256 !== snapshot.representation.representationSha256 ||
    !(result.bytes instanceof Uint8Array) ||
    result.bytes.byteLength !== snapshot.representation.bytes
  )
    return unavailable();
  const bytes = new Uint8Array(result.bytes);
  if ((await sha256(new Uint8Array(bytes))) !== snapshot.representation.representationSha256)
    return unavailable();
  const after = await resolveDirectDeliveryAssets(store, ownerSnapshot, [id], approvals);
  if (!isDeepStrictEqual(after[0], snapshot)) return unavailable();
  return bytes;
}

export interface DirectDeliveryReader {
  /** Fresh copies; changing this projection cannot change the bound reader. */
  readonly assets: readonly AuthorizedAttachmentAsset[];
  /** Revalidate the authenticated lease and all original/representation owners. */
  isCurrent(): Promise<boolean>;
  /** Ordered bounded chunks for the host only, never a renderer API. */
  readChunk(representationId: string, offset: number, length: number): Promise<Uint8Array>;
  close(): void;
}

/**
 * Open a bounded, sequential in-memory reader under an already authenticated
 * and pinned main-owned lease. `leaseCurrent` must verify sender, live draft,
 * profile, host generation and session/branch/revision; a UUID or renderer
 * callback is insufficient. This function does not acquire a real pin and
 * MUST NOT be wired until one exists. The authority must cap active readers and
 * aggregate cached bytes and close readers on expiry: this reader owns no timer.
 * Close/revocation is permanent, including when a lease or manifest temporarily
 * becomes invalid.
 */
export async function openDirectDeliveryReader(input: {
  readonly store: AttachmentStore;
  readonly owner: AssetOwner;
  readonly representationIds: readonly string[];
  readonly approvals?: ConversionApprovalPort;
  leaseCurrent(): Promise<boolean>;
  sha256(bytes: Uint8Array): Promise<string>;
}): Promise<DirectDeliveryReader> {
  const owner = { ...input.owner };
  const ids = [...input.representationIds];
  const store = input.store;
  const hash = input.sha256;
  const checkLease = input.leaseCurrent;
  const leaseCurrent = async (): Promise<boolean> => {
    try {
      return (await checkLease()) === true;
    } catch {
      return false;
    }
  };
  if (!(await leaseCurrent())) return unavailable();
  const assets = await resolveDirectDeliveryAssets(store, owner, ids, input.approvals);
  if (!(await leaseCurrent())) return unavailable();
  let closed = false;
  let busy = false;
  let index = 0;
  let offset = 0;
  let cached: Uint8Array | null = null;
  const close = (): void => {
    closed = true;
    cached?.fill(0);
    cached = null;
  };
  const isCurrent = async (): Promise<boolean> => {
    if (closed || !(await leaseCurrent()) || closed) {
      close();
      return false;
    }
    try {
      const current = await resolveDirectDeliveryAssets(store, owner, ids, input.approvals);
      if (closed || !isDeepStrictEqual(assets, current) || !(await leaseCurrent()) || closed) {
        close();
        return false;
      }
      return true;
    } catch {
      close();
      return false;
    }
  };
  const skipEmpty = (): void => {
    while (index < assets.length && assets[index]?.representation.bytes === 0) index++;
  };
  return {
    get assets() {
      return structuredClone(assets);
    },
    isCurrent,
    close,
    async readChunk(id, requestedOffset, length) {
      if (busy || closed) return unavailable();
      busy = true;
      try {
        if (!(await isCurrent())) return unavailable();
        skipEmpty();
        const asset = assets[index];
        if (
          !asset ||
          id !== asset.representation.id ||
          !Number.isSafeInteger(requestedOffset) ||
          requestedOffset !== offset ||
          !Number.isSafeInteger(length) ||
          length <= 0 ||
          length > ATTACHMENT_LIMITS.importChunkBytes ||
          offset + length > asset.representation.bytes
        ) {
          close();
          return unavailable();
        }
        if (!cached) {
          cached = await readDirectDeliveryAsset(store, owner, asset, hash, input.approvals);
          if (!(await isCurrent())) return unavailable();
        }
        const result = cached.slice(offset, offset + length);
        offset += length;
        if (offset === asset.representation.bytes) {
          cached.fill(0);
          cached = null;
          index++;
          offset = 0;
        }
        return result;
      } catch (error) {
        close();
        throw error;
      } finally {
        busy = false;
      }
    },
  };
}
