import { describe, expect, it } from "vitest";
import {
  describeAttachment,
  originalKindForClassification,
  preparedImageRepresentation,
  preparedRepresentation,
} from "../../src/main/attachment-descriptors";
import type { AssetRecord } from "../../src/attachments/store";
import type {
  AttachmentClassification,
  AttachmentOriginalKind,
} from "../../src/shared/attachments";

const digest = (character: string): string => character.repeat(64);

function classification(
  overrides: Partial<AttachmentClassification> = {},
): AttachmentClassification {
  return {
    version: "desktop-classify-v1",
    kind: "text",
    format: "text",
    detectedMime: "text/plain",
    warnings: [],
    text: { promptBytes: 5, empty: false },
    image: null,
    failure: null,
    ...overrides,
  };
}

function record(overrides: Partial<AssetRecord> = {}): AssetRecord {
  return {
    id: "123e4567-e89b-42d3-a456-000000000001",
    kind: "original",
    name: "notes.txt",
    mimeType: "text/plain",
    size: 5,
    sha256: digest("a"),
    createdAt: 10,
    owners: [{ kind: "draft", id: "draft-1" }],
    unownedAt: null,
    originalId: null,
    originalSha256: null,
    ...overrides,
  };
}

function representation(original: AssetRecord, overrides: Partial<AssetRecord> = {}): AssetRecord {
  return record({
    id: "123e4567-e89b-42d3-a456-000000000002",
    kind: "representation",
    size: 5,
    sha256: digest("b"),
    originalId: original.id,
    originalSha256: original.sha256,
    preparation: {
      version: 1,
      modality: "text",
      preparationVersion: "desktop-direct-v1",
      warnings: [],
      details: { kind: "text", empty: false, utf8Bom: false },
    },
    ...overrides,
  });
}

describe("attachment descriptor projection", () => {
  it("describes a classified text file and its prepared representation", () => {
    const original = record();
    const prepared = representation(original);
    const descriptor = describeAttachment(original, [original, prepared], classification());
    expect(descriptor).toMatchObject({
      id: original.id,
      name: "notes.txt",
      mimeType: "text/plain",
      size: 5,
      originalKind: "text",
      detectedMime: "text/plain",
      status: "ready",
      reason: null,
      representationId: prepared.id,
      previewAvailable: true,
    });
  });

  it("keeps an unprepared image eligible without inventing a representation", () => {
    const original = record({
      name: "pixel.png",
      mimeType: "image/png",
      size: 40,
    });
    const descriptor = describeAttachment(
      original,
      [original],
      classification({
        kind: "image",
        format: "png",
        detectedMime: "image/png",
        text: null,
        image: { width: 2, height: 2, animated: false },
      }),
    );
    expect(descriptor).toMatchObject({
      originalKind: "image",
      status: "ready",
      representationId: null,
      previewAvailable: true,
    });
  });

  it("never reuses a representation prepared from different original bytes", () => {
    const original = record();
    const stale = representation(original, { originalSha256: digest("c") });
    const descriptor = describeAttachment(original, [original, stale], classification());
    expect(descriptor.representationId).toBeNull();
    expect(preparedRepresentation([original, stale], original)).toBeNull();
    expect(preparedImageRepresentation([original, stale], original)).toBeNull();
  });

  it("maps documents to needs-conversion with their family", () => {
    const families: Array<[string, AttachmentOriginalKind]> = [
      ["pdf", "pdf"],
      ["docx", "word"],
      ["odt", "word"],
      ["xlsx", "spreadsheet"],
      ["ods", "spreadsheet"],
      ["pptx", "presentation"],
      ["odp", "presentation"],
    ];
    for (const [format, kind] of families) {
      const original = record({ name: `document.${format}`, mimeType: "application/pdf" });
      const value = classification({
        kind: "document",
        format,
        detectedMime: "application/pdf",
        text: null,
      });
      expect(originalKindForClassification(value)).toBe(kind);
      expect(describeAttachment(original, [original], value)).toMatchObject({
        originalKind: kind,
        status: "needs_conversion",
        reason: "conversion_required",
        previewAvailable: false,
        representationId: null,
      });
    }
  });

  it("projects recorded classification failures as blocked, never as ready", () => {
    const original = record({ name: "clip.mp3", mimeType: "audio/mpeg" });
    const descriptor = describeAttachment(
      original,
      [original],
      classification({
        kind: "unsupported",
        format: null,
        detectedMime: null,
        text: null,
        failure: "format_unsupported",
      }),
    );
    expect(descriptor).toMatchObject({
      status: "blocked",
      reason: "format_unsupported",
      previewAvailable: false,
      originalKind: "other",
    });
  });
});
