/**
 * Versioned document-extraction contracts (plan step 17, milestone B).
 *
 * This module is browser-safe and contains no parser, filesystem, SDK or
 * Electron code. It is the agreement between the main planner, the dedicated
 * extraction worker (step 18), the immutable proposal/approval store (step 19)
 * and the renderer review UI: a request names a selector and an explicit
 * per-file consent; a proposal reports exact chunks, coverage and omissions;
 * nothing here silently truncates or infers document content.
 *
 * Formats are opt-in only. A binary document is never a native SDK block, and
 * extracted text is not sendable until the user approves this exact proposal.
 */

import {
  ATTACHMENT_LIMITS,
  isAttachmentId,
  isWellFormedAttachmentText,
  type AttachmentId,
} from "./attachments";

export const EXTRACTION_CONTRACT_VERSION = 1 as const;
export const EXTRACTION_FORMATS = ["pdf", "docx", "odt", "xlsx", "ods", "pptx", "odp"] as const;
export type ExtractionFormat = (typeof EXTRACTION_FORMATS)[number];

export type ExtractionFailureCode =
  | "invalid_container"
  | "encrypted_document"
  | "unsupported_format"
  | "unsupported_feature"
  | "malformed_document"
  | "macro_enabled"
  | "password_required"
  | "limit_exceeded"
  | "output_too_large"
  | "timeout"
  | "cancelled"
  | "parser_unavailable"
  | "network_rejected"
  | "internal_error";

export type ExtractionWarningCode =
  | "scanned_page_no_text"
  | "image_only_page"
  | "hidden_content_omitted"
  | "notes_omitted"
  | "comments_omitted"
  | "macros_ignored"
  | "formula_cache_missing"
  | "formula_text_included"
  | "merged_cells_approximated"
  | "table_structure_approximated"
  | "rtl_approximated"
  | "unsupported_embedded_object"
  | "font_substitution"
  | "annotation_omitted"
  | "external_relationship_ignored";

const FAILURE_CODES: readonly ExtractionFailureCode[] = [
  "invalid_container",
  "encrypted_document",
  "unsupported_format",
  "unsupported_feature",
  "malformed_document",
  "macro_enabled",
  "password_required",
  "limit_exceeded",
  "output_too_large",
  "timeout",
  "cancelled",
  "parser_unavailable",
  "network_rejected",
  "internal_error",
];
const WARNING_CODES: readonly ExtractionWarningCode[] = [
  "scanned_page_no_text",
  "image_only_page",
  "hidden_content_omitted",
  "notes_omitted",
  "comments_omitted",
  "macros_ignored",
  "formula_cache_missing",
  "formula_text_included",
  "merged_cells_approximated",
  "table_structure_approximated",
  "rtl_approximated",
  "unsupported_embedded_object",
  "font_substitution",
  "annotation_omitted",
  "external_relationship_ignored",
];

/**
 * Enforceable worker ceilings. `heapBytes` is a V8 heap limit; `rssBytes` is the
 * whole process ceiling and is checked by the supervisor. They are separate
 * controls — a heap flag is not an RSS cap. `globalJobs` is app-wide, not
 * per-window.
 */
export const EXTRACTION_BUDGETS = {
  globalJobs: 2,
  wallMs: 30_000,
  heapBytes: 256 * 1024 * 1024,
  rssBytes: 768 * 1024 * 1024,
  outputBytes: ATTACHMENT_LIMITS.extractionOutputBytes,
  tempBytes: 512 * 1024 * 1024,
  archiveEntries: ATTACHMENT_LIMITS.archiveEntries,
  archiveExpandedBytes: ATTACHMENT_LIMITS.archiveExpandedBytes,
  archiveExpansionRatio: ATTACHMENT_LIMITS.archiveExpansionRatio,
  pdfPages: ATTACHMENT_LIMITS.pdfPages,
  spreadsheetCells: ATTACHMENT_LIMITS.spreadsheetCells,
  chunkBytes: 256 * 1024,
  maxChunks: 8_192,
} as const;

