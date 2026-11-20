import { inflateRawSync } from "node:zlib";
import { SaxesParser } from "saxes";
import { ATTACHMENT_LIMITS } from "../shared/attachments";
import { crc32 } from "./crc32";

export type DocumentContainerFormat = "docx" | "xlsx" | "pptx" | "odt" | "ods" | "odp";
export type DocumentContainerErrorCode =
  "invalid_container" | "unsupported_container" | "encrypted_container" | "container_limit";

export class DocumentContainerError extends Error {
  readonly code: DocumentContainerErrorCode;
  constructor(code: DocumentContainerErrorCode, message: string) {
    super(message);
    this.name = "DocumentContainerError";
    this.code = code;
  }
}

export interface DocumentContainerIdentity {
  readonly format: DocumentContainerFormat;
  readonly mime: string;
}

interface Entry {
  readonly name: string;
  readonly method: number;
  readonly compressed: number;
  readonly expanded: number;
  readonly checksum: number;
  readonly localOffset: number;
  readonly dataOffset: number;
  readonly end: number;
  readonly extraLength: number;
  readonly flags: number;
}

const IDENTITY_XML_LIMIT = 256 * 1024;
const XML_CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types";
const XML_RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships";
const ODF_MANIFEST = "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0";
const OFFICE_RELATIONSHIP =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const ODF = {
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.presentation": "odp",
} as const;
const OOXML = {
  "word/document.xml": {
    format: "docx",
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  "xl/workbook.xml": {
    format: "xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  "ppt/presentation.xml": {
    format: "pptx",
    contentType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
} as const;

function fail(code: DocumentContainerErrorCode, message: string): never {
  throw new DocumentContainerError(code, message);
}
function invalid(): never {
  return fail("invalid_container", "invalid document container");
}
function limited(): never {
  return fail("container_limit", "document container exceeds safety limits");
}
function u16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length) invalid();
  return (bytes[offset] ?? 0) + (bytes[offset + 1] ?? 0) * 256;
}
function u32(bytes: Uint8Array, offset: number): number {
  return u16(bytes, offset) + u16(bytes, offset + 2) * 65536;
}
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}
function nameOf(raw: Uint8Array, flags: number): string {
  if (!raw.length || raw.length > 1024 || (!(flags & 0x800) && raw.some((value) => value >= 128)))
    invalid();
  let name: string;
  try {
    name = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return invalid();
  }
  const components = name.endsWith("/") ? name.slice(0, -1).split("/") : name.split("/");
  if (
    name.startsWith("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    components.some((part) => !part || part === "." || part === "..") ||
    components[0]?.includes(":")
  )
    invalid();
  return name;
}
function checkExtra(bytes: Uint8Array, start: number, length: number): void {
  const end = start + length;
  if (end > bytes.length) invalid();
  let offset = start;
  while (offset < end) {
    if (offset + 4 > end) invalid();
    const id = u16(bytes, offset);
    const size = u16(bytes, offset + 2);
    offset += 4;
    if (offset + size > end) invalid();
    if (id === 1) fail("unsupported_container", "ZIP64 containers are not supported");
    offset += size;
  }
}

/** ZIP signature is just a candidate; it never authorizes decompression or delivery. */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 3 && bytes[3] === 4) ||
      (bytes[2] === 5 && bytes[3] === 6) ||
      (bytes[2] === 7 && bytes[3] === 8))
  );
}

