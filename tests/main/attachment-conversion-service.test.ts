import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AssetOwner, AssetRecord, AttachmentStore } from "../../src/attachments/store";
import { createAttachmentConversionService } from "../../src/main/attachment-conversion-service";
import {
  createAttachmentConversionStore,
  type ConversionStoreIo,
} from "../../src/main/attachment-conversion-store";
import type { ExtractionRequest, ExtractionSelection } from "../../src/shared/extraction";
import { resolveDirectDeliveryAssets } from "../../src/main/attachment-delivery-assets";
import { materializeAttachmentPrompt } from "../../src/host/attachment-materialize";
import {
  ATTACHMENT_DELIVERY_VERSION,
  validateAttachmentTranscriptCard,
  type AttachmentDeliveryScope,
} from "../../src/shared/attachments";
import { createAttachmentSubmissionJournal } from "../../src/main/attachment-submission-journal";

const PROFILE = "a".repeat(64);
const owner: AssetOwner = { kind: "draft", id: "123e4567-e89b-42d3-a456-426614174090" };
const originalId = "123e4567-e89b-42d3-a456-426614174002";
const sha = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

function memoryIo(): ConversionStoreIo {
  const files = new Map<string, string>();
  return {
    async readText(path) {
      return files.get(path) ?? null;
    },
    async writeAtomic(path, contents) {
      files.set(path, contents);
    },
  };
}

function originalAsset(bytes: Uint8Array): AssetRecord {
  return {
    id: originalId,
    kind: "original",
    name: "report.pdf",
    mimeType: "application/pdf",
    size: bytes.byteLength,
    sha256: sha(bytes),
    createdAt: 1,
    owners: [owner],
    unownedAt: null,
    originalId: null,
    originalSha256: null,
    classification: { kind: "pdf" } as never,
  };
}

function fakeStore(bytes: Uint8Array) {
  const representations = new Map<string, { bytes: Uint8Array; record: AssetRecord }>();
  const pending = new Map<string, Uint8Array>();
  let next = 0;
  const store = {
    representations,
    readForPreparation: vi.fn(async (id: string) => {
      if (id !== originalId) throw new Error("not found");
      return { asset: originalAsset(bytes), bytes: new Uint8Array(bytes) };
    }),
    beginRepresentation: vi.fn(async () => {
      const id = `123e4567-e89b-42d3-a456-426614${String(174100 + next++).padStart(6, "0")}`;
      pending.set(id, new Uint8Array());
      return id;
    }),
    append: vi.fn(async (id: string, _owner: AssetOwner, offset: number, chunk: Uint8Array) => {
      const previous = pending.get(id)!;
      expect(offset).toBe(previous.byteLength);
      const nextBytes = new Uint8Array(previous.byteLength + chunk.byteLength);
      nextBytes.set(previous);
      nextBytes.set(chunk, previous.byteLength);
      pending.set(id, nextBytes);
      return nextBytes.byteLength;
    }),
    list: vi.fn(async () => [
      originalAsset(bytes),
      ...[...representations.values()].map((item) => item.record),
    ]),
    commit: vi.fn(async (id: string, _owner: AssetOwner, expected: string) => {
      const data = pending.get(id)!;
      expect(sha(data)).toBe(expected);
      pending.delete(id);
      const record = {
        ...originalAsset(data),
        id,
        kind: "representation" as const,
        name: "report.pdf.txt",
        mimeType: "text/plain",
        originalId,
        originalSha256: sha(bytes),
        owners: [owner],
      };
      representations.set(id, { bytes: data, record });
      return record;
    }),
    cancel: vi.fn(async (id: string) => {
      pending.delete(id);
    }),
    recordConvertedPreparation: vi.fn(async (id: string, _owner: AssetOwner, metadata: unknown) => {
      const item = representations.get(id)!;
      item.record = { ...item.record, conversion: metadata } as AssetRecord;
      return item.record;
    }),
  };
  return store as unknown as AttachmentStore & typeof store;
}

