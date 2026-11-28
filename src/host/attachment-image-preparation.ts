import {
  ATTACHMENT_LIMITS,
  isAttachmentId,
  type AttachmentImagePreparationDescription,
  type AttachmentImagePreparationLimits,
} from "../shared/attachments";
import { IMAGE_THUMBNAIL_LIMITS, type PreparedRaster } from "../attachments/prepare-image";

/**
 * Purpose-scoped parent→host preparation channel for *original* images.
 *
 * This is deliberately narrower than the delivery transfer store: it receives
 * one owner-checked original snapshot from main, runs the public SDK image
 * preparation, and lets main pull the prepared representation and a bounded
 * thumbnail back in chunks. It stages no approved representation, grants no
 * renderer path, and never writes to disk. Main re-inspects and re-hashes every
 * returned byte; this store is only a bounded decoder endpoint.
 */

export interface ImagePreparationEncoder {
  (input: {
    readonly bytes: Uint8Array;
    readonly limits: AttachmentImagePreparationLimits;
  }): Promise<PreparedRaster>;
}

export interface AttachmentImagePreparationStore {
  begin(input: {
    readonly id: string;
    readonly originalId: string;
    readonly originalSha256: string;
    readonly bytes: number;
    readonly mime: string;
    readonly expiresAt: number;
  }): void;
  chunk(id: string, offset: number, encoded: string): void;
  prepare(
    id: string,
    limits: AttachmentImagePreparationLimits,
  ): Promise<AttachmentImagePreparationDescription>;
  readChunk(id: string, part: PreparationPart, offset: number, length: number): string;
  cancel(id: string): void;
  stats(): { readonly slots: number; readonly bytes: number };
  dispose(): void;
}

export type PreparationPart = "prepared" | "thumbnail";

const RASTER_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"] as const;

interface Part {
  bytes: Uint8Array;
  filled: number;
  read: number;
}

interface Thumbnail {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
}

interface Entry {
  readonly id: string;
  readonly originalSha256: string;
  readonly size: number;
  readonly expiresAt: number;
  source: Part | null;
  prepared: Part | null;
  thumbnail: Part | null;
  description: AttachmentImagePreparationDescription | null;
  preparing: boolean;
  closed: boolean;
  cancelTimer: (() => void) | null;
}