function readEntries(bytes: Uint8Array): readonly Entry[] {
  if (bytes.length > ATTACHMENT_LIMITS.documentOriginalBytes) limited();
  let eocd = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index--) {
    if (u32(bytes, index) === 0x06054b50 && index + 22 + u16(bytes, index + 20) === bytes.length) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) invalid();
  const count = u16(bytes, eocd + 10);
  const directorySize = u32(bytes, eocd + 12);
  const directoryOffset = u32(bytes, eocd + 16);
  if (
    u16(bytes, eocd + 4) ||
    u16(bytes, eocd + 6) ||
    u16(bytes, eocd + 8) !== count ||
    count === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  ) {
    fail("unsupported_container", "multi-disk or ZIP64 containers are not supported");
  }
  if (count === 0) fail("unsupported_container", "archive is not a supported document");
  if (count > ATTACHMENT_LIMITS.archiveEntries) limited();
  if (directoryOffset + directorySize !== eocd) invalid();
  const entries: Entry[] = [];
  const names = new Set<string>();
  let offset = directoryOffset;
  let totalExpanded = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > eocd || u32(bytes, offset) !== 0x02014b50) invalid();
    const flags = u16(bytes, offset + 8);
    const method = u16(bytes, offset + 10);
    const checksum = u32(bytes, offset + 16);
    const compressed = u32(bytes, offset + 20);
    const expanded = u32(bytes, offset + 24);
    const nameLength = u16(bytes, offset + 28);
    const extraLength = u16(bytes, offset + 30);
    const commentLength = u16(bytes, offset + 32);
    const localOffset = u32(bytes, offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (
      end > eocd ||
      u16(bytes, offset + 34) !== 0 ||
      [compressed, expanded, localOffset].includes(0xffffffff)
    )
      invalid();
    if (flags & 0x41) fail("encrypted_container", "encrypted documents are not supported");
    if (method !== 0 && method !== 8)
      fail("unsupported_container", "unsupported archive compression");
    const versionMadeBy = u16(bytes, offset + 4);
    const attributes = u32(bytes, offset + 38);
    if (versionMadeBy >>> 8 === 3 && ((attributes >>> 16) & 0o170000) === 0o120000) invalid();
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = nameOf(rawName, flags);
    if (names.has(name.toLowerCase())) invalid();
    names.add(name.toLowerCase());
    checkExtra(bytes, offset + 46 + nameLength, extraLength);
    totalExpanded += expanded;
    if (
      totalExpanded > ATTACHMENT_LIMITS.archiveExpandedBytes ||
      expanded > Math.max(1, compressed) * ATTACHMENT_LIMITS.archiveExpansionRatio
    )
      limited();
    if (method === 0 && compressed !== expanded) invalid();
    if (localOffset + 30 > directoryOffset || u32(bytes, localOffset) !== 0x04034b50) invalid();
    const localFlags = u16(bytes, localOffset + 6);
    const localMethod = u16(bytes, localOffset + 8);
    const localNameLength = u16(bytes, localOffset + 26);
    const localExtraLength = u16(bytes, localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (
      dataOffset > directoryOffset ||
      localFlags !== flags ||
      localMethod !== method ||
      !sameBytes(rawName, bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength))
    )
      invalid();
    checkExtra(bytes, localOffset + 30 + localNameLength, localExtraLength);
    let localEnd = dataOffset + compressed;
    if (localEnd > directoryOffset) invalid();
    if (flags & 8) {
      if (localEnd + 12 > directoryOffset) invalid();
      if (u32(bytes, localEnd) === 0x08074b50) localEnd += 4;
      if (
        localEnd + 12 > directoryOffset ||
        u32(bytes, localEnd) !== checksum ||
        u32(bytes, localEnd + 4) !== compressed ||
        u32(bytes, localEnd + 8) !== expanded
      )
        invalid();
      localEnd += 12;
    } else if (
      u32(bytes, localOffset + 14) !== checksum ||
      u32(bytes, localOffset + 18) !== compressed ||
      u32(bytes, localOffset + 22) !== expanded
    )
      invalid();
    entries.push({
      name,
      method,
      compressed,
      expanded,
      checksum,
      localOffset,
      dataOffset,
      end: localEnd,
      extraLength: localExtraLength,
      flags,
    });
    offset = end;
  }
  if (offset !== eocd) invalid();
  const sorted = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  if (sorted[0]?.localOffset !== 0) invalid();
  for (let index = 1; index < sorted.length; index++) {
    if ((sorted[index - 1]?.end ?? Infinity) > (sorted[index]?.localOffset ?? 0)) invalid();
  }
  return entries;
}

function readIdentity(bytes: Uint8Array, entry: Entry): Uint8Array {
  if (entry.expanded > IDENTITY_XML_LIMIT) limited();
  const compressed = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressed);
  let output: Uint8Array;
  try {
    output =
      entry.method === 0
        ? compressed
        : inflateRawSync(compressed, { maxOutputLength: IDENTITY_XML_LIMIT });
  } catch {
    return invalid();
  }
  if (output.length !== entry.expanded || crc32(output) !== entry.checksum) invalid();
  return output;
}

function xmlText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalid();
  }
}

function parseXml(
  text: string,
  callback: (name: string, uri: string, attributes: Record<string, string>, depth: number) => void,
): void {
  const parser = new SaxesParser({ xmlns: true });
  let depth = 0;
  let nodes = 0;
  parser.on("doctype", () => invalid());
  parser.on("xmldecl", (decl) => {
    if (decl.encoding && decl.encoding.toLowerCase() !== "utf-8") invalid();
  });
  parser.on("error", () => invalid());
  parser.on("opentag", (tag) => {
    if (++depth > 32 || ++nodes > 20_000) limited();
    const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const attribute of Object.values(tag.attributes)) {
      const key = attribute.uri ? `{${attribute.uri}}${attribute.local}` : attribute.local;
      attrs[key] = attribute.value;
    }
    callback(tag.local, tag.uri, attrs, depth);
  });
  parser.on("closetag", () => {
    depth--;
  });
  try {
    parser.write(text).close();
  } catch (error) {
    if (error instanceof DocumentContainerError) throw error;
    invalid();
  }
}

