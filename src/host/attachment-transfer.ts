import {
  ATTACHMENT_LIMITS,
  isAttachmentId,
  type AttachmentDeliveryScope,
  type AuthorizedAttachmentAsset,
} from "../shared/attachments";
import { isAuthorizedAttachmentAsset } from "./attachment-plan";

export interface AttachmentTransferReader {
  readonly id: string;
  readonly scope: AttachmentDeliveryScope;
  readonly expiresAt: number;
  readonly assets: readonly AuthorizedAttachmentAsset[];
  isCurrent(): boolean;
  readChunk(id: string, offset: number, length: number): Promise<Uint8Array>;
  close(): void;
}

export interface AttachmentTransferStore {
  /** PRIVATE parent channel only. Metadata is never renderer-authorized by an ID. */
  begin(input: {
    id: string;
    scope: AttachmentDeliveryScope;
    expiresAt: number;
    assets: readonly AuthorizedAttachmentAsset[];
  }): void;
  chunk(id: string, representationId: string, offset: number, canonicalBase64: string): void;
  seal(id: string): AttachmentTransferReader;
  cancel(id: string): void;
  stats(): { slots: number; reservedBytes: number };
  dispose(): void;
}

interface Part {
  asset: AuthorizedAttachmentAsset;
  buffer: Uint8Array | null;
  filled: number;
}
interface Transfer {
  id: string;
  scope: AttachmentDeliveryScope;
  expiresAt: number;
  parts: Part[];
  bytes: number;
  writeIndex: number;
  readIndex: number;
  readOffset: number;
  sealed: boolean;
  closed: boolean;
  cancelTimer: (() => void) | null;
}

function fail(): never {
  throw new Error("attachment transfer unavailable");
}
function label(value: unknown, max = 512): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return false;
  }
  return true;
}
function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function validScope(scope: AttachmentDeliveryScope): boolean {
  const keys = [
    "authorityId",
    "leaseId",
    "profileKey",
    "tabId",
    "draftId",
    "hostGeneration",
    "processGeneration",
    "sessionId",
    "sessionEpoch",
    "branchId",
    "revision",
  ];
  return (
    !!scope &&
    Object.keys(scope).length === keys.length &&
    Object.keys(scope).every((key) => keys.includes(key)) &&
    isAttachmentId(scope.authorityId) &&
    isAttachmentId(scope.leaseId) &&
    /^[0-9a-f]{64}$/.test(scope.profileKey) &&
    label(scope.tabId, 128) &&
    isAttachmentId(scope.draftId) &&
    count(scope.hostGeneration) &&
    count(scope.processGeneration) &&
    scope.processGeneration > 0 &&
    label(scope.sessionId) &&
    count(scope.sessionEpoch) &&
    scope.sessionEpoch > 0 &&
    (scope.branchId === null || label(scope.branchId)) &&
    label(scope.revision)
  );
}

/** Copy only bounded known metadata, not arbitrary extra properties from a frame. */
function copyAsset(asset: AuthorizedAttachmentAsset): AuthorizedAttachmentAsset {
  const original = asset.original;
  const rep = asset.representation;
  return {
    original: {
      id: original.id,
      name: original.name,
      kind: original.kind,
      bytes: original.bytes,
      sha256: original.sha256,
    },
    representation: {
      id: rep.id,
      attachmentId: rep.attachmentId,
      modality: rep.modality,
      origin: rep.origin,
      bytes: rep.bytes,
      originalSha256: rep.originalSha256,
      representationSha256: rep.representationSha256,
      preparationVersion: rep.preparationVersion,
      approved: rep.approved,
      warnings: [...rep.warnings],
    },
    image: asset.image
      ? { mime: asset.image.mime, width: asset.image.width, height: asset.image.height }
      : null,
    approvalDigest: asset.approvalDigest,
  };
}

/**
 * Bounded host-local receiver for the PRIVATE parent-owned push protocol. No
 * filesystem paths, provider credentials or SDK calls. All mutations and hashing
 * are synchronous, so concurrent protocol handlers cannot interleave a
 * chunk/seal operation; there are no detached asynchronous buffer writers.
 * `session-core` checks the trusted context fence and feeds sealed readers into
 * the host planner/materializer/SDK adapter. This store alone grants no access.
 */
