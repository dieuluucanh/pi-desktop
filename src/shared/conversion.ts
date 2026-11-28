/**
 * Immutable conversion proposals and approvals (plan step 19).
 *
 * A proposal describes one exact extraction output: source original digest,
 * selection digest, converter/contract version, representation id/digest,
 * coverage and warnings. An approval binds that proposal to one owner and a
 * digest over those fields. Main is the only authority: a renderer boolean, a
 * copied id or a structurally plausible digest is not an approval.
 */

import { isAttachmentId } from "./attachments";
import type { ExtractionCoverage, ExtractionFormat } from "./extraction";

/** Browser-safe structural owner; the attachment store's AssetOwner matches it. */
export interface ConversionOwner {
  readonly kind: "draft" | "session";
  readonly id: string;
}

export const CONVERSION_CONTRACT_VERSION = 1 as const;

export type ConversionJobState =
  "requested" | "inventory" | "extracting" | "proposed" | "approved" | "failed" | "cancelled";

export interface ConversionJobRecord {
  readonly version: 1;
  readonly jobId: string;
  readonly originalId: string;
  readonly originalSha256: string;
  readonly format: ExtractionFormat;
  readonly owner: ConversionOwner;
  readonly state: ConversionJobState;
  readonly proposalDigest: string | null;
  readonly approvalDigest: string | null;
  readonly updatedAt: number;
}

/** Immutable proposal metadata; the text itself lives in the attachment store. */
export interface ConversionProposalRecord {
  readonly version: 1;
  readonly jobId: string;
  readonly originalId: string;
  readonly originalSha256: string;
  readonly representationId: string;
  readonly representationSha256: string;
  readonly format: ExtractionFormat;
  readonly selectionDigest: string;
  readonly outputBytes: number;
  readonly coverage: ExtractionCoverage;
  readonly warnings: readonly string[];
  readonly converter: { readonly name: string; readonly version: string };
  readonly contractVersion: typeof CONVERSION_CONTRACT_VERSION;
  readonly proposalDigest: string;
  readonly createdAt: number;
}

/** Immutable approval; `approvalDigest` covers every field below it. */
export interface ConversionApprovalRecord {
  readonly version: 1;
  readonly jobId: string;
  readonly originalId: string;
  readonly originalSha256: string;
  readonly representationId: string;
  readonly representationSha256: string;
  readonly proposalDigest: string;
  readonly converter: { readonly name: string; readonly version: string };
  readonly contractVersion: typeof CONVERSION_CONTRACT_VERSION;
  readonly selectionDigest: string;
  readonly owner: ConversionOwner;
  readonly approvedAt: number;
  readonly approvalDigest: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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

function validOwner(value: unknown): value is ConversionOwner {
  const owner = record(value);
  return (
    !!owner &&
    exactKeys(owner, ["kind", "id"]) &&
    (owner.kind === "draft" || owner.kind === "session") &&
    label(owner.id)
  );
}

const FORMATS = ["pdf", "docx", "odt", "xlsx", "ods", "pptx", "odp"] as const;
const STATES: readonly ConversionJobState[] = [
  "requested",
  "inventory",
  "extracting",
  "proposed",
  "approved",
  "failed",
  "cancelled",
];

export function validateConversionJob(value: unknown): ConversionJobRecord | null {
  const job = record(value);
  if (
    !job ||
    !exactKeys(job, [
      "version",
      "jobId",
      "originalId",
      "originalSha256",
      "format",
      "owner",
      "state",
      "proposalDigest",
      "approvalDigest",
      "updatedAt",
    ]) ||
    job.version !== 1 ||
    !isAttachmentId(job.jobId) ||
    !isAttachmentId(job.originalId) ||
    !digest(job.originalSha256) ||
    !(FORMATS as readonly string[]).includes(String(job.format)) ||
    !validOwner(job.owner) ||
    !(STATES as readonly string[]).includes(String(job.state)) ||
    (job.proposalDigest !== null && !digest(job.proposalDigest)) ||
    (job.approvalDigest !== null && !digest(job.approvalDigest)) ||
    !count(job.updatedAt)
  ) {
    return null;
  }
  return {
    version: 1,
    jobId: job.jobId,
    originalId: job.originalId,
    originalSha256: job.originalSha256,
    format: job.format as ExtractionFormat,
    owner: { kind: job.owner.kind, id: job.owner.id },
    state: job.state as ConversionJobState,
    proposalDigest: job.proposalDigest as string | null,
    approvalDigest: job.approvalDigest as string | null,
    updatedAt: job.updatedAt,
  };
}

function validCoverage(value: unknown): value is ExtractionCoverage {
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
    return false;
  }
  return coverage.omitted.every((item) => {
    const omission = record(item);
    return (
      !!omission &&
      exactKeys(omission, ["code", "count"]) &&
      label(omission.code, 64) &&
      count(omission.count)
    );
  });
}