/**
 * Identify six document package families using bounded ZIP structure and ODF/OPC
 * metadata. This is not a security scan or extraction approval: the later worker
 * must independently revalidate the complete archive/XML before accessing content.
 */
export function identifyDocumentContainer(bytes: Uint8Array): DocumentContainerIdentity {
  const entries = readEntries(bytes);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  if (entries.some((entry) => /(?:^|\/)vbaProject\.(?:bin|xml)$/i.test(entry.name))) {
    fail("unsupported_container", "macro-enabled documents are not supported");
  }
  const mimetype = byName.get("mimetype");
  if (mimetype) {
    if (entries.some((entry) => /^(?:Basic|Scripts)\//i.test(entry.name))) {
      fail("unsupported_container", "documents containing scripts are not supported");
    }
    if (
      mimetype.localOffset !== 0 ||
      mimetype.method !== 0 ||
      mimetype.extraLength !== 0 ||
      mimetype.flags & 8
    )
      invalid();
    const mime = xmlText(readIdentity(bytes, mimetype));
    const format = ODF[mime as keyof typeof ODF];
    const manifest = byName.get("META-INF/manifest.xml");
    if (!format || !byName.has("content.xml") || !manifest || byName.has("[Content_Types].xml")) {
      fail("unsupported_container", "archive is not a supported OpenDocument file");
    }
    let manifestRoot = false;
    let rootEntries = 0;
    parseXml(xmlText(readIdentity(bytes, manifest)), (name, uri, attrs, depth) => {
      if (depth === 1) {
        manifestRoot = name === "manifest" && uri === ODF_MANIFEST;
        return;
      }
      if (
        depth !== 2 ||
        name !== "file-entry" ||
        uri !== ODF_MANIFEST ||
        attrs[`{${ODF_MANIFEST}}full-path`] !== "/"
      )
        return;
      if (attrs[`{${ODF_MANIFEST}}media-type`] !== mime) invalid();
      rootEntries++;
    });
    if (!manifestRoot || rootEntries !== 1) invalid();
    return { format, mime };
  }
  const types = byName.get("[Content_Types].xml");
  const relationships = byName.get("_rels/.rels");
  if (!types || !relationships)
    fail("unsupported_container", "archive is not a supported document");
  const candidates = new Set<string>();
  const overrides = new Set<string>();
  let typesRoot = false;
  parseXml(xmlText(readIdentity(bytes, types)), (name, uri, attrs, depth) => {
    if (depth === 1) {
      typesRoot = name === "Types" && uri === XML_CONTENT_TYPES;
      return;
    }
    if (depth !== 2 || uri !== XML_CONTENT_TYPES) return;
    const contentType = attrs.ContentType ?? "";
    if (/macroenabled|vbaproject/i.test(contentType))
      fail("unsupported_container", "macro-enabled documents are not supported");
    if (name !== "Override") return;
    const part = (attrs.PartName ?? "").replace(/^\//, "");
    if (!part || overrides.has(part.toLowerCase())) invalid();
    overrides.add(part.toLowerCase());
    const expected = OOXML[part as keyof typeof OOXML];
    if (expected && contentType === expected.contentType) candidates.add(part);
  });
  if (!typesRoot || candidates.size !== 1)
    fail("unsupported_container", "unrecognized document package identity");
  const part = [...candidates][0];
  if (!part || !byName.has(part)) invalid();
  let relationshipRoot = false;
  let targetCount = 0;
  parseXml(xmlText(readIdentity(bytes, relationships)), (name, uri, attrs, depth) => {
    if (depth === 1) {
      relationshipRoot = name === "Relationships" && uri === XML_RELATIONSHIPS;
      return;
    }
    if (
      depth !== 2 ||
      name !== "Relationship" ||
      uri !== XML_RELATIONSHIPS ||
      attrs.Type !== OFFICE_RELATIONSHIP
    )
      return;
    if (attrs.TargetMode && attrs.TargetMode !== "Internal") invalid();
    if ((attrs.Target ?? "").replace(/^\//, "") !== part) invalid();
    targetCount++;
  });
  if (!relationshipRoot || targetCount !== 1) invalid();
  const identity = OOXML[part as keyof typeof OOXML];
  if (!identity) invalid();
  return { format: identity.format, mime: identity.mime };
}