/* --------------------------------------------------------------- selections */

export interface PdfPageRange {
  /** 1-based, inclusive. */
  readonly start: number;
  /** 1-based, inclusive. */
  readonly end: number;
}

export interface PdfSelection {
  readonly version: 1;
  readonly kind: "pdf";
  readonly pages:
    { readonly mode: "all" } | { readonly mode: "range"; readonly ranges: readonly PdfPageRange[] };
}

export interface WordSelection {
  readonly version: 1;
  readonly kind: "word";
  readonly includeTables: boolean;
  readonly includeHeadersFooters: boolean;
  readonly includeComments: boolean;
  readonly includeHiddenText: boolean;
}

export interface SpreadsheetSelection {
  readonly version: 1;
  readonly kind: "spreadsheet";
  readonly sheets:
    | { readonly mode: "all" }
    | { readonly mode: "visible" }
    | { readonly mode: "selected"; readonly ids: readonly string[] };
  readonly range: { readonly sheetId: string; readonly start: string; readonly end: string } | null;
  readonly formula: "cached" | "text" | "omit";
  readonly includeHiddenSheets: boolean;
  readonly maxCells: number;
}

export interface PresentationSelection {
  readonly version: 1;
  readonly kind: "presentation";
  readonly slides:
    { readonly mode: "all" } | { readonly mode: "selected"; readonly ids: readonly string[] };
  readonly includeNotes: boolean;
  readonly includeHiddenSlides: boolean;
}

export type ExtractionSelection =
  PdfSelection | WordSelection | SpreadsheetSelection | PresentationSelection;

/* ------------------------------------------------------------------ request */

export interface ExtractionRequest {
  readonly version: typeof EXTRACTION_CONTRACT_VERSION;
  readonly jobId: AttachmentId;
  readonly originalId: AttachmentId;
  readonly originalSha256: string;
  readonly format: ExtractionFormat;
  readonly selection: ExtractionSelection;
  /** The worker must fail `output_too_large` instead of truncating. */
  readonly maxOutputBytes: number;
  /** The exact user opt-in that authorized parsing this original. */
  readonly consent: ConversionConsent;
}

/**
 * Consent to parse a document's contents (inventory or extraction). It binds
 * the original digest and the exact selector/options, so reusing an approval
 * for different content or a broader selection is invalid.
 */
export interface ConversionConsent {
  readonly version: 1;
  readonly originalId: AttachmentId;
  readonly originalSha256: string;
  readonly selectionDigest: string;
  readonly policyDigest: string;
  readonly approvedAt: number;
}

/* ---------------------------------------------------------------- inventory */

export interface ExtractionInventory {
  readonly version: typeof EXTRACTION_CONTRACT_VERSION;
  readonly format: ExtractionFormat;
  readonly originalSha256: string;
  /** What the parser can see before any content is extracted. */
  readonly units: {
    readonly total: number;
    readonly selected: number;
    readonly hidden: number;
  };
  readonly hasNotes: boolean;
  readonly hasComments: boolean;
  readonly hasMacros: boolean;
  readonly warnings: readonly ExtractionWarningCode[];
  /** Digest of the exact inventory projection, for explicit inventory consent. */
  readonly digest: string;
}

/* ----------------------------------------------------------------- proposal */

export interface ExtractionChunk {
  readonly index: number;
  readonly text: string;
  readonly byteLength: number;
}

export interface ExtractionCoverage {
  readonly kind: "complete" | "partial";
  readonly selectedUnits: number;
  readonly totalUnits: number;
  readonly omitted: readonly { readonly code: ExtractionWarningCode; readonly count: number }[];
}

export interface ExtractionProvenance {
  readonly converter: { readonly name: string; readonly version: string };
  readonly contractVersion: typeof EXTRACTION_CONTRACT_VERSION;
  readonly sourceSha256: string;
  readonly selectionDigest: string;
  readonly outputSha256: string;
  readonly createdAt: number;
}

