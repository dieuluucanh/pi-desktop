/**
 * Bounded in-memory thumbnail cache for the tray and future transcript cards.
 *
 * Thumbnails are produced only by the host from an already validated prepared
 * image (see `src/host/attachment-image-preparation.ts`). Main never decodes an
 * original itself, never persists a preview, and never serves bytes without a
 * live draft grant. Entries are content-addressed by the prepared digest, so a
 * stale entry can never be shown for different bytes.
 */

export interface AttachmentThumbnail {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
}

export interface AttachmentThumbnailCache {
  put(sha256: string, thumbnail: AttachmentThumbnail): void;
  get(sha256: string): AttachmentThumbnail | null;
  size(): number;
  clear(): void;
}

export const ATTACHMENT_THUMBNAIL_CACHE_LIMITS = {
  entries: 64,
  bytes: 4 * 1024 * 1024,
} as const;

export function createAttachmentThumbnailCache(): AttachmentThumbnailCache {
  const entries = new Map<string, AttachmentThumbnail>();
  let bytes = 0;

  const evict = (): void => {
    while (
      entries.size > ATTACHMENT_THUMBNAIL_CACHE_LIMITS.entries ||
      bytes > ATTACHMENT_THUMBNAIL_CACHE_LIMITS.bytes
    ) {
      const oldest = entries.entries().next();
      if (oldest.done) return;
      entries.delete(oldest.value[0]);
      bytes -= oldest.value[1].bytes.byteLength;
    }
  };

  return {
    put(sha256, thumbnail) {
      if (!/^[0-9a-f]{64}$/.test(sha256)) return;
      if (
        !(thumbnail?.bytes instanceof Uint8Array) ||
        thumbnail.bytes.byteLength === 0 ||
        thumbnail.bytes.byteLength > ATTACHMENT_THUMBNAIL_CACHE_LIMITS.bytes ||
        !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(thumbnail.mimeType) ||
        !Number.isSafeInteger(thumbnail.width) ||
        thumbnail.width <= 0 ||
        !Number.isSafeInteger(thumbnail.height) ||
        thumbnail.height <= 0
      )
        return;
      const existing = entries.get(sha256);
      if (existing) {
        bytes -= existing.bytes.byteLength;
        entries.delete(sha256);
      }
      const copy = { ...thumbnail, bytes: new Uint8Array(thumbnail.bytes) };
      entries.set(sha256, copy);
      bytes += copy.bytes.byteLength;
      evict();
    },
    get(sha256) {
      const entry = entries.get(sha256);
      if (!entry) return null;
      // LRU touch: re-insert without re-copying the bounded buffer.
      entries.delete(sha256);
      entries.set(sha256, entry);
      return { ...entry, bytes: new Uint8Array(entry.bytes) };
    },
    size: () => entries.size,
    clear() {
      entries.clear();
      bytes = 0;
    },
  };
}