export function validateConversionProposal(value: unknown): ConversionProposalRecord | null {
  const proposal = record(value);
  const converter = record(proposal?.converter);
  if (
    !proposal ||
    !exactKeys(proposal, [
      "version",
      "jobId",
      "originalId",
      "originalSha256",
      "representationId",
      "representationSha256",
      "format",
      "selectionDigest",
      "outputBytes",
      "coverage",
      "warnings",
      "converter",
      "contractVersion",
      "proposalDigest",
      "createdAt",
    ]) ||
    proposal.version !== 1 ||
    !isAttachmentId(proposal.jobId) ||
    !isAttachmentId(proposal.originalId) ||
    !digest(proposal.originalSha256) ||
    !isAttachmentId(proposal.representationId) ||
    !digest(proposal.representationSha256) ||
    !(FORMATS as readonly string[]).includes(String(proposal.format)) ||
    !digest(proposal.selectionDigest) ||
    !count(proposal.outputBytes) ||
    !validCoverage(proposal.coverage) ||
    !Array.isArray(proposal.warnings) ||
    proposal.warnings.length > 32 ||
    proposal.warnings.some((warning) => !label(warning, 64)) ||
    !converter ||
    !exactKeys(converter, ["name", "version"]) ||
    !label(converter.name, 64) ||
    !label(converter.version, 64) ||
    proposal.contractVersion !== CONVERSION_CONTRACT_VERSION ||
    !digest(proposal.proposalDigest) ||
    !count(proposal.createdAt)
  ) {
    return null;
  }
  return {
    version: 1,
    jobId: proposal.jobId,
    originalId: proposal.originalId,
    originalSha256: proposal.originalSha256,
    representationId: proposal.representationId,
    representationSha256: proposal.representationSha256,
    format: proposal.format as ExtractionFormat,
    selectionDigest: proposal.selectionDigest,
    outputBytes: proposal.outputBytes,
    coverage: proposal.coverage,
    warnings: proposal.warnings as string[],
    converter: { name: converter.name, version: converter.version },
    contractVersion: 1,
    proposalDigest: proposal.proposalDigest,
    createdAt: proposal.createdAt,
  };
}

export function validateConversionApproval(value: unknown): ConversionApprovalRecord | null {
  const approval = record(value);
  const converter = record(approval?.converter);
  if (
    !approval ||
    !exactKeys(approval, [
      "version",
      "jobId",
      "originalId",
      "originalSha256",
      "representationId",
      "representationSha256",
      "proposalDigest",
      "converter",
      "contractVersion",
      "selectionDigest",
      "owner",
      "approvedAt",
      "approvalDigest",
    ]) ||
    approval.version !== 1 ||
    !isAttachmentId(approval.jobId) ||
    !isAttachmentId(approval.originalId) ||
    !digest(approval.originalSha256) ||
    !isAttachmentId(approval.representationId) ||
    !digest(approval.representationSha256) ||
    !digest(approval.proposalDigest) ||
    !converter ||
    !exactKeys(converter, ["name", "version"]) ||
    !label(converter.name, 64) ||
    !label(converter.version, 64) ||
    approval.contractVersion !== CONVERSION_CONTRACT_VERSION ||
    !digest(approval.selectionDigest) ||
    !validOwner(approval.owner) ||
    !count(approval.approvedAt) ||
    !digest(approval.approvalDigest)
  ) {
    return null;
  }
  return {
    version: 1,
    jobId: approval.jobId,
    originalId: approval.originalId,
    originalSha256: approval.originalSha256,
    representationId: approval.representationId,
    representationSha256: approval.representationSha256,
    proposalDigest: approval.proposalDigest,
    converter: { name: converter.name, version: converter.version },
    contractVersion: 1,
    selectionDigest: approval.selectionDigest,
    owner: { kind: approval.owner.kind, id: approval.owner.id },
    approvedAt: approval.approvedAt,
    approvalDigest: approval.approvalDigest,
  };
}

/** The canonical fields covered by a proposal digest (order is fixed). */
export function proposalDigestInput(input: {
  readonly jobId: string;
  readonly originalId: string;
  readonly originalSha256: string;
  readonly representationId: string;
  readonly representationSha256: string;
  readonly format: string;
  readonly selectionDigest: string;
  readonly outputBytes: number;
  readonly converter: { readonly name: string; readonly version: string };
  readonly contractVersion: number;
}): string {
  return JSON.stringify([
    input.jobId,
    input.originalId,
    input.originalSha256,
    input.representationId,
    input.representationSha256,
    input.format,
    input.selectionDigest,
    input.outputBytes,
    input.converter.name,
    input.converter.version,
    input.contractVersion,
  ]);
}

/** The canonical fields covered by an approval digest (order is fixed). */
export function approvalDigestInput(
  approval: Omit<ConversionApprovalRecord, "approvalDigest">,
): string {
  return JSON.stringify([
    approval.version,
    approval.jobId,
    approval.originalId,
    approval.originalSha256,
    approval.representationId,
    approval.representationSha256,
    approval.proposalDigest,
    approval.converter.name,
    approval.converter.version,
    approval.contractVersion,
    approval.selectionDigest,
    approval.owner.kind,
    approval.owner.id,
    approval.approvedAt,
  ]);
}
