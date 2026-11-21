import { describe, expect, it } from "vitest";
import {
  EXTRACTION_BUDGETS,
  EXTRACTION_CONTRACT_VERSION,
  EXTRACTION_FAILURE_CODES,
  EXTRACTION_WARNING_CODES,
  validateConversionConsent,
  validateExtractionInventory,
  validateExtractionProposal,
  validateExtractionRequest,
  validateExtractionSelection,
  type ExtractionProposal,
  type ExtractionRequest,
  type ExtractorPort,
} from "../../src/shared/extraction";

const opaque = (n: number): string =>
  `123e4567-e89b-42d3-a456-${String(426614174000 + n).padStart(12, "0")}`;
const sha = (character: string): string => character.repeat(64);
const originalId = opaque(3);
const originalSha = sha("a");

function consent(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    originalId,
    originalSha256: originalSha,
    selectionDigest: sha("b"),
    policyDigest: sha("c"),
    approvedAt: 1_000,
    ...overrides,
  };
}

function request(format: ExtractionRequest["format"], selection: unknown): ExtractionRequest {
  return {
    version: EXTRACTION_CONTRACT_VERSION,
    jobId: opaque(1),
    originalId,
    originalSha256: originalSha,
    format,
    selection: selection as never,
    maxOutputBytes: 64 * 1024,
    consent: consent() as never,
  };
}

const selections = {
  pdf: { version: 1, kind: "pdf", pages: { mode: "range", ranges: [{ start: 1, end: 3 }] } },
  word: {
    version: 1,
    kind: "word",
    includeTables: true,
    includeHeadersFooters: false,
    includeComments: false,
    includeHiddenText: false,
  },
  spreadsheet: {
    version: 1,
    kind: "spreadsheet",
    sheets: { mode: "visible" },
    range: null,
    formula: "cached",
    includeHiddenSheets: false,
    maxCells: 10_000,
  },
  presentation: {
    version: 1,
    kind: "presentation",
    slides: { mode: "all" },
    includeNotes: false,
    includeHiddenSlides: false,
  },
} as const;

function proposal(overrides: Partial<ExtractionProposal> = {}): ExtractionProposal {
  const chunks = [
    { index: 0, text: "hello", byteLength: 5 },
    { index: 1, text: "world", byteLength: 5 },
  ];
  return {
    version: 1,
    format: "pdf",
    originalSha256: originalSha,
    selectionDigest: sha("b"),
    chunks,
    coverage: { kind: "complete", selectedUnits: 3, totalUnits: 3, omitted: [] },
    warnings: ["scanned_page_no_text"],
    provenance: {
      converter: { name: "pdfjs", version: "6.5.438" },
      contractVersion: 1,
      sourceSha256: originalSha,
      selectionDigest: sha("b"),
      outputSha256: sha("d"),
      createdAt: 1_000,
    },
    outputBytes: 10,
    ...overrides,
  };
}