function fail(): never {
  throw new Error("image preparation unavailable");
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function safeShrink(encode: ImagePreparationEncoder, bytes: Uint8Array): Promise<Thumbnail | null> {
  return (async () => {
    try {
      const prepared = await encode({
        bytes: new Uint8Array(bytes),
        limits: { ...IMAGE_THUMBNAIL_LIMITS },
      });
      const output = new Uint8Array(prepared.bytes);
      if (
        output.byteLength === 0 ||
        Math.ceil(output.byteLength / 3) * 4 > IMAGE_THUMBNAIL_LIMITS.maxEncodedBytes ||
        prepared.width > IMAGE_THUMBNAIL_LIMITS.maxWidth ||
        prepared.height > IMAGE_THUMBNAIL_LIMITS.maxHeight
      )
        return null;
      return {
        bytes: output,
        mime: prepared.mime,
        width: prepared.width,
        height: prepared.height,
      };
    } catch {
      return null;
    }
  })();
}

export function createAttachmentImagePreparationStore(deps: {
  now(): number;
  /** Injected timer; the store owns no timers of its own. */
  schedule(delayMs: number, callback: () => void): () => void;
  /** Synchronous bounded hashing avoids detached hashing tasks owning buffers. */
  sha256(bytes: Uint8Array): string;
  encode: ImagePreparationEncoder;
}): AttachmentImagePreparationStore {
  const entries = new Map<string, Entry>();
  let disposed = false;
  let lastTime = 0;

  function time(): number {
    const value = deps.now();
    if (
      !count(value) ||
      value < lastTime ||
      value > Number.MAX_SAFE_INTEGER - ATTACHMENT_LIMITS.imagePreparationLifetimeMs
    )
      return fail();
    lastTime = value;
    return value;
  }

  function close(entry: Entry): void {
    if (entry.closed) return;
    entry.closed = true;
    for (const part of [entry.source, entry.prepared, entry.thumbnail]) part?.bytes.fill(0);
    entry.source = null;
    entry.prepared = null;
    entry.thumbnail = null;
    entry.description = null;
    entries.delete(entry.id);
    try {
      entry.cancelTimer?.();
    } catch {
      /* A late callback sees closed and is inert. */
    }
    entry.cancelTimer = null;
  }

  function current(entry: Entry): Entry {
    if (entry.closed || disposed) return fail();
    try {
      if (time() < entry.expiresAt) return entry;
    } catch {
      /* Fall through to the closed path. */
    }
    close(entry);
    return fail();
  }

  function requireEntry(id: unknown): Entry {
    if (typeof id !== "string") return fail();
    const entry = entries.get(id);
    if (!entry) return fail();
    return current(entry);
  }

  function part(entry: Entry, name: PreparationPart): Part {
    const value = name === "prepared" ? entry.prepared : entry.thumbnail;
    if (!value) return fail();
    return value;
  }

  return {
    begin(input) {
      if (
        disposed ||
        !isAttachmentId(input.id) ||
        !isAttachmentId(input.originalId) ||
        !digest(input.originalSha256) ||
        !count(input.bytes) ||
        input.bytes <= 0 ||
        input.bytes > ATTACHMENT_LIMITS.imageOriginalBytes ||
        !RASTER_MIMES.includes(input.mime as (typeof RASTER_MIMES)[number]) ||
        !count(input.expiresAt) ||
        entries.has(input.id)
      )
        return fail();
      if (entries.size >= ATTACHMENT_LIMITS.concurrentImagePreparations) return fail();
      const now = time();
      if (input.expiresAt <= now) return fail();
      const entry: Entry = {
        id: input.id,
        originalSha256: input.originalSha256,
        size: input.bytes,
        expiresAt: Math.min(input.expiresAt, now + ATTACHMENT_LIMITS.imagePreparationLifetimeMs),
        source: { bytes: new Uint8Array(input.bytes), filled: 0, read: 0 },
        prepared: null,
        thumbnail: null,
        description: null,
        preparing: false,
        closed: false,
        cancelTimer: null,
      };
      entries.set(entry.id, entry);
      try {
        entry.cancelTimer = deps.schedule(entry.expiresAt - now, () => close(entry));
      } catch {
        close(entry);
        return fail();
      }
    },
    chunk(id, offset, encoded) {
      const entry = requireEntry(id);
      let data: Buffer | null = null;
      try {
        const source = entry.source;
        if (
          entry.preparing ||
          !source ||
          !count(offset) ||
          offset !== source.filled ||
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
          offset + data.length > source.bytes.length
        )
          return fail();
        source.bytes.set(data, offset);
        source.filled += data.length;
      } catch {
        close(entry);
        return fail();
      } finally {
        data?.fill(0);
      }
    },
    async prepare(id, limits) {
      const entry = requireEntry(id);
      if (entry.preparing || entry.prepared || !entry.source || entry.source.filled !== entry.size)
        return fail();
      if (
        !limits ||
        !Number.isSafeInteger(limits.maxWidth) ||
        limits.maxWidth <= 0 ||
        !Number.isSafeInteger(limits.maxHeight) ||
        limits.maxHeight <= 0 ||
        !Number.isSafeInteger(limits.maxEncodedBytes) ||
        limits.maxEncodedBytes <= 0
      )
        return fail();
      const source = entry.source;
      if (deps.sha256(source.bytes.subarray(0, source.filled)) !== entry.originalSha256) {
        close(entry);
        return fail();
      }
      entry.preparing = true;
      try {
        const prepared = await deps.encode({
          bytes: new Uint8Array(source.bytes.subarray(0, source.filled)),
          limits: { ...limits },
        });
        if (entry.closed) return fail();
        const preparedBytes = new Uint8Array(prepared.bytes);
        const thumbnail = await safeShrink(deps.encode, preparedBytes);
        if (entry.closed) {
          preparedBytes.fill(0);
          thumbnail?.bytes.fill(0);
          return fail();
        }
        entry.source.bytes.fill(0);
        entry.source = null;
        entry.prepared = { bytes: preparedBytes, filled: preparedBytes.byteLength, read: 0 };
        entry.thumbnail = thumbnail
          ? { bytes: thumbnail.bytes, filled: thumbnail.bytes.byteLength, read: 0 }
          : null;
        entry.description = {
          sha256: deps.sha256(preparedBytes),
          bytes: preparedBytes.byteLength,
          mimeType: prepared.mime,
          width: prepared.width,
          height: prepared.height,
          originalWidth: prepared.original.width,
          originalHeight: prepared.original.height,
          thumbnail: thumbnail
            ? {
                sha256: deps.sha256(thumbnail.bytes),
                bytes: thumbnail.bytes.byteLength,
                mimeType: thumbnail.mime,
                width: thumbnail.width,
                height: thumbnail.height,
              }
            : null,
        };
        return entry.description;
      } catch {
        close(entry);
        return fail();
      } finally {
        entry.preparing = false;
      }
    },
    readChunk(id, name, offset, length) {
      const entry = requireEntry(id);
      try {
        const target = part(entry, name);
        if (
          entry.preparing ||
          !count(offset) ||
          offset !== target.read ||
          !count(length) ||
          length === 0 ||
          length > ATTACHMENT_LIMITS.importChunkBytes ||
          offset + length > target.bytes.length
        )
          return fail();
        const chunk = target.bytes.slice(offset, offset + length);
        target.read += length;
        return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("base64");
      } catch {
        close(entry);
        return fail();
      }
    },
    cancel(id) {
      if (typeof id !== "string") return;
      const entry = entries.get(id);
      if (entry) close(entry);
    },
    stats: () => ({
      slots: entries.size,
      bytes: [...entries.values()].reduce(
        (sum, entry) =>
          sum +
          (entry.source?.bytes.length ?? 0) +
          (entry.prepared?.bytes.length ?? 0) +
          (entry.thumbnail?.bytes.length ?? 0),
        0,
      ),
    }),
    dispose() {
      disposed = true;
      for (const entry of entries.values()) close(entry);
    },
  };
}
