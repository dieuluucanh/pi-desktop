import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { classificationForAttachment, classifyAttachment } from "../../src/attachments/classify";
import { ATTACHMENT_LIMITS } from "../../src/shared/attachments";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const classify = (name: string, text: Uint8Array, declaredMime = "application/octet-stream") =>
  classifyAttachment({ name, declaredMime, bytes: text });
const documentMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
function docx(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/document.xml": strToU8("<document/>"),
  });
}
const tinyGif = Uint8Array.from(
  Buffer.from("R0lGODdhAQABAIEAAP8AAAAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==", "base64"),
);

describe("attachment content classification", () => {
  it.each([
    ["a.txt", "plain text"],
    ["readme.md", "# Heading"],
    ["index.ts", "export const x = 1;"],
    ["source.py", "print('hi')"],
    ["data.csv", "a,b\n1,2"],
    ["data.tsv", "a\tb\n1\t2"],
    ["README", "extensionless"],
    [".env", "KEY=value"],
  ])("recognizes %s as strictly decoded direct text", (name, text) => {
    expect(classify(name, bytes(text))).toMatchObject({
      kind: "text",
      format: "text",
      mime: "text/plain",
      text,
      empty: false,
    });
  });

  it("preserves an empty file, BOM, newlines, and inert active markup as text", () => {
    expect(classify("empty.txt", new Uint8Array())).toMatchObject({
      kind: "text",
      text: "",
      empty: true,
    });
    const input = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("a\r\nb")]);
    expect(classify("x.md", input)).toMatchObject({ kind: "text", text: "a\r\nb", utf8Bom: true });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    expect(classify("a.svg", bytes(svg), "image/svg+xml")).toMatchObject({
      kind: "text",
      text: svg,
    });
  });

  it("checks signatures and never treats a renamed image, PDF or archive as text", () => {
    expect(classify("picture.gif", tinyGif, "image/gif")).toMatchObject({
      kind: "image",
      format: "gif",
      width: 1,
      height: 1,
    });
    expect(classify("report.pdf", bytes("%PDF-1.7\nnot validated yet"))).toMatchObject({
      kind: "document",
      format: "pdf",
      needsConversion: true,
    });
    const document = docx();
    expect(classify("report.docx", document, documentMime)).toMatchObject({
      kind: "document",
      format: "docx",
      needsConversion: true,
    });
    for (const data of [tinyGif, bytes("%PDF-1.7\n..."), document]) {
      expect(() => classify("misleading.txt", data, "text/plain")).toThrowError(
        expect.objectContaining({ code: "format_mismatch" }),
      );
    }
    expect(() => classify("picture.png", tinyGif, "image/gif")).toThrowError(
      expect.objectContaining({ code: "format_mismatch" }),
    );
    expect(() => classify("picture.gif", tinyGif, "image/jpeg")).toThrowError(
      expect.objectContaining({ code: "format_mismatch" }),
    );
    expect(() => classify("document.docx", bytes("plain text"))).toThrowError(
      expect.objectContaining({ code: "format_mismatch" }),
    );
  });

  it("rejects NUL, invalid UTF-8, UTF-16, unsupported media and disguised binary", () => {
    for (const bad of [
      new Uint8Array([65, 0, 66]),
      new Uint8Array([0xff, 0xfe, 65, 0]),
      new Uint8Array([0xc3, 0x28]),
    ]) {
      expect(() => classify("a.txt", bad)).toThrow();
    }
    expect(() => classify("a.txt", bytes("ID3fake"))).toThrowError(
      expect.objectContaining({ code: "format_unsupported" }),
    );
    expect(() => classify("a.mp3", bytes("text"))).toThrowError(
      expect.objectContaining({ code: "format_unsupported" }),
    );
    expect(() => classify("a.txt", bytes("text"), "audio/wav")).toThrowError(
      expect.objectContaining({ code: "format_unsupported" }),
    );
    expect(() => classify("old.doc", bytes("text"))).toThrowError(
      expect.objectContaining({ code: "format_unsupported" }),
    );
    expect(() => classify("macro.xlsm", bytes("text"))).toThrowError(
      expect.objectContaining({ code: "format_unsupported" }),
    );
    expect(() => classify("archive", zipSync({ "other.txt": bytes("text") }))).toThrowError(
      expect.objectContaining({ code: "unsupported_container" }),
    );
  });

  it("enforces original/text sizes and reports unrecognized MIME claims as reviewable warnings", () => {
    expect(() =>
      classify("a", new Uint8Array(ATTACHMENT_LIMITS.documentOriginalBytes + 1)),
    ).toThrowError(expect.objectContaining({ code: "original_too_large" }));
    expect(() =>
      classify("a.txt", new Uint8Array(ATTACHMENT_LIMITS.textOriginalBytes + 1).fill(65)),
    ).toThrowError(expect.objectContaining({ code: "too_large" }));
    const value = classify("file.unknown", bytes("hello"), "application/x-unknown");
    expect(value.warnings).toHaveLength(1);
    expect(() => classify("../bad.txt", bytes("hello"))).toThrowError(
      expect.objectContaining({ code: "bad_metadata" }),
    );
  });
});

describe("persistable classification projection", () => {
  it("projects text, image and document classifications with bounded metadata", () => {
    const text = classificationForAttachment({
      name: "notes.txt",
      declaredMime: "text/plain",
      bytes: bytes("hello"),
    });
    expect(text).toMatchObject({
      version: "desktop-classify-v1",
      kind: "text",
      format: "text",
      detectedMime: "text/plain",
      failure: null,
      image: null,
      text: { promptBytes: 5, empty: false },
    });
    const image = classificationForAttachment({
      name: "pixel.gif",
      declaredMime: "image/gif",
      bytes: tinyGif,
    });
    expect(image).toMatchObject({
      kind: "image",
      format: "gif",
      detectedMime: "image/gif",
      text: null,
      failure: null,
    });
    expect(image.image).toMatchObject({ width: 1, height: 1, animated: false });
    const document = classificationForAttachment({
      name: "report.pdf",
      declaredMime: "application/pdf",
      bytes: bytes("%PDF-1.4\n"),
    });
    expect(document).toMatchObject({
      kind: "document",
      format: "pdf",
      detectedMime: "application/pdf",
      text: null,
      image: null,
      failure: null,
    });
  });

  it("records unsupported and mismatched content as data instead of guessing", () => {
    const unsupported = classificationForAttachment({
      name: "audio.mp3",
      declaredMime: "audio/mpeg",
      bytes: Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0]),
    });
    expect(unsupported).toMatchObject({
      kind: "unsupported",
      failure: "format_unsupported",
      format: null,
      detectedMime: null,
      text: null,
      image: null,
    });
    const mismatch = classificationForAttachment({
      name: "report.pdf",
      declaredMime: "application/pdf",
      bytes: bytes("plain text pretending to be a PDF"),
    });
    expect(mismatch.kind).toBe("unsupported");
    expect(mismatch.failure).toBe("format_mismatch");
    const failed = classificationForAttachment({
      name: "../escape.txt",
      declaredMime: "text/plain",
      bytes: bytes("x"),
    });
    expect(failed).toMatchObject({ kind: "failed", failure: "classification_failed" });
  });
});