function proposal(text: string, consentSelectionDigest: string) {
  const bytes = new TextEncoder().encode(text);
  return {
    version: 1 as const,
    format: "pdf" as const,
    originalSha256: sha("PDF"),
    selectionDigest: consentSelectionDigest,
    chunks: [{ index: 0, text, byteLength: bytes.byteLength }],
    coverage: { kind: "complete" as const, selectedUnits: 1, totalUnits: 1, omitted: [] },
    warnings: [],
    provenance: {
      converter: { name: "fake", version: "1.0.0" },
      contractVersion: 1 as const,
      sourceSha256: sha("PDF"),
      selectionDigest: consentSelectionDigest,
      outputSha256: sha(bytes),
      createdAt: 1,
    },
    outputBytes: bytes.byteLength,
  };
}

function setup(text = "extracted text") {
  const originalBytes = new TextEncoder().encode("PDF");
  const store = fakeStore(originalBytes);
  const conversions = createAttachmentConversionStore({
    root: "/profile/attachments",
    profileKey: PROFILE,
    io: memoryIo(),
    now: () => 1_000,
  });
  const selection: ExtractionSelection = {
    version: 1,
    kind: "pdf",
    pages: { mode: "all" },
  };
  const consent = {
    version: 1 as const,
    originalId,
    originalSha256: sha(originalBytes),
    selectionDigest: sha("selection"),
    policyDigest: sha("policy"),
    approvedAt: 1,
  };
  const extractor = {
    inventory: vi.fn(async (_input: { request: ExtractionRequest; bytes: Uint8Array }) => ({
      version: 1 as const,
      format: "pdf" as const,
      originalSha256: sha(originalBytes),
      units: { total: 1, selected: 1, hidden: 0 },
      hasNotes: false,
      hasComments: false,
      hasMacros: false,
      warnings: [],
      digest: sha("inventory"),
    })),
    extract: vi.fn(async (input: { request: ExtractionRequest }) =>
      proposal(text, input.request.consent.selectionDigest),
    ),
  };
  const service = createAttachmentConversionService({
    store,
    conversions,
    extractor,
    newId: () => "123e4567-e89b-42d3-a456-426614174001",
    now: () => 1_000,
    sha256: (bytes) => sha(bytes),
  });
  return { service, store, conversions, selection, consent, extractor };
}

