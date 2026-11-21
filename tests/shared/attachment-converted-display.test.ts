import { describe, expect, it } from "vitest";
import { validateAttachmentTranscriptCard } from "../../src/shared/attachments";

const id = (n: number): string =>
  `123e4567-e89b-42d3-a456-${String(426614174000 + n).padStart(12, "0")}`;

/** Converted text keeps a document original kind while its modality is text. */
const converted = {
  version: 1,
  status: "submitted",
  associationEntryId: "association-1",
  userEntryId: "user-entry-1",
  turnId: id(1),
  files: [
    {
      representationId: id(2),
      originalId: id(3),
      modality: "text",
      display: {
        name: "report.pdf.txt",
        originalKind: "pdf",
        originalBytes: 100_000,
        representationBytes: 42,
        origin: "converted",
        preparationVersion: "pdfjs@6.5.438",
        warnings: ["scanned_page_no_text"],
        coverage: { kind: "entire-file" },
        image: null,
      },
    },
  ],
};

describe("converted transcript display", () => {
  it("accepts a converted document rendered as submitted text", () => {
    expect(validateAttachmentTranscriptCard(converted)).toMatchObject({
      files: [{ modality: "text", display: { originalKind: "pdf", origin: "converted" } }],
    });
  });

  it("refuses a document kind on a direct display or with an image block", () => {
    expect(
      validateAttachmentTranscriptCard({
        ...converted,
        files: [
          {
            ...converted.files[0],
            display: { ...converted.files[0]!.display, origin: "direct" },
          },
        ],
      }),
    ).toBeNull();
    expect(
      validateAttachmentTranscriptCard({
        ...converted,
        files: [
          {
            ...converted.files[0],
            display: {
              ...converted.files[0]!.display,
              image: { mime: "image/png", width: 1, height: 1 },
            },
          },
        ],
      }),
    ).toBeNull();
  });
});
