/**
 * Profile-scoped immutable conversion proposals and approvals (plan step 19).
 *
 * This file stores metadata only: the extracted text is an immutable attachment
 * representation in the attachment store. The single writer is atomic; malformed
 * state is an error and is never repaired or overwritten. An approval digest is
 * computed over every binding field, so a copied id or edited JSON cannot pass.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  approvalDigestInput,
  validateConversionApproval,
  validateConversionJob,
  validateConversionProposal,
  type ConversionApprovalRecord,
  type ConversionJobRecord,
  type ConversionJobState,
  type ConversionProposalRecord,
} from "../shared/conversion";
import type { ExtractionFormat } from "../shared/extraction";
import type { AssetOwner } from "../attachments/store";

const MANIFEST_VERSION = 1;
const MAX_RECORDS = 500;
const ACTIVE_STATES: readonly ConversionJobState[] = [
  "requested",
  "inventory",
  "extracting",
  "proposed",
  "approved",
];

/** Node adapter for the conversion manifest: bounded, atomic, no path input. */
export function createNodeConversionStoreIo(): ConversionStoreIo {
  return {
    async readText(path) {
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(path);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }
      if (
        info.isSymbolicLink() ||
        !info.isFile() ||
        !Number.isSafeInteger(info.size) ||
        info.size > 2 * 1024 * 1024
      ) {
        throw new Error("conversion manifest is not a bounded regular file");
      }
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const bytes = Buffer.alloc(info.size + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
      } finally {
        await handle.close();
      }
    },
    async writeAtomic(path, contents) {
      const directory = dirname(path);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(contents, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    },
  };
}

export type ConversionStoreErrorCode = "bad_request" | "conflict" | "not_found" | "corrupt";

export class ConversionStoreError extends Error {
  constructor(readonly code: ConversionStoreErrorCode) {
    super(`conversion store: ${code}`);
    this.name = "ConversionStoreError";
  }
}

export interface ConversionStoreIo {
  readText(path: string): Promise<string | null>;
  writeAtomic(path: string, contents: string): Promise<void>;
}

interface ConversionDocument {
  readonly version: typeof MANIFEST_VERSION;
  readonly jobs: readonly ConversionJobRecord[];
  readonly proposals: readonly ConversionProposalRecord[];
  readonly approvals: readonly ConversionApprovalRecord[];
}

export interface AttachmentConversionStore {
  begin(input: {
    readonly jobId: string;
    readonly originalId: string;
    readonly originalSha256: string;
    readonly format: ExtractionFormat;
    readonly owner: AssetOwner;
  }): Promise<ConversionJobRecord>;
  setState(input: {
    readonly jobId: string;
    readonly owner: AssetOwner;
    readonly state: "inventory" | "extracting" | "failed" | "cancelled";
  }): Promise<ConversionJobRecord>;
  propose(input: {
    readonly jobId: string;
    readonly owner: AssetOwner;
    readonly proposal: ConversionProposalRecord;
  }): Promise<ConversionProposalRecord>;
  approve(input: {
    readonly jobId: string;
    readonly owner: AssetOwner;
  }): Promise<ConversionApprovalRecord>;
  revoke(input: {
    readonly jobId: string;
    readonly owner: AssetOwner;
  }): Promise<ConversionJobRecord>;
  job(jobId: string): Promise<ConversionJobRecord | null>;
  proposal(jobId: string): Promise<ConversionProposalRecord | null>;
  approvalFor(representationId: string): Promise<ConversionApprovalRecord | null>;
  /**
   * Startup fencing: active jobs from a previous process are failed, never
   * resumed/re-extracted automatically. Proposed/approved records stay intact.
   */
  reconcile(): Promise<number>;
}