describe("attachment conversion service", () => {
  it("runs consent → inventory → extraction → immutable proposal → approval", async () => {
    const h = setup();
    const begun = await h.service.begin({
      owner,
      originalId,
      format: "pdf",
      selection: h.selection,
      consent: h.consent,
    });
    expect(begun.inventory.units.total).toBe(1);
    const record = await h.service.extract({
      jobId: begun.jobId,
      owner,
      selection: h.selection,
      consent: h.consent,
    });
    expect(record).toMatchObject({
      converter: { name: "fake", version: "1.0.0" },
      outputBytes: 14,
    });
    const representation = [...h.store.representations.values()][0]!;
    expect(new TextDecoder().decode(representation.bytes)).toBe("extracted text");
    expect(h.store.recordConvertedPreparation).toHaveBeenCalledOnce();
    const approval = await h.service.approve({ jobId: begun.jobId, owner });
    expect(approval.approvalDigest).toMatch(/^[0-9a-f]{64}$/);
    await expect(h.service.status({ jobId: begun.jobId, owner })).resolves.toMatchObject({
      job: { state: "approved" },
      proposal: { representationId: record.representationId },
      approval: { representationId: record.representationId },
    });
  });

  it("refuses a missing original, an unconsented format and a mismatched proposal", async () => {
    const h = setup();
    await expect(
      h.service.begin({
        owner,
        originalId: "123e4567-e89b-42d3-a456-426614174099",
        format: "pdf",
        selection: h.selection,
        consent: h.consent,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      h.service.begin({
        owner,
        originalId,
        format: "docx",
        selection: h.selection,
        consent: h.consent,
      }),
    ).rejects.toMatchObject({ code: "bad_request" });

    const begun = await h.service.begin({
      owner,
      originalId,
      format: "pdf",
      selection: h.selection,
      consent: h.consent,
    });
    h.extractor.extract.mockResolvedValueOnce({
      ...proposal("text", sha("other")),
      selectionDigest: sha("other"),
    });
    await expect(
      h.service.extract({
        jobId: begun.jobId,
        owner,
        selection: h.selection,
        consent: h.consent,
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("delivers approved converted text through resolution, materialization and the transcript card", async () => {
    const h = setup("extracted text");
    const begun = await h.service.begin({
      owner,
      originalId,
      format: "pdf",
      selection: h.selection,
      consent: h.consent,
    });
    const proposal = await h.service.extract({
      jobId: begun.jobId,
      owner,
      selection: h.selection,
      consent: h.consent,
    });
    await h.service.approve({ jobId: begun.jobId, owner });

    const assets = await resolveDirectDeliveryAssets(
      h.store,
      owner,
      [proposal.representationId],
      h.conversions,
    );
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      original: { kind: "pdf", name: "report.pdf" },
      representation: {
        modality: "text",
        origin: "converted",
        approved: true,
        preparationVersion: "fake@1.0.0",
      },
      approvalDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    const representation = h.store.representations.get(proposal.representationId)!;
    const materialized = await materializeAttachmentPrompt(
      {
        isCurrent: async () => true,
        readChunk: async (_id, offset, length) =>
          representation.bytes.subarray(offset, offset + length),
        sha256: async (value) => sha(value),
      },
      {
        version: ATTACHMENT_DELIVERY_VERSION,
        id: "123e4567-e89b-42d3-a456-426614174099",
        model: { provider: "test", id: "model", api: "test" },
        representationIds: [proposal.representationId],
        estimatedTokens: 10,
        blockingReasons: [],
      },
      assets,
      "Summarize this.",
    );
    expect(materialized.text).toContain("extracted text");

    const files = new Map<string, string>();
    const journal = createAttachmentSubmissionJournal({
      root: "/profile/attachments",
      profileKey: PROFILE,
      io: {
        readText: async (path) => files.get(path) ?? null,
        writeAtomic: async (path, contents) => {
          files.set(path, contents);
        },
      },
      now: () => 1_000,
    });
    const turnId = "123e4567-e89b-42d3-a456-426614174010";
    const attemptId = "123e4567-e89b-42d3-a456-426614174011";
    const scope: AttachmentDeliveryScope = {
      authorityId: "123e4567-e89b-42d3-a456-426614174012",
      leaseId: "123e4567-e89b-42d3-a456-426614174013",
      profileKey: PROFILE,
      tabId: "tab-1",
      draftId: owner.id,
      hostGeneration: 1,
      processGeneration: 1,
      sessionId: "123e4567-e89b-42d3-a456-426614174014",
      sessionEpoch: 1,
      branchId: null,
      revision: "rev-1",
    };
    const attempt = await journal.begin({
      planId: "123e4567-e89b-42d3-a456-426614174099",
      turnId,
      attemptId,
      scope,
      sourceText: "Summarize this.",
      assets,
    });
    expect(["begin", "dispatch"]).toContain(attempt.kind);
    if (attempt.kind === "conflict") throw new Error("unexpected journal conflict");
    const entry = attempt.entry;
    const accepted = await journal.complete(
      turnId,
      attemptId,
      {
        outcome: "accepted",
        turnId,
        attemptId,
        userEntryId: "user-1",
        associationEntryId: "association-1",
      },
      {
        associationEntryId: "association-1",
        metadata: {
          version: 1,
          planId: entry.planId,
          turnId,
          attemptId,
          scope,
          sourceTextSha256: entry.sourceTextSha256,
          userEntryId: "user-1",
          textSha256: sha("Summarize this."),
          images: entry.images,
          representations: entry.representations,
          createdAt: entry.createdAt,
        },
      },
    );
    expect(accepted.state).toBe("accepted");
    expect(accepted.representations[0]).toMatchObject({
      representationId: proposal.representationId,
    });

    const original = originalAsset(new TextEncoder().encode("PDF"));
    expect(
      validateAttachmentTranscriptCard({
        version: 1,
        status: "submitted",
        associationEntryId: "association-1",
        userEntryId: "user-1",
        turnId: "123e4567-e89b-42d3-a456-426614174001",
        files: [
          {
            representationId: proposal.representationId,
            originalId,
            modality: "text",
            display: {
              name: representation.record.name,
              originalKind: "pdf",
              originalBytes: original.size,
              representationBytes: representation.record.size,
              origin: "converted",
              preparationVersion: "fake@1.0.0",
              warnings: [],
              coverage: { kind: "entire-file" },
              image: null,
            },
          },
        ],
      }),
    ).not.toBeNull();
  });
});