/**
 * The immutable proposed text. The output digest covers the concatenated
 * chunks and selection; an approval binds this exact proposal.
 */
export interface ExtractionProposal {
  readonly version: typeof EXTRACTION_CONTRACT_VERSION;
  readonly format: ExtractionFormat;
  readonly originalSha256: string;
  readonly selectionDigest: string;
  readonly chunks: readonly ExtractionChunk[];
  readonly coverage: ExtractionCoverage;
  readonly warnings: readonly ExtractionWarningCode[];
  readonly provenance: ExtractionProvenance;
  readonly outputBytes: number;
}

/** The worker surface; step 18 implements it over bounded IPC. */
export interface ExtractorPort {
  inventory(request: ExtractionRequest): Promise<ExtractionInventory>;
  extract(request: ExtractionRequest): Promise<ExtractionProposal>;
  cancel(jobId: string): Promise<void>;
}

/* ---------------------------------------------------------------- validation */

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function label(value: unknown, max = 255): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
  );
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validFormat(value: unknown): value is ExtractionFormat {
  return typeof value === "string" && (EXTRACTION_FORMATS as readonly string[]).includes(value);
}

function selectionKindFor(format: ExtractionFormat): ExtractionSelection["kind"] {
  if (format === "pdf") return "pdf";
  if (format === "docx" || format === "odt") return "word";
  if (format === "xlsx" || format === "ods") return "spreadsheet";
  return "presentation";
}

function validCell(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(value);
}

