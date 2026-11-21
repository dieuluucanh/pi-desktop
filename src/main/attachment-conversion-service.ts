import { createHash } from "node:crypto";
import type { AssetOwner, AttachmentStore } from "../attachments/store";
import {
  proposalDigestInput,
  type ConversionApprovalRecord,
  type ConversionJobRecord,
  type ConversionProposalRecord,
} from "../shared/conversion";
import {
  validateExtractionRequest,
  validateExtractionProposal,
  type ExtractionFormat,
  type ExtractionInventory,
  type ExtractionProposal,
  type ExtractionRequest,
  type ExtractionSelection,
} from "../shared/extraction";
import type { ExtractionSupervisor } from "./extraction-supervisor";
import type { AttachmentConversionStore } from "./attachment-conversion-store";

/**
 * Explicit per-file conversion orchestration (plan steps 19–24).
 *
 * Only a validated consent produces an inventory/extraction. Extracted text is
 * written as an immutable attachment representation with converted provenance;
 * the proposal is recorded immutably and the approval is issued by the
 * conversion store. No renderer id, copied digest or imported manifest is an
 * approval: delivery re-reads the approval through the store.
 */

export interface AttachmentConversionServiceDeps {
  readonly store: Pick<
    AttachmentStore,
    | "readForPreparation"
    | "beginRepresentation"
    | "append"
    | "commit"
    | "cancel"
    | "recordConvertedPreparation"
  >;
  readonly conversions: Pick<
    AttachmentConversionStore,
    "begin" | "setState" | "propose" | "approve" | "job" | "proposal" | "approvalFor"
  >;
  readonly extractor: Pick<ExtractionSupervisor, "inventory" | "extract">;
  readonly newId: () => string;
  readonly now: () => number;
  readonly sha256: (bytes: Uint8Array) => string;
}

export interface AttachmentConversionService {
  begin(input: {
    readonly owner: AssetOwner;
    readonly originalId: string;
    readonly format: ExtractionFormat;
    readonly selection: ExtractionSelection;
    readonly consent: ExtractionRequest["consent"];
  }): Promise<{ readonly jobId: string; readonly inventory: ExtractionInventory }>;
  extract(input: {
    readonly jobId: string;
    readonly owner: AssetOwner;
    readonly selection: ExtractionSelection;
    readonly consent: ExtractionRequest["consent"];
  }): Promise<ConversionProposalRecord>;
  approve(input: {
    readonly jobId: string;
    readonly owner: AssetOwner;
  }): Promise<ConversionApprovalRecord>;
  status(input: { readonly jobId: string; readonly owner: AssetOwner }): Promise<{
    readonly job: ConversionJobRecord | null;
    readonly proposal: ConversionProposalRecord | null;
    readonly approval: ConversionApprovalRecord | null;
  }>;
  cancel(input: { readonly jobId: string; readonly owner: AssetOwner }): Promise<void>;
}

export class AttachmentConversionError extends Error {
  constructor(readonly code: "bad_request" | "not_found" | "conflict" | "unavailable") {
    super(`attachment conversion: ${code}`);
    this.name = "AttachmentConversionError";
  }
}

function formatsForKind(kind: string | undefined): ExtractionFormat[] {
  switch (kind) {
    case "pdf":
      return ["pdf"];
    case "word":
      return ["docx", "odt"];
    case "spreadsheet":
      return ["xlsx", "ods"];
    case "presentation":
      return ["pptx", "odp"];
    default:
      return [];
  }
}