function fail(code: ConversionStoreErrorCode): never {
  throw new ConversionStoreError(code);
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

function sameOwner(left: AssetOwner, right: AssetOwner): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function decodeDocument(raw: string | null): ConversionDocument {
  if (raw === null) {
    return { version: MANIFEST_VERSION, jobs: [], proposals: [], approvals: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("corrupt");
  }
  const document = record(parsed);
  if (
    !document ||
    !exactKeys(document, ["version", "jobs", "proposals", "approvals"]) ||
    document.version !== MANIFEST_VERSION ||
    !Array.isArray(document.jobs) ||
    !Array.isArray(document.proposals) ||
    !Array.isArray(document.approvals) ||
    document.jobs.length > MAX_RECORDS ||
    document.proposals.length > MAX_RECORDS ||
    document.approvals.length > MAX_RECORDS
  ) {
    return fail("corrupt");
  }
  const jobs = document.jobs.map(validateConversionJob);
  const proposals = document.proposals.map(validateConversionProposal);
  const approvals = document.approvals.map(validateConversionApproval);
  if (
    jobs.some((item) => item === null) ||
    proposals.some((item) => item === null) ||
    approvals.some((item) => item === null)
  ) {
    return fail("corrupt");
  }
  const unique = (values: readonly string[]) => new Set(values).size === values.length;
  const validJobs = jobs as ConversionJobRecord[];
  const validProposals = proposals as ConversionProposalRecord[];
  const validApprovals = approvals as ConversionApprovalRecord[];
  if (
    !unique(validJobs.map((item) => item.jobId)) ||
    !unique(validProposals.map((item) => item.proposalDigest)) ||
    !unique(validApprovals.map((item) => item.representationId)) ||
    validProposals.some((item) => !validJobs.some((job) => job.jobId === item.jobId)) ||
    validApprovals.some(
      (item) => !validProposals.some((proposal) => proposal.proposalDigest === item.proposalDigest),
    )
  ) {
    return fail("corrupt");
  }
  return {
    version: MANIFEST_VERSION,
    jobs: validJobs,
    proposals: validProposals,
    approvals: validApprovals,
  };
}

export interface AttachmentConversionStoreDeps {
  readonly root: string;
  /** Lowercase SHA-256 of the canonical profile identity. */
  readonly profileKey: string;
  readonly io: ConversionStoreIo;
  readonly now?: () => number;
}

export function createAttachmentConversionStore(
  deps: AttachmentConversionStoreDeps,
): AttachmentConversionStore {
  if (!/^[0-9a-f]{64}$/.test(deps.profileKey)) fail("bad_request");
  const path = `${deps.root}/conversions/${deps.profileKey}.json`;
  const now = deps.now ?? Date.now;
  let tail = Promise.resolve();

  const transact = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const load = async (): Promise<ConversionDocument> => {
    let raw: string | null;
    try {
      raw = await deps.io.readText(path);
    } catch {
      return fail("corrupt");
    }
    return decodeDocument(raw);
  };

  const save = async (document: ConversionDocument): Promise<void> => {
    try {
      await deps.io.writeAtomic(path, JSON.stringify(document));
    } catch {
      return fail("corrupt");
    }
  };

  const findJob = (document: ConversionDocument, jobId: string): ConversionJobRecord => {
    const job = document.jobs.find((item) => item.jobId === jobId);
    return job ?? fail("not_found");
  };

  return {
    begin(input) {
      return transact(async () => {
        const document = await load();
        if (
          document.jobs.some((job) => job.jobId === input.jobId) ||
          document.jobs.some(
            (job) =>
              job.originalId === input.originalId &&
              sameOwner(job.owner, input.owner) &&
              ACTIVE_STATES.includes(job.state),
          )
        ) {
          return fail("conflict");
        }
        const timestamp = now();
        if (!Number.isSafeInteger(timestamp) || timestamp < 0) return fail("bad_request");
        const job: ConversionJobRecord = {
          version: 1,
          jobId: input.jobId,
          originalId: input.originalId,
          originalSha256: input.originalSha256,
          format: input.format,
          owner: { ...input.owner },
          state: "requested",
          proposalDigest: null,
          approvalDigest: null,
          updatedAt: timestamp,
        };
        const checked = validateConversionJob(job);
        if (!checked) return fail("bad_request");
        await save({ ...document, jobs: [...document.jobs, checked] });
        return checked;
      });
    },
    setState(input) {
      return transact(async () => {
        const document = await load();
        const job = findJob(document, input.jobId);
        if (!sameOwner(job.owner, input.owner)) return fail("not_found");
        if (job.state === "failed" || job.state === "cancelled") return fail("conflict");
        if (
          (input.state === "inventory" || input.state === "extracting") &&
          !["requested", "inventory", "extracting"].includes(job.state)
        ) {
          return fail("conflict");
        }
        const terminal = input.state === "failed" || input.state === "cancelled";
        const updated: ConversionJobRecord = {
          ...job,
          state: input.state,
          approvalDigest: terminal ? null : job.approvalDigest,
          updatedAt: Math.max(now(), job.updatedAt),
        };
        await save({
          ...document,
          jobs: document.jobs.map((item) => (item.jobId === job.jobId ? updated : item)),
          approvals: terminal
            ? document.approvals.filter((item) => item.jobId !== job.jobId)
            : document.approvals,
        });
        return updated;
      });
    },
    propose(input) {
      return transact(async () => {
        const document = await load();
        const job = findJob(document, input.jobId);
        if (!sameOwner(job.owner, input.owner)) return fail("not_found");
        const proposal = validateConversionProposal(input.proposal);
        if (
          !proposal ||
          proposal.jobId !== job.jobId ||
          proposal.originalId !== job.originalId ||
          proposal.originalSha256 !== job.originalSha256 ||
          proposal.format !== job.format ||
          !["inventory", "extracting", "proposed"].includes(job.state)
        ) {
          return fail("bad_request");
        }
        const existing = document.proposals.find(
          (item) =>
            item.jobId === proposal.jobId || item.representationId === proposal.representationId,
        );
        if (existing) {
          if (existing.proposalDigest === proposal.proposalDigest) return existing;
          return fail("conflict");
        }
        const updated: ConversionJobRecord = {
          ...job,
          state: "proposed",
          proposalDigest: proposal.proposalDigest,
          approvalDigest: null,
          updatedAt: Math.max(now(), job.updatedAt),
        };
        await save({
          ...document,
          jobs: document.jobs.map((item) => (item.jobId === job.jobId ? updated : item)),
          proposals: [...document.proposals, proposal],
        });
        return proposal;
      });
    },
    approve(input) {
      return transact(async () => {
        const document = await load();
        const job = findJob(document, input.jobId);
        if (!sameOwner(job.owner, input.owner)) return fail("not_found");
        const proposal = document.proposals.find((item) => item.jobId === job.jobId);
        if (!proposal) return fail("conflict");
        const existing = document.approvals.find(
          (item) => item.representationId === proposal.representationId,
        );
        if (existing) return existing;
        if (job.state !== "proposed") return fail("conflict");
        const timestamp = now();
        if (!Number.isSafeInteger(timestamp) || timestamp < 0) return fail("bad_request");
        const base = {
          version: 1 as const,
          jobId: job.jobId,
          originalId: job.originalId,
          originalSha256: job.originalSha256,
          representationId: proposal.representationId,
          representationSha256: proposal.representationSha256,
          proposalDigest: proposal.proposalDigest,
          converter: { ...proposal.converter },
          contractVersion: 1 as const,
          selectionDigest: proposal.selectionDigest,
          owner: { ...job.owner },
          approvedAt: Math.max(timestamp, job.updatedAt),
        };
        const approvalDigest = createHash("sha256")
          .update(approvalDigestInput(base), "utf8")
          .digest("hex");
        const approval: ConversionApprovalRecord = { ...base, approvalDigest };
        const checked = validateConversionApproval(approval);
        if (!checked) return fail("bad_request");
        const updated: ConversionJobRecord = {
          ...job,
          state: "approved",
          approvalDigest,
          updatedAt: Math.max(timestamp, job.updatedAt),
        };
        await save({
          ...document,
          jobs: document.jobs.map((item) => (item.jobId === job.jobId ? updated : item)),
          approvals: [...document.approvals, checked],
        });
        return checked;
      });
    },
    revoke(input) {
      return transact(async () => {
        const document = await load();
        const job = findJob(document, input.jobId);
        if (!sameOwner(job.owner, input.owner)) return fail("not_found");
        if (job.state !== "approved") return fail("conflict");
        const updated: ConversionJobRecord = {
          ...job,
          state: "proposed",
          approvalDigest: null,
          updatedAt: Math.max(now(), job.updatedAt),
        };
        await save({
          ...document,
          jobs: document.jobs.map((item) => (item.jobId === job.jobId ? updated : item)),
          approvals: document.approvals.filter((item) => item.jobId !== job.jobId),
        });
        return updated;
      });
    },
    job(jobId) {
      return transact(async () => (await load()).jobs.find((item) => item.jobId === jobId) ?? null);
    },
    proposal(jobId) {
      return transact(
        async () => (await load()).proposals.find((item) => item.jobId === jobId) ?? null,
      );
    },
    approvalFor(representationId) {
      return transact(
        async () =>
          (await load()).approvals.find((item) => item.representationId === representationId) ??
          null,
      );
    },
    reconcile() {
      return transact(async () => {
        const document = await load();
        const timestamp = now();
        if (!Number.isSafeInteger(timestamp) || timestamp < 0) return fail("bad_request");
        let changed = 0;
        const jobs = document.jobs.map((job) => {
          if (!["requested", "inventory", "extracting"].includes(job.state)) return job;
          changed += 1;
          return {
            ...job,
            state: "failed" as const,
            approvalDigest: null,
            updatedAt: Math.max(timestamp, job.updatedAt),
          };
        });
        if (changed > 0) await save({ ...document, jobs });
        return changed;
      });
    },
  };
}