export function validateExtractionSelection(value: unknown): ExtractionSelection | null {
  const selection = record(value);
  if (!selection || selection.version !== 1) return null;
  if (selection.kind === "pdf") {
    if (!exactKeys(selection, ["version", "kind", "pages"])) return null;
    const pages = record(selection.pages);
    if (!pages) return null;
    if (pages.mode === "all") {
      if (!exactKeys(pages, ["mode"])) return null;
      return { version: 1, kind: "pdf", pages: { mode: "all" } };
    }
    if (pages.mode !== "range" || !exactKeys(pages, ["mode", "ranges"])) return null;
    if (!Array.isArray(pages.ranges) || pages.ranges.length === 0 || pages.ranges.length > 50) {
      return null;
    }
    let total = 0;
    const ranges: PdfPageRange[] = [];
    let previousEnd = 0;
    for (const item of pages.ranges) {
      const range = record(item);
      if (
        !range ||
        !exactKeys(range, ["start", "end"]) ||
        !count(range.start) ||
        !count(range.end) ||
        range.start < 1 ||
        range.end < range.start ||
        range.end > 10_000 ||
        range.start <= previousEnd
      ) {
        return null;
      }
      total += range.end - range.start + 1;
      if (total > EXTRACTION_BUDGETS.pdfPages) return null;
      previousEnd = range.end;
      ranges.push({ start: range.start, end: range.end });
    }
    return { version: 1, kind: "pdf", pages: { mode: "range", ranges } };
  }
  if (selection.kind === "word") {
    if (
      !exactKeys(selection, [
        "version",
        "kind",
        "includeTables",
        "includeHeadersFooters",
        "includeComments",
        "includeHiddenText",
      ]) ||
      typeof selection.includeTables !== "boolean" ||
      typeof selection.includeHeadersFooters !== "boolean" ||
      typeof selection.includeComments !== "boolean" ||
      typeof selection.includeHiddenText !== "boolean"
    ) {
      return null;
    }
    return {
      version: 1,
      kind: "word",
      includeTables: selection.includeTables,
      includeHeadersFooters: selection.includeHeadersFooters,
      includeComments: selection.includeComments,
      includeHiddenText: selection.includeHiddenText,
    };
  }
  if (selection.kind === "spreadsheet") {
    if (
      !exactKeys(selection, [
        "version",
        "kind",
        "sheets",
        "range",
        "formula",
        "includeHiddenSheets",
        "maxCells",
      ])
    ) {
      return null;
    }
    const sheets = record(selection.sheets);
    if (
      !sheets ||
      (sheets.mode !== "all" && sheets.mode !== "visible" && sheets.mode !== "selected")
    ) {
      return null;
    }
    if (sheets.mode === "selected") {
      if (!exactKeys(sheets, ["mode", "ids"])) return null;
      if (
        !Array.isArray(sheets.ids) ||
        sheets.ids.length === 0 ||
        sheets.ids.length > 100 ||
        sheets.ids.some((id) => !label(id, 128)) ||
        new Set(sheets.ids).size !== sheets.ids.length
      ) {
        return null;
      }
    } else if (!exactKeys(sheets, ["mode"])) {
      return null;
    }
    const range = selection.range === null ? null : record(selection.range);
    if (selection.range !== null) {
      if (
        !range ||
        !exactKeys(range, ["sheetId", "start", "end"]) ||
        !label(range.sheetId, 128) ||
        !validCell(range.start) ||
        !validCell(range.end)
      ) {
        return null;
      }
    }
    if (
      (selection.formula !== "cached" &&
        selection.formula !== "text" &&
        selection.formula !== "omit") ||
      typeof selection.includeHiddenSheets !== "boolean" ||
      !count(selection.maxCells) ||
      selection.maxCells === 0 ||
      selection.maxCells > EXTRACTION_BUDGETS.spreadsheetCells
    ) {
      return null;
    }
    return {
      version: 1,
      kind: "spreadsheet",
      sheets:
        sheets.mode === "selected"
          ? { mode: "selected", ids: sheets.ids as string[] }
          : { mode: sheets.mode },
      range: range
        ? {
            sheetId: range.sheetId as string,
            start: range.start as string,
            end: range.end as string,
          }
        : null,
      formula: selection.formula,
      includeHiddenSheets: selection.includeHiddenSheets,
      maxCells: selection.maxCells,
    };
  }
  if (selection.kind === "presentation") {
    if (
      !exactKeys(selection, ["version", "kind", "slides", "includeNotes", "includeHiddenSlides"])
    ) {
      return null;
    }
    const slides = record(selection.slides);
    if (!slides || (slides.mode !== "all" && slides.mode !== "selected")) return null;
    if (slides.mode === "selected") {
      if (!exactKeys(slides, ["mode", "ids"])) return null;
      if (
        !Array.isArray(slides.ids) ||
        slides.ids.length === 0 ||
        slides.ids.length > 500 ||
        slides.ids.some((id) => !label(id, 128)) ||
        new Set(slides.ids).size !== slides.ids.length
      ) {
        return null;
      }
    } else if (!exactKeys(slides, ["mode"])) {
      return null;
    }
    if (
      typeof selection.includeNotes !== "boolean" ||
      typeof selection.includeHiddenSlides !== "boolean"
    ) {
      return null;
    }
    return {
      version: 1,
      kind: "presentation",
      slides:
        slides.mode === "selected"
          ? { mode: "selected", ids: slides.ids as string[] }
          : { mode: "all" },
      includeNotes: selection.includeNotes,
      includeHiddenSlides: selection.includeHiddenSlides,
    };
  }
  return null;
}

export function validateConversionConsent(value: unknown): ConversionConsent | null {
  const consent = record(value);
  if (
    !consent ||
    !exactKeys(consent, [
      "version",
      "originalId",
      "originalSha256",
      "selectionDigest",
      "policyDigest",
      "approvedAt",
    ]) ||
    consent.version !== 1 ||
    !isAttachmentId(consent.originalId) ||
    !digest(consent.originalSha256) ||
    !digest(consent.selectionDigest) ||
    !digest(consent.policyDigest) ||
    !count(consent.approvedAt)
  ) {
    return null;
  }
  return {
    version: 1,
    originalId: consent.originalId,
    originalSha256: consent.originalSha256,
    selectionDigest: consent.selectionDigest,
    policyDigest: consent.policyDigest,
    approvedAt: consent.approvedAt,
  };
}

