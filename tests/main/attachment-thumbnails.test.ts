import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_THUMBNAIL_CACHE_LIMITS,
  createAttachmentThumbnailCache,
} from "../../src/main/attachment-thumbnails";

const digest = (index: number): string => index.toString(16).padStart(64, "0");

function thumbnail(bytes = 4) {
  return {
    bytes: new Uint8Array(bytes).fill(7),
    mimeType: "image/png",
    width: 16,
    height: 16,
  };
}

describe("attachment thumbnail cache", () => {
  it("stores bounded copies keyed by the prepared digest", () => {
    const cache = createAttachmentThumbnailCache();
    const source = thumbnail();
    cache.put(digest(1), source);
    source.bytes.fill(0);
    const stored = cache.get(digest(1));
    expect(stored?.bytes).toEqual(new Uint8Array(4).fill(7));
    // Every read is a fresh copy; mutating it cannot corrupt the cache.
    stored!.bytes.fill(1);
    expect(cache.get(digest(1))?.bytes).toEqual(new Uint8Array(4).fill(7));
    expect(cache.size()).toBe(1);
    expect(cache.get(digest(2))).toBeNull();
  });

  it("rejects malformed digests, oversized payloads and unsupported mimes", () => {
    const cache = createAttachmentThumbnailCache();
    cache.put("not-a-digest", thumbnail());
    cache.put(digest(1), { ...thumbnail(), mimeType: "image/svg+xml" });
    cache.put(digest(2), { ...thumbnail(), bytes: new Uint8Array(0) });
    expect(cache.size()).toBe(0);
  });

  it("evicts the oldest entries beyond the entry ceiling", () => {
    const cache = createAttachmentThumbnailCache();
    for (let index = 0; index <= ATTACHMENT_THUMBNAIL_CACHE_LIMITS.entries; index++) {
      cache.put(digest(index), thumbnail());
    }
    expect(cache.size()).toBe(ATTACHMENT_THUMBNAIL_CACHE_LIMITS.entries);
    expect(cache.get(digest(0))).toBeNull();
  });

  it("evicts beyond the byte ceiling and clears on demand", () => {
    const cache = createAttachmentThumbnailCache();
    const quarter = Math.floor(ATTACHMENT_THUMBNAIL_CACHE_LIMITS.bytes / 4);
    for (let index = 0; index < 6; index++) {
      cache.put(digest(index), thumbnail(quarter));
    }
    expect(cache.size()).toBeLessThanOrEqual(4);
    expect(cache.get(digest(5))).not.toBeNull();
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it("refreshes recency on read", () => {
    const cache = createAttachmentThumbnailCache();
    for (let index = 0; index < ATTACHMENT_THUMBNAIL_CACHE_LIMITS.entries; index++) {
      cache.put(digest(index), thumbnail());
    }
    expect(cache.get(digest(0))).not.toBeNull();
    cache.put(digest(999), thumbnail());
    expect(cache.get(digest(0))).not.toBeNull();
    expect(cache.get(digest(1))).toBeNull();
  });
});
