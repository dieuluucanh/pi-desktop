import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { identifyDocumentContainer, looksLikeZip } from "../../src/attachments/document-container";

const contentTypes = "http://schemas.openxmlformats.org/package/2006/content-types";
const relationships = "http://schemas.openxmlformats.org/package/2006/relationships";
const officeRelation =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const formats = [
  [
    "docx",
    "word/document.xml",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  [
    "xlsx",
    "xl/workbook.xml",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  [
    "pptx",
    "ppt/presentation.xml",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
] as const;

function ooxml(
  part: string,
  contentType: string,
  options: { relationship?: string; types?: string; extraName?: string } = {},
): Uint8Array {
  const types =
    options.types ??
    `<Types xmlns="${contentTypes}"><Override PartName="/${part}" ContentType="${contentType}"/></Types>`;
  const rels =
    options.relationship ??
    `<Relationships xmlns="${relationships}"><Relationship Id="r1" Type="${officeRelation}" Target="${part}"/></Relationships>`;
  return zipSync({
    "[Content_Types].xml": strToU8(types),
    "_rels/.rels": strToU8(rels),
    [part]: strToU8("<x/>"),
    ...(options.extraName ? { [options.extraName]: strToU8("data") } : {}),
  });
}

function odf(mime: string): Uint8Array {
  return zipSync({
    mimetype: [strToU8(mime), { level: 0 }],
    "content.xml": strToU8("<x/>"),
    "META-INF/manifest.xml": strToU8(
      `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mime}"/></manifest:manifest>`,
    ),
  });
}

function findSignature(bytes: Uint8Array, signature: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i + 4 <= bytes.length; i++) if (view.getUint32(i, true) === signature) return i;
  throw new Error("signature not found");
}

describe("document package identity", () => {
  it.each(formats)(
    "identifies %s by OPC content types, root relationship and main part",
    (format, part, contentType, mime) => {
      const data = ooxml(part, contentType);
      expect(looksLikeZip(data)).toBe(true);
      expect(identifyDocumentContainer(data)).toEqual({ format, mime });
    },
  );

  it.each([
    ["odt", "application/vnd.oasis.opendocument.text"],
    ["ods", "application/vnd.oasis.opendocument.spreadsheet"],
    ["odp", "application/vnd.oasis.opendocument.presentation"],
  ])("identifies %s using its first uncompressed ODF marker", (format, mime) => {
    expect(identifyDocumentContainer(odf(mime))).toEqual({ format, mime });
  });

  it("rejects generic ZIPs and package-looking names without valid identity metadata", () => {
    expect(() =>
      identifyDocumentContainer(zipSync({ "word/document.xml": strToU8("hi") })),
    ).toThrowError(expect.objectContaining({ code: "unsupported_container" }));
    const [, part, contentType] = formats[0];
    const wrongTarget = `<Relationships xmlns="${relationships}"><Relationship Type="${officeRelation}" Target="../outside"/></Relationships>`;
    expect(() =>
      identifyDocumentContainer(ooxml(part, contentType, { relationship: wrongTarget })),
    ).toThrowError(expect.objectContaining({ code: "invalid_container" }));
    const fakeComment = `<Types xmlns="${contentTypes}"><!-- <Override PartName="/${part}" ContentType="${contentType}"/> --></Types>`;
    expect(() =>
      identifyDocumentContainer(ooxml(part, contentType, { types: fakeComment })),
    ).toThrowError(expect.objectContaining({ code: "unsupported_container" }));
  });

  it("requires a matching ODF manifest and refuses embedded script directories", () => {
    const mime = "application/vnd.oasis.opendocument.text";
    const spoof = zipSync({
      mimetype: [strToU8(mime), { level: 0 }],
      "content.xml": strToU8("<x/>"),
      "META-INF/manifest.xml": strToU8("<x/>"),
    });
    expect(() => identifyDocumentContainer(spoof)).toThrowError(
      expect.objectContaining({ code: "invalid_container" }),
    );
    const scripted = zipSync({
      mimetype: [strToU8(mime), { level: 0 }],
      "content.xml": strToU8("<x/>"),
      "META-INF/manifest.xml": strToU8("<x/>"),
      "Basic/Standard/code.xml": strToU8("<x/>"),
    });
    expect(() => identifyDocumentContainer(scripted)).toThrowError(
      expect.objectContaining({ code: "unsupported_container" }),
    );
  });

  it("rejects macros, DTDs, external package roots and compressed ODF markers", () => {
    const [, part, contentType] = formats[0];
    expect(() =>
      identifyDocumentContainer(ooxml(part, contentType, { extraName: "word/vbaProject.bin" })),
    ).toThrowError(expect.objectContaining({ code: "unsupported_container" }));
    const doctype = `<!DOCTYPE Types [<!ENTITY x SYSTEM "file:///secret">]><Types xmlns="${contentTypes}"><Override PartName="/${part}" ContentType="${contentType}"/></Types>`;
    expect(() =>
      identifyDocumentContainer(ooxml(part, contentType, { types: doctype })),
    ).toThrowError(expect.objectContaining({ code: "invalid_container" }));
    const external = `<Relationships xmlns="${relationships}"><Relationship Type="${officeRelation}" Target="${part}" TargetMode="External"/></Relationships>`;
    expect(() =>
      identifyDocumentContainer(ooxml(part, contentType, { relationship: external })),
    ).toThrowError(expect.objectContaining({ code: "invalid_container" }));
    const badOdf = zipSync({
      mimetype: strToU8("application/vnd.oasis.opendocument.text"),
      "content.xml": strToU8("<x/>"),
      "META-INF/manifest.xml": strToU8("<x/>"),
    });
    expect(() => identifyDocumentContainer(badOdf)).toThrow();
  });

  it("rejects malformed ZIP boundaries, encryption, expansion bombs, path traversal and corrupt metadata", () => {
    const [, part, contentType] = formats[0];
    const original = ooxml(part, contentType);
    expect(() => identifyDocumentContainer(original.subarray(0, original.length - 1))).toThrow();
    const encrypted = Uint8Array.from(original);
    const central = findSignature(encrypted, 0x02014b50);
    encrypted[central + 8] = (encrypted[central + 8] ?? 0) | 1;
    expect(() => identifyDocumentContainer(encrypted)).toThrowError(
      expect.objectContaining({ code: "encrypted_container" }),
    );
    const bomb = Uint8Array.from(original);
    const view = new DataView(bomb.buffer);
    view.setUint32(findSignature(bomb, 0x02014b50) + 24, 101 * 1024 * 1024, true);
    expect(() => identifyDocumentContainer(bomb)).toThrowError(
      expect.objectContaining({ code: "container_limit" }),
    );
    const traversal = zipSync({ "../bad": strToU8("x"), "content.xml": strToU8("<x/>") });
    expect(() => identifyDocumentContainer(traversal)).toThrowError(
      expect.objectContaining({ code: "invalid_container" }),
    );
    const corrupt = Uint8Array.from(original);
    corrupt[35] = (corrupt[35] ?? 0) ^ 1;
    expect(() => identifyDocumentContainer(corrupt)).toThrow();
  });
});