export function validateExtractionRequest(value: unknown): ExtractionRequest | null {
  const request = record(value);
  if (
    !request ||
    !exactKeys(request, [
      "version",
      "jobId",
      "originalId",
      "originalSha256",
      "format",
      "selection",
      "maxOutputBytes",
      "consent",
    ]) ||
    request.version !== EXTRACTION_CONTRACT_VERSION ||
    !isAttachmentId(request.jobId) ||
    !isAttachmentId(request.originalId) ||
    !digest(request.originalSha256) ||
    !validFormat(request.format) ||
    !count(request.maxOutputBytes) ||
    request.maxOutputBytes === 0 ||
    request.maxOutputBytes > EXTRACTION_BUDGETS.outputBytes
  ) {
    return null;
  }
  const selection = validateExtractionSelection(request.selection);
  const consent = validateConversionConsent(request.consent);
  if (
    !selection ||
    selection.kind !== selectionKindFor(request.format) ||
    !consent ||
    consent.originalId !== request.originalId ||
    consent.originalSha256 !== request.originalSha256
  ) {
    return null;
  }
  return {
    version: 1,
    jobId: request.jobId,
    originalId: request.originalId,
    originalSha256: request.originalSha256,
    format: request.format,
    selection,
    maxOutputBytes: request.maxOutputBytes,
    consent,
  };
}

export function validateExtractionInventory(value: unknown): ExtractionInventory | null {
  const inventory = record(value);
  if (
    !inventory ||
    !exactKeys(inventory, [
      "version",
      "format",
      "originalSha256",
      "units",
      "hasNotes",
      "hasComments",
      "hasMacros",
      "warnings",
      "digest",
    ]) ||
    inventory.version !== EXTRACTION_CONTRACT_VERSION ||
    !validFormat(inventory.format) ||
    !digest(inventory.originalSha256) ||
    !digest(inventory.digest) ||
    typeof inventory.hasNotes !== "boolean" ||
    typeof inventory.hasComments !== "boolean" ||
    typeof inventory.hasMacros !== "boolean" ||
    !Array.isArray(inventory.warnings) ||
    inventory.warnings.length > 32 ||
    inventory.warnings.some((code) => !WARNING_CODES.includes(code as ExtractionWarningCode))
  ) {
    return null;
  }
  const units = record(inventory.units);
  if (
    !units ||
    !exactKeys(units, ["total", "selected", "hidden"]) ||
    !count(units.total) ||
    !count(units.selected) ||
    !count(units.hidden) ||
    units.total > 100_000 ||
    units.selected > units.total ||
    units.hidden > units.total
  ) {
    return null;
  }
  return {
    version: 1,
    format: inventory.format,
    originalSha256: inventory.originalSha256,
    units: { total: units.total, selected: units.selected, hidden: units.hidden },
    hasNotes: inventory.hasNotes,
    hasComments: inventory.hasComments,
    hasMacros: inventory.hasMacros,
    warnings: inventory.warnings as ExtractionWarningCode[],
    digest: inventory.digest,
  };
}

/** Strict coverage projection shared by proposals, approvals and displays. */
export function validateExtractionCoverage(value: unknown): ExtractionCoverage | null {
  const coverage = record(value);
  if (
    !coverage ||
    !exactKeys(coverage, ["kind", "selectedUnits", "totalUnits", "omitted"]) ||
    (coverage.kind !== "complete" && coverage.kind !== "partial") ||
    !count(coverage.selectedUnits) ||
    !count(coverage.totalUnits) ||
    coverage.selectedUnits > coverage.totalUnits ||
    !Array.isArray(coverage.omitted) ||
    coverage.omitted.length > 64
  ) {
    return null;
  }
  const omitted: Array<{ code: ExtractionWarningCode; count: number }> = [];
  for (const item of coverage.omitted) {
    const omission = record(item);
    if (
      !omission ||
      !exactKeys(omission, ["code", "count"]) ||
      !WARNING_CODES.includes(omission.code as ExtractionWarningCode) ||
      !count(omission.count)
    ) {
      return null;
    }
    omitted.push({ code: omission.code as ExtractionWarningCode, count: omission.count });
  }
  return {
    kind: coverage.kind,
    selectedUnits: coverage.selectedUnits,
    totalUnits: coverage.totalUnits,
    omitted,
  };
}