describe("extraction contracts", () => {
  it("accepts one valid request per format and selector family", () => {
    expect(validateExtractionRequest(request("pdf", selections.pdf))).not.toBeNull();
    expect(validateExtractionRequest(request("docx", selections.word))).not.toBeNull();
    expect(validateExtractionRequest(request("odt", selections.word))).not.toBeNull();
    expect(validateExtractionRequest(request("xlsx", selections.spreadsheet))).not.toBeNull();
    expect(validateExtractionRequest(request("ods", selections.spreadsheet))).not.toBeNull();
    expect(validateExtractionRequest(request("pptx", selections.presentation))).not.toBeNull();
    expect(validateExtractionRequest(request("odp", selections.presentation))).not.toBeNull();
  });

  it("rejects mismatched selector families, orphan consent and invalid selectors", () => {
    expect(validateExtractionRequest(request("pdf", selections.word))).toBeNull();
    expect(
      validateExtractionRequest(request("pdf", { ...selections.pdf, pages: { mode: "all" } })),
    ).not.toBeNull();
    expect(
      validateExtractionRequest({
        ...request("pdf", selections.pdf),
        consent: consent({ originalSha256: sha("f") }),
      }),
    ).toBeNull();
    expect(validateExtractionRequest(request("pdf", { version: 2, kind: "pdf" }))).toBeNull();
    expect(
      validateExtractionSelection({
        version: 1,
        kind: "pdf",
        pages: { mode: "range", ranges: [{ start: 0, end: 1 }] },
      }),
    ).toBeNull();
    expect(
      validateExtractionSelection({
        version: 1,
        kind: "pdf",
        pages: { mode: "range", ranges: [{ start: 1, end: 300 }] },
      }),
    ).toBeNull();
    expect(
      validateExtractionSelection({ ...selections.spreadsheet, maxCells: 100_001 }),
    ).toBeNull();
    expect(
      validateExtractionSelection({
        ...selections.spreadsheet,
        sheets: { mode: "selected", ids: [] },
      }),
    ).toBeNull();
    expect(
      validateExtractionSelection({
        ...selections.presentation,
        slides: { mode: "selected", ids: ["a", "a"] },
      }),
    ).toBeNull();
  });

  it("rejects output larger than the cap instead of truncating it", () => {
    expect(
      validateExtractionRequest({
        ...request("pdf", selections.pdf),
        maxOutputBytes: 2 * 1024 * 1024 + 1,
      }),
    ).toBeNull();
    expect(
      validateExtractionProposal({
        ...proposal(),
        chunks: [
          {
            index: 0,
            text: "x".repeat(EXTRACTION_BUDGETS.chunkBytes + 1),
            byteLength: EXTRACTION_BUDGETS.chunkBytes + 1,
          },
        ],
        outputBytes: EXTRACTION_BUDGETS.chunkBytes + 1,
      }),
    ).toBeNull();
    // A declared byte count that does not match the UTF-8 text is invalid.
    expect(
      validateExtractionProposal({
        ...proposal(),
        chunks: [{ index: 0, text: "héllo", byteLength: 5 }],
        outputBytes: 5,
      }),
    ).toBeNull();
  });

  it("validates inventory and proposal projections strictly", () => {
    const inventory = {
      version: 1,
      format: "docx",
      originalSha256: originalSha,
      units: { total: 12, selected: 10, hidden: 2 },
      hasNotes: false,
      hasComments: true,
      hasMacros: false,
      warnings: ["hidden_content_omitted"],
      digest: sha("e"),
    };
    expect(validateExtractionInventory(inventory)).not.toBeNull();
    expect(
      validateExtractionInventory({ ...inventory, units: { total: 1, selected: 2, hidden: 0 } }),
    ).toBeNull();
    expect(validateExtractionInventory({ ...inventory, warnings: ["made_up"] })).toBeNull();
    expect(validateExtractionInventory({ ...inventory, owners: [] })).toBeNull();

    expect(validateExtractionProposal(proposal())).not.toBeNull();
    expect(
      validateExtractionProposal({
        ...proposal(),
        chunks: [
          { index: 1, text: "out of order", byteLength: 12 },
          { index: 0, text: "x", byteLength: 1 },
        ],
        outputBytes: 13,
      }),
    ).toBeNull();
    expect(
      validateExtractionProposal({
        ...proposal(),
        coverage: { kind: "complete", selectedUnits: 4, totalUnits: 3, omitted: [] },
      }),
    ).toBeNull();
    expect(
      validateExtractionProposal({
        ...proposal(),
        provenance: { ...proposal().provenance, sourceSha256: sha("f") },
      }),
    ).toBeNull();
    expect(validateExtractionProposal({ ...proposal(), extra: true })).toBeNull();
  });

  it("keeps the failure/warning vocabulary closed", () => {
    expect(EXTRACTION_FAILURE_CODES).toContain("output_too_large");
    expect(EXTRACTION_FAILURE_CODES).toContain("network_rejected");
    expect(EXTRACTION_WARNING_CODES).toContain("scanned_page_no_text");
    expect(EXTRACTION_WARNING_CODES).toContain("hidden_content_omitted");
    expect(validateConversionConsent(consent())).not.toBeNull();
    expect(validateConversionConsent(consent({ selectionDigest: "not-a-digest" }))).toBeNull();
  });

  it("drives a fake extractor through inventory, extraction and cancellation", async () => {
    const cancelled: string[] = [];
    const extractor: ExtractorPort = {
      async inventory(input) {
        expect(validateExtractionRequest(input)).not.toBeNull();
        return {
          version: 1,
          format: input.format,
          originalSha256: input.originalSha256,
          units: { total: 3, selected: 3, hidden: 0 },
          hasNotes: false,
          hasComments: false,
          hasMacros: false,
          warnings: [],
          digest: sha("e"),
        };
      },
      async extract(input) {
        expect(validateExtractionRequest(input)).not.toBeNull();
        const text = "fake extracted text";
        return {
          version: 1,
          format: input.format,
          originalSha256: input.originalSha256,
          selectionDigest: input.consent.selectionDigest,
          chunks: [{ index: 0, text, byteLength: new TextEncoder().encode(text).byteLength }],
          coverage: { kind: "complete", selectedUnits: 3, totalUnits: 3, omitted: [] },
          warnings: [],
          provenance: {
            converter: { name: "fake", version: "1.0.0" },
            contractVersion: 1,
            sourceSha256: input.originalSha256,
            selectionDigest: input.consent.selectionDigest,
            outputSha256: sha("d"),
            createdAt: 1,
          },
          outputBytes: new TextEncoder().encode(text).byteLength,
        };
      },
      async cancel(jobId) {
        cancelled.push(jobId);
      },
    };
    const input = request("pdf", selections.pdf);
    expect(validateExtractionInventory(await extractor.inventory(input))).not.toBeNull();
    expect(validateExtractionProposal(await extractor.extract(input))).not.toBeNull();
    await extractor.cancel(input.jobId);
    expect(cancelled).toEqual([input.jobId]);
  });
});