export function createAttachmentConversionService(
  deps: AttachmentConversionServiceDeps,
): AttachmentConversionService {
  const hash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

  const loadOriginal = async (owner: AssetOwner, originalId: string) => {
    let result: Awaited<ReturnType<AttachmentStore["readForPreparation"]>>;
    try {
      result = await deps.store.readForPreparation(originalId, owner, 25 * 1024 * 1024);
    } catch {
      throw new AttachmentConversionError("not_found");
    }
    if (result.asset.kind !== "original") throw new AttachmentConversionError("bad_request");
    return result;
  };

  const requestFor = (
    job: ConversionJobRecord,
    selection: ExtractionSelection,
    consent: ExtractionRequest["consent"],
  ): ExtractionRequest => {
    const request: ExtractionRequest = {
      version: 1,
      jobId: job.jobId,
      originalId: job.originalId,
      originalSha256: job.originalSha256,
      format: job.format,
      selection,
      maxOutputBytes: 2 * 1024 * 1024,
      consent,
    };
    const checked = validateExtractionRequest(request);
    if (!checked || checked.selection.kind !== selection.kind) {
      throw new AttachmentConversionError("bad_request");
    }
    return checked;
  };

  return {
    async begin(input) {
      const original = await loadOriginal(input.owner, input.originalId);
      const formats = formatsForKind(original.asset.classification?.kind);
      if (formats.length === 0 || !formats.includes(input.format)) {
        throw new AttachmentConversionError("bad_request");
      }
      const jobId = deps.newId();
      const job = await deps.conversions.begin({
        jobId,
        originalId: input.originalId,
        originalSha256: original.asset.sha256,
        format: input.format,
        owner: { ...input.owner },
      });
      await deps.conversions.setState({ jobId, owner: input.owner, state: "inventory" });
      const request = requestFor(job, input.selection, input.consent);
      try {
        const inventory = await deps.extractor.inventory({
          request,
          bytes: new Uint8Array(original.bytes),
        });
        return { jobId, inventory };
      } catch (cause) {
        await deps.conversions
          .setState({ jobId, owner: input.owner, state: "failed" })
          .catch(() => undefined);
        throw cause;
      }
    },
    async extract(input) {
      const job = await deps.conversions.job(input.jobId);
      if (!job || job.owner.kind !== input.owner.kind || job.owner.id !== input.owner.id) {
        throw new AttachmentConversionError("not_found");
      }
      if (job.state !== "inventory" && job.state !== "extracting") {
        throw new AttachmentConversionError("conflict");
      }
      const original = await loadOriginal(input.owner, job.originalId);
      if (original.asset.sha256 !== job.originalSha256) {
        throw new AttachmentConversionError("conflict");
      }
      const request = requestFor(job, input.selection, input.consent);
      await deps.conversions.setState({
        jobId: job.jobId,
        owner: input.owner,
        state: "extracting",
      });
      let proposal: ExtractionProposal;
      try {
        proposal = await deps.extractor.extract({
          request,
          bytes: new Uint8Array(original.bytes),
        });
      } catch (cause) {
        await deps.conversions
          .setState({ jobId: job.jobId, owner: input.owner, state: "failed" })
          .catch(() => undefined);
        throw cause;
      }
      const checked = validateExtractionProposal(proposal);
      if (
        !checked ||
        checked.originalSha256 !== job.originalSha256 ||
        checked.selectionDigest !== input.consent.selectionDigest
      ) {
        await deps.conversions
          .setState({ jobId: job.jobId, owner: input.owner, state: "failed" })
          .catch(() => undefined);
        throw new AttachmentConversionError("bad_request");
      }
      const text = checked.chunks.map((chunk) => chunk.text).join("");
      const bytes = new Uint8Array(new TextEncoder().encode(text));
      if (
        bytes.byteLength !== checked.outputBytes ||
        hash(text) !== checked.provenance.outputSha256
      ) {
        throw new AttachmentConversionError("conflict");
      }
      const name = `${original.asset.name.replace(/[\\/]/g, "-").slice(0, 240) || "document"}.txt`;
      const representationId = await deps.store.beginRepresentation({
        owner: input.owner,
        name,
        mimeType: "text/plain",
        size: bytes.byteLength,
        originalId: original.asset.id,
        originalSha256: original.asset.sha256,
      });
      let committed: Awaited<ReturnType<AttachmentStore["commit"]>>;
      try {
        for (let offset = 0; offset < bytes.byteLength;) {
          const length = Math.min(256 * 1024, bytes.byteLength - offset);
          const written = await deps.store.append(
            representationId,
            input.owner,
            offset,
            bytes.subarray(offset, offset + length),
          );
          if (written !== offset + length) throw new AttachmentConversionError("unavailable");
          offset += length;
        }
        committed = await deps.store.commit(
          representationId,
          input.owner,
          checked.provenance.outputSha256,
        );
      } catch (cause) {
        await deps.store.cancel(representationId, input.owner).catch(() => undefined);
        throw cause;
      }
      const createdAt = deps.now();
      const proposalDigest = hash(
        proposalDigestInput({
          jobId: job.jobId,
          originalId: job.originalId,
          originalSha256: job.originalSha256,
          representationId: committed.id,
          representationSha256: committed.sha256,
          format: job.format,
          selectionDigest: checked.selectionDigest,
          outputBytes: committed.size,
          converter: checked.provenance.converter,
          contractVersion: 1,
        }),
      );
      await deps.store.recordConvertedPreparation(committed.id, input.owner, {
        version: 1,
        modality: "text",
        preparationVersion: `${checked.provenance.converter.name}@${checked.provenance.converter.version}`,
        warnings: [...checked.warnings],
        conversion: {
          contractVersion: 1,
          format: job.format,
          converter: { ...checked.provenance.converter },
          selectionDigest: checked.selectionDigest,
          proposalDigest,
          coverage: checked.coverage,
          createdAt,
        },
      });
      const record: ConversionProposalRecord = {
        version: 1,
        jobId: job.jobId,
        originalId: job.originalId,
        originalSha256: job.originalSha256,
        representationId: committed.id,
        representationSha256: committed.sha256,
        format: job.format,
        selectionDigest: checked.selectionDigest,
        outputBytes: committed.size,
        coverage: checked.coverage,
        warnings: [...checked.warnings],
        converter: { ...checked.provenance.converter },
        contractVersion: 1,
        proposalDigest,
        createdAt,
      };
      await deps.conversions.propose({
        jobId: job.jobId,
        owner: input.owner,
        proposal: record,
      });
      return record;
    },
    approve: (input) => deps.conversions.approve(input),
    async status(input) {
      const job = await deps.conversions.job(input.jobId);
      if (!job || job.owner.kind !== input.owner.kind || job.owner.id !== input.owner.id) {
        return { job: null, proposal: null, approval: null };
      }
      const proposal = await deps.conversions.proposal(input.jobId);
      const approval = proposal
        ? await deps.conversions.approvalFor(proposal.representationId)
        : null;
      return { job, proposal, approval };
    },
    async cancel(input) {
      const job = await deps.conversions.job(input.jobId);
      if (!job || job.owner.kind !== input.owner.kind || job.owner.id !== input.owner.id) {
        throw new AttachmentConversionError("not_found");
      }
      await deps.conversions.setState({
        jobId: input.jobId,
        owner: input.owner,
        state: "cancelled",
      });
    },
  };
}