export function validateExtractionProposal(value: unknown): ExtractionProposal | null {
  const proposal = record(value);
  if (
    !proposal ||
    !exactKeys(proposal, [
      "version",
      "format",
      "originalSha256",
      "selectionDigest",
      "chunks",
      "coverage",
      "warnings",
      "provenance",
      "outputBytes",
    ]) ||
    proposal.version !== EXTRACTION_CONTRACT_VERSION ||
    !validFormat(proposal.format) ||
    !digest(proposal.originalSha256) ||
    !digest(proposal.selectionDigest) ||
    !Array.isArray(proposal.chunks) ||
    proposal.chunks.length > EXTRACTION_BUDGETS.maxChunks ||
    !count(proposal.outputBytes) ||
    proposal.outputBytes > EXTRACTION_BUDGETS.outputBytes ||
    !Array.isArray(proposal.warnings) ||
    proposal.warnings.length > 32 ||
    proposal.warnings.some((code) => !WARNING_CODES.includes(code as ExtractionWarningCode))
  ) {
    return null;
  }
  const chunks: ExtractionChunk[] = [];
  let total = 0;
  for (const [index, item] of proposal.chunks.entries()) {
    const chunk = record(item);
    if (
      !chunk ||
      !exactKeys(chunk, ["index", "text", "byteLength"]) ||
      chunk.index !== index ||
      typeof chunk.text !== "string" ||
      !isWellFormedAttachmentText(chunk.text) ||
      !count(chunk.byteLength) ||
      chunk.byteLength > EXTRACTION_BUDGETS.chunkBytes ||
      new TextEncoder().encode(chunk.text).byteLength !== chunk.byteLength
    ) {
      return null;
    }
    total += chunk.byteLength;
    if (total > proposal.outputBytes) return null;
    chunks.push({ index, text: chunk.text, byteLength: chunk.byteLength });
  }
  if (total !== proposal.outputBytes) return null;
  const coverage = validateExtractionCoverage(proposal.coverage);
  if (!coverage) return null;
  const provenance = record(proposal.provenance);
  const converter = record(provenance?.converter);
  if (
    !provenance ||
    !exactKeys(provenance, [
      "converter",
      "contractVersion",
      "sourceSha256",
      "selectionDigest",
      "outputSha256",
      "createdAt",
    ]) ||
    !converter ||
    !exactKeys(converter, ["name", "version"]) ||
    !label(converter.name, 64) ||
    !label(converter.version, 64) ||
    provenance.contractVersion !== EXTRACTION_CONTRACT_VERSION ||
    provenance.sourceSha256 !== proposal.originalSha256 ||
    provenance.selectionDigest !== proposal.selectionDigest ||
    !digest(provenance.outputSha256) ||
    !count(provenance.createdAt)
  ) {
    return null;
  }
  return {
    version: 1,
    format: proposal.format,
    originalSha256: proposal.originalSha256,
    selectionDigest: proposal.selectionDigest,
    chunks,
    coverage,
    warnings: proposal.warnings as ExtractionWarningCode[],
    provenance: {
      converter: { name: converter.name, version: converter.version },
      contractVersion: 1,
      sourceSha256: provenance.sourceSha256,
      selectionDigest: provenance.selectionDigest,
      outputSha256: provenance.outputSha256,
      createdAt: provenance.createdAt,
    },
    outputBytes: proposal.outputBytes,
  };
}

export { FAILURE_CODES as EXTRACTION_FAILURE_CODES, WARNING_CODES as EXTRACTION_WARNING_CODES };