export function createAttachmentTransferStore(deps: {
  now(): number;
  current(scope: AttachmentDeliveryScope): boolean;
  /** Synchronous bounded hashing avoids an uncancellable hashing task owning buffers. */
  sha256(bytes: Uint8Array): string;
  schedule(delayMs: number, callback: () => void): () => void;
}): AttachmentTransferStore {
  const transfers = new Map<string, Transfer>();
  let disposed = false;
  let authority: string | null = null;
  let lastOrdinal = -1n;
  let lastTime = 0;

  function time(): number {
    const now = deps.now();
    if (
      !count(now) ||
      now < lastTime ||
      now > Number.MAX_SAFE_INTEGER - ATTACHMENT_LIMITS.deliveryLifetimeMs
    )
      return fail();
    lastTime = now;
    return now;
  }
  function close(transfer: Transfer): void {
    if (transfer.closed) return;
    transfer.closed = true;
    for (const part of transfer.parts) {
      part.buffer?.fill(0);
      part.buffer = null;
    }
    transfers.delete(transfer.id);
    try {
      transfer.cancelTimer?.();
    } catch {
      /* A late callback sees closed and is inert. */
    }
    transfer.cancelTimer = null;
  }
  function current(transfer: Transfer): boolean {
    if (transfer.closed) return false;
    try {
      if (!disposed && time() < transfer.expiresAt && deps.current(transfer.scope) === true)
        return true;
    } catch {
      /* Fail closed on uncertain host context. */
    }
    close(transfer);
    return false;
  }
  function requireTransfer(id: string): Transfer {
    const transfer = transfers.get(id);
    if (!transfer || !current(transfer)) return fail();
    return transfer;
  }
  function skipEmpty(transfer: Transfer, write: boolean): void {
    if (write) {
      while (transfer.parts[transfer.writeIndex]?.asset.representation.bytes === 0)
        transfer.writeIndex++;
    } else {
      while (transfer.parts[transfer.readIndex]?.asset.representation.bytes === 0)
        transfer.readIndex++;
    }
  }

  return {
    begin(input) {
      if (
        disposed ||
        !isAttachmentId(input.id) ||
        !validScope(input.scope) ||
        !Array.isArray(input.assets) ||
        input.assets.length === 0 ||
        input.assets.length > ATTACHMENT_LIMITS.filesPerDraft ||
        input.assets.some((asset) => !isAuthorizedAttachmentAsset(asset))
      )
        return fail();
      if (transfers.size >= ATTACHMENT_LIMITS.deliverySlots || transfers.has(input.id))
        return fail();
      const scope = Object.freeze({ ...input.scope });
      if (authority !== null && authority !== scope.authorityId) return fail();
      // Match the main authority's monotonic UUID tail. Retired transfer IDs can
      // never be replayed, without a lifetime-growing tombstone Set/Map.
      if (scope.leaseId !== input.id || input.id.slice(0, 24) !== scope.authorityId.slice(0, 24))
        return fail();
      const ordinal =
        BigInt(`0x${input.id.slice(24)}`) ^ BigInt(`0x${scope.authorityId.slice(24)}`);
      if (ordinal <= lastOrdinal) return fail();
      const now = time();
      if (!count(input.expiresAt) || input.expiresAt <= now || deps.current(scope) !== true)
        return fail();
      const assets = input.assets.map(copyAsset);
      let bytes = 0;
      let originalBytes = 0;
      let textBytes = 0;
      let encodedImages = 0;
      const originals = new Set<string>();
      const representations = new Set<string>();
      for (const asset of assets) {
        const rep = asset.representation;
        if (
          rep.origin !== "direct" ||
          !rep.approved ||
          !["text", "image"].includes(rep.modality) ||
          asset.original.kind !== rep.modality ||
          originals.has(asset.original.id) ||
          representations.has(rep.id)
        )
          return fail();
        originals.add(asset.original.id);
        representations.add(rep.id);
        const originalLimit =
          rep.modality === "text"
            ? ATTACHMENT_LIMITS.textOriginalBytes
            : ATTACHMENT_LIMITS.imageOriginalBytes;
        const preparedLimit =
          rep.modality === "text"
            ? ATTACHMENT_LIMITS.promptTextBytesPerFile
            : ATTACHMENT_LIMITS.imageOriginalBytes;
        if (asset.original.bytes > originalLimit || rep.bytes > preparedLimit) return fail();
        bytes += rep.bytes;
        originalBytes += asset.original.bytes;
        if (rep.modality === "text") textBytes += rep.bytes;
        else encodedImages += Math.ceil(rep.bytes / 3) * 4;
      }
      if (
        bytes > ATTACHMENT_LIMITS.estimatedRequestBytes ||
        originalBytes > ATTACHMENT_LIMITS.draftOriginalBytes ||
        textBytes > ATTACHMENT_LIMITS.promptTextBytesTotal ||
        encodedImages > ATTACHMENT_LIMITS.imageEncodedBytesTotal
      )
        return fail();
      const transfer: Transfer = {
        id: input.id,
        scope,
        expiresAt: Math.min(input.expiresAt, now + ATTACHMENT_LIMITS.deliveryLifetimeMs),
        parts: assets.map((asset) => ({ asset, buffer: null, filled: 0 })),
        bytes,
        writeIndex: 0,
        readIndex: 0,
        readOffset: 0,
        sealed: false,
        closed: false,
        cancelTimer: null,
      };
      authority = scope.authorityId;
      lastOrdinal = ordinal;
      transfers.set(input.id, transfer);
      try {
        transfer.cancelTimer = deps.schedule(transfer.expiresAt - now, () => close(transfer));
      } catch {
        close(transfer);
        return fail();
      }
    },
    chunk(id, representationId, offset, encoded) {
      const transfer = requireTransfer(id);
      let data: Buffer | null = null;
      try {
        skipEmpty(transfer, true);
        const part = transfer.parts[transfer.writeIndex];
        if (
          transfer.sealed ||
          !part ||
          representationId !== part.asset.representation.id ||
          !count(offset) ||
          offset !== part.filled ||
          typeof encoded !== "string" ||
          encoded.length === 0 ||
          encoded.length > Math.ceil(ATTACHMENT_LIMITS.importChunkBytes / 3) * 4
        )
          return fail();
        data = Buffer.from(encoded, "base64");
        if (
          data.length === 0 ||
          data.length > ATTACHMENT_LIMITS.importChunkBytes ||
          data.toString("base64") !== encoded ||
          offset + data.length > part.asset.representation.bytes
        )
          return fail();
        part.buffer ??= new Uint8Array(part.asset.representation.bytes);
        part.buffer.set(data, offset);
        part.filled += data.length;
        if (part.filled === part.asset.representation.bytes) transfer.writeIndex++;
      } catch {
        close(transfer);
        return fail();
      } finally {
        data?.fill(0);
      }
    },
    seal(id) {
      const transfer = requireTransfer(id);
      try {
        skipEmpty(transfer, true);
        if (transfer.sealed || transfer.writeIndex !== transfer.parts.length) return fail();
        for (const part of transfer.parts) {
          part.buffer ??= new Uint8Array(0);
          if (deps.sha256(part.buffer) !== part.asset.representation.representationSha256)
            return fail();
        }
        if (!current(transfer)) return fail();
        transfer.sealed = true;
      } catch {
        close(transfer);
        return fail();
      }
      return Object.freeze({
        id: transfer.id,
        scope: transfer.scope,
        expiresAt: transfer.expiresAt,
        get assets() {
          if (!current(transfer)) return fail();
          return transfer.parts.map((part) => structuredClone(part.asset));
        },
        isCurrent: () => current(transfer),
        async readChunk(representationId: string, offset: number, length: number) {
          try {
            if (!current(transfer)) return fail();
            skipEmpty(transfer, false);
            const part = transfer.parts[transfer.readIndex];
            if (
              !part?.buffer ||
              representationId !== part.asset.representation.id ||
              !count(offset) ||
              offset !== transfer.readOffset ||
              !count(length) ||
              length === 0 ||
              length > ATTACHMENT_LIMITS.importChunkBytes ||
              offset + length > part.buffer.length
            )
              return fail();
            const result = part.buffer.slice(offset, offset + length);
            transfer.readOffset += length;
            if (transfer.readOffset === part.buffer.length) {
              transfer.readIndex++;
              transfer.readOffset = 0;
            }
            return result;
          } catch {
            close(transfer);
            return fail();
          }
        },
        close: () => close(transfer),
      });
    },
    cancel(id) {
      const transfer = transfers.get(id);
      if (transfer) close(transfer);
    },
    stats: () => ({
      slots: transfers.size,
      reservedBytes: [...transfers.values()].reduce((sum, transfer) => sum + transfer.bytes, 0),
    }),
    dispose() {
      disposed = true;
      for (const transfer of transfers.values()) close(transfer);
    },
  };
}
