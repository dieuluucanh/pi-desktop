import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_TEXT_ENVELOPE_HEADER,
  attachmentTextPreview,
  frameAttachmentTextSections,
  parseAttachmentTextEnvelope,
  type AttachmentTextEnvelopeInput,
} from "../../src/shared/attachment-text-envelope";

const opaque = (n: number): string =>
  `123e4567-e89b-42d3-a456-${String(426614174000 + n).padStart(12, "0")}`;
const sha = (character: string): string => character.repeat(64);

function section(n: number, name: string, text: string): AttachmentTextEnvelopeInput {
  return { id: opaque(n), name, representationSha256: sha(String(n % 10)), text };
}

function framed(sections: readonly AttachmentTextEnvelopeInput[]): string {
  const result = frameAttachmentTextSections(sections);
  if (!result.ok) throw new Error(`framing failed: ${result.reason}`);
  return result.framed;
}

function expected(sections: readonly AttachmentTextEnvelopeInput[]) {
  return sections.map((item) => ({
    id: item.id,
    name: item.name,
    representationBytes: new TextEncoder().encode(item.text).byteLength,
  }));
}

describe("attachment text envelope", () => {
  it("round-trips prose plus managed sections and escapes line separators", () => {
    const sections = [section(1, "a.txt", "alpha\u2028beta"), section(2, "b.csv", "x,y\n1,2")];
    const text = `Summarize these\n\n${framed(sections)}`;
    expect(text).toContain(ATTACHMENT_TEXT_ENVELOPE_HEADER);
    // U+2028 must never survive as a real line separator inside the envelope.
    expect(text.slice(text.indexOf(ATTACHMENT_TEXT_ENVELOPE_HEADER))).not.toContain("\u2028");
    expect(parseAttachmentTextEnvelope(text, expected(sections))).toEqual({
      prose: "Summarize these",
      sections: [
        {
          id: opaque(1),
          name: "a.txt",
          representationSha256: sha("1"),
          byteLength: 12,
          text: "alpha\u2028beta",
        },
        {
          id: opaque(2),
          name: "b.csv",
          representationSha256: sha("2"),
          byteLength: 7,
          text: "x,y\n1,2",
        },
      ],
    });
  });

  it("parses a file-only prompt as empty prose", () => {
    const sections = [section(3, "notes.md", "body")];
    const parsed = parseAttachmentTextEnvelope(framed(sections), expected(sections));
    expect(parsed?.prose).toBe("");
    expect(parsed?.sections).toHaveLength(1);
  });

  it("keeps ordinary prose that merely resembles a marker", () => {
    const sections = [section(4, "note.txt", "managed")];
    const proseOnly = `I saw ${ATTACHMENT_TEXT_ENVELOPE_HEADER}\n{"version":1,"attachments":[]}`;
    expect(parseAttachmentTextEnvelope(proseOnly, expected(sections))).toBeNull();
    // A header inside running prose (no blank-line boundary) is not an envelope.
    const inline = `prefix ${ATTACHMENT_TEXT_ENVELOPE_HEADER}\n${framed(sections).split("\n")[1]}`;
    expect(parseAttachmentTextEnvelope(inline, expected(sections))).toBeNull();
  });

  it("refuses a mismatched id, order, name, size, count or duplicate", () => {
    const sections = [section(5, "one.txt", "one"), section(6, "two.txt", "two")];
    const text = `prose\n\n${framed(sections)}`;
    const base = expected(sections);
    expect(parseAttachmentTextEnvelope(text, base)).not.toBeNull();
    expect(parseAttachmentTextEnvelope(text, [base[1]!, base[0]!])).toBeNull();
    expect(parseAttachmentTextEnvelope(text, [base[0]!])).toBeNull();
    expect(parseAttachmentTextEnvelope(text, [...base, base[0]!])).toBeNull();
    expect(
      parseAttachmentTextEnvelope(text, [{ ...base[0]!, id: opaque(7) }, base[1]!]),
    ).toBeNull();
    expect(
      parseAttachmentTextEnvelope(text, [{ ...base[0]!, name: "other.txt" }, base[1]!]),
    ).toBeNull();
    expect(
      parseAttachmentTextEnvelope(text, [{ ...base[0]!, representationBytes: 999 }, base[1]!]),
    ).toBeNull();
  });

  it("refuses hostile envelope shapes and does not throw", () => {
    const sections = [section(8, "a.txt", "alpha")];
    const good = framed(sections);
    const json = good.slice(good.indexOf("\n") + 1);
    const envelope = JSON.parse(json) as {
      version: number;
      attachments: Array<Record<string, unknown>>;
    };
    const variants = [
      { ...envelope, version: 2 },
      { ...envelope, extra: true },
      { ...envelope, attachments: [] },
      { ...envelope, attachments: [{ ...envelope.attachments[0], extra: 1 }] },
      { ...envelope, attachments: [{ ...envelope.attachments[0], id: "not-an-id" }] },
      {
        ...envelope,
        attachments: [{ ...envelope.attachments[0], representationSha256: "xyz" }],
      },
      { ...envelope, attachments: [{ ...envelope.attachments[0], byteLength: 999 }] },
      { ...envelope, attachments: [{ ...envelope.attachments[0], text: "\ud800" }] },
      { ...envelope, attachments: [{ ...envelope.attachments[0], name: "../escape.txt" }] },
    ];
    for (const variant of variants) {
      const text = `prose\n\n${ATTACHMENT_TEXT_ENVELOPE_HEADER}\n${JSON.stringify(variant)}`;
      expect(parseAttachmentTextEnvelope(text, expected(sections))).toBeNull();
    }
    expect(
      parseAttachmentTextEnvelope(
        `prose\n\n${ATTACHMENT_TEXT_ENVELOPE_HEADER}\n{`,
        expected(sections),
      ),
    ).toBeNull();
    expect(
      parseAttachmentTextEnvelope(
        `${ATTACHMENT_TEXT_ENVELOPE_HEADER}\n${"x".repeat(600 * 1024)}`,
        expected(sections),
      ),
    ).toBeNull();
  });

  it("reports framing failures without producing partial output", () => {
    expect(frameAttachmentTextSections([])).toEqual({ ok: true, framed: expect.any(String) });
    expect(frameAttachmentTextSections([section(9, "a/b.txt", "x")])).toEqual({
      ok: false,
      reason: "invalid_metadata",
    });
    expect(
      frameAttachmentTextSections([section(9, "a.txt", "x"), section(9, "b.txt", "y")]),
    ).toEqual({
      ok: false,
      reason: "invalid_metadata",
    });
    expect(
      frameAttachmentTextSections([
        { ...section(9, "a.txt", "x"), representationSha256: "not-a-digest" },
      ]),
    ).toEqual({ ok: false, reason: "invalid_metadata" });
    expect(frameAttachmentTextSections([section(9, "a.txt", "x".repeat(200 * 1024 + 1))])).toEqual({
      ok: false,
      reason: "too_large",
    });
    const tooMany = Array.from({ length: 11 }, (_, index) =>
      section(20 + index, `f${index}.txt`, "x"),
    );
    expect(frameAttachmentTextSections(tooMany)).toEqual({ ok: false, reason: "too_many_files" });
  });

  it("bounds previews on code-point boundaries and reports the full size", () => {
    expect(attachmentTextPreview("héllo", 3)).toEqual({
      text: "hé",
      truncated: true,
      totalBytes: 6,
    });
    expect(attachmentTextPreview("hello", 64)).toEqual({
      text: "hello",
      truncated: false,
      totalBytes: 5,
    });
    const many = "🙂".repeat(1_000);
    const preview = attachmentTextPreview(many, 1_001);
    expect(preview.truncated).toBe(true);
    expect(preview.totalBytes).toBe(4_000);
    expect(preview.text).toBe("🙂".repeat(250));
    expect(attachmentTextPreview("x", 0).truncated).toBe(true);
  });
});
