import { describe, expect, it } from "vitest";
import type { AssetOwner } from "../../src/attachments/store";
import {
  createAttachmentConversionStore,
  ConversionStoreError,
  type ConversionStoreIo,
} from "../../src/main/attachment-conversion-store";
import type { ConversionProposalRecord } from "../../src/shared/conversion";

const PROFILE = "a".repeat(64);
const opaque = (n: number): string =>
  `123e4567-e89b-42d3-a456-${String(426614174000 + n).padStart(12, "0")}`;
const sha = (c: string): string => c.repeat(64);
const owner: AssetOwner = { kind: "draft", id: opaque(90) };

function memoryIo() {
  const files = new Map<string, string>();
  const writes: string[] = [];
  const io: ConversionStoreIo = {
    async readText(path) {
      return files.get(path) ?? null;
    },
    async writeAtomic(path, contents) {
      writes.push(contents);
      files.set(path, contents);
    },
  };
  return { io, files, writes };
}

function harness(now = 1_000) {
  const disk = memoryIo();
  const store = createAttachmentConversionStore({
    root: "/profile/attachments",
    profileKey: PROFILE,
    io: disk.io,
    now: () => now,
  });
  return { store, ...disk };
}

function proposal(overrides: Partial<ConversionProposalRecord> = {}): ConversionProposalRecord {
  return {
    version: 1,
    jobId: opaque(1),
    originalId: opaque(2),
    originalSha256: sha("a"),
    representationId: opaque(3),
    representationSha256: sha("b"),
    format: "pdf",
    selectionDigest: sha("c"),
    outputBytes: 10,
    coverage: { kind: "complete", selectedUnits: 1, totalUnits: 1, omitted: [] },
    warnings: [],
    converter: { name: "pdfjs", version: "6.5.438" },
    contractVersion: 1,
    proposalDigest: sha("d"),
    createdAt: 1_000,
    ...overrides,
  };
}

async function begun(h = harness()) {
  await h.store.begin({
    jobId: opaque(1),
    originalId: opaque(2),
    originalSha256: sha("a"),
    format: "pdf",
    owner,
  });
  await h.store.setState({ jobId: opaque(1), owner, state: "inventory" });
  return h;
}

describe("conversion proposal/approval store", () => {
  it("keeps proposals immutable and binds an approval to every field", async () => {
    const h = await begun();
    await expect(
      h.store.propose({ jobId: opaque(1), owner, proposal: proposal() }),
    ).resolves.toEqual(proposal());
    const approval = await h.store.approve({ jobId: opaque(1), owner });
    expect(approval).toMatchObject({
      representationId: opaque(3),
      representationSha256: sha("b"),
      proposalDigest: sha("d"),
      owner,
      contractVersion: 1,
    });
    expect(approval.approvalDigest).toMatch(/^[0-9a-f]{64}$/);
    // Idempotent approval returns the same record.
    await expect(h.store.approve({ jobId: opaque(1), owner })).resolves.toEqual(approval);
    await expect(h.store.approvalFor(opaque(3))).resolves.toEqual(approval);
    await expect(h.store.job(opaque(1))).resolves.toMatchObject({ state: "approved" });
  });

  it("refuses duplicate active jobs, changed proposals and forged fields", async () => {
    const h = await begun();
    await expect(
      h.store.begin({
        jobId: opaque(11),
        originalId: opaque(2),
        originalSha256: sha("a"),
        format: "pdf",
        owner,
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    await h.store.propose({ jobId: opaque(1), owner, proposal: proposal() });
    await expect(
      h.store.propose({
        jobId: opaque(1),
        owner,
        proposal: proposal({ representationSha256: sha("e"), proposalDigest: sha("f") }),
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    for (const forged of [
      proposal({ jobId: opaque(9) }),
      proposal({ originalSha256: sha("e"), proposalDigest: sha("f") }),
      proposal({ format: "docx", proposalDigest: sha("f") }),
      proposal({ coverage: { kind: "complete", selectedUnits: 2, totalUnits: 1, omitted: [] } }),
    ]) {
      const other = await begun(harness(2_000));
      await expect(
        other.store.propose({ jobId: opaque(1), owner, proposal: forged }),
      ).rejects.toBeInstanceOf(ConversionStoreError);
    }
  });

  it("requires the exact owner and supports revoke/terminal transitions", async () => {
    const h = await begun();
    const otherOwner: AssetOwner = { kind: "draft", id: opaque(91) };
    await expect(
      h.store.propose({ jobId: opaque(1), owner: otherOwner, proposal: proposal() }),
    ).rejects.toMatchObject({ code: "not_found" });
    await h.store.propose({ jobId: opaque(1), owner, proposal: proposal() });
    await h.store.approve({ jobId: opaque(1), owner });
    await expect(h.store.revoke({ jobId: opaque(1), owner })).resolves.toMatchObject({
      state: "proposed",
      approvalDigest: null,
    });
    await expect(h.store.approvalFor(opaque(3))).resolves.toBeNull();
    await h.store.setState({ jobId: opaque(1), owner, state: "failed" });
    await expect(h.store.job(opaque(1))).resolves.toMatchObject({ state: "failed" });
    // A terminal job no longer blocks a new explicit attempt.
    await expect(
      h.store.begin({
        jobId: opaque(12),
        originalId: opaque(2),
        originalSha256: sha("a"),
        format: "pdf",
        owner,
      }),
    ).resolves.toMatchObject({ state: "requested" });
  });

  it("fails closed on a corrupt file instead of overwriting it", async () => {
    const h = harness();
    const path = "/profile/attachments/conversions/" + PROFILE + ".json";
    h.files.set(path, "{not json");
    const before = h.files.get(path);
    await expect(
      h.store.begin({
        jobId: opaque(1),
        originalId: opaque(2),
        originalSha256: sha("a"),
        format: "pdf",
        owner,
      }),
    ).rejects.toMatchObject({ code: "corrupt" });
    expect(h.files.get(path)).toBe(before);
    expect(h.writes).toHaveLength(0);
  });

  it("fails active jobs on restart but preserves proposed/approved records", async () => {
    const h = harness();
    const activeJob = {
      jobId: opaque(1),
      originalId: opaque(2),
      originalSha256: sha("a"),
      format: "pdf" as const,
      owner,
    };
    const approvedJob = {
      jobId: opaque(4),
      originalId: opaque(5),
      originalSha256: sha("b"),
      format: "docx" as const,
      owner,
    };
    await h.store.begin(activeJob);
    await h.store.setState({ jobId: activeJob.jobId, owner, state: "inventory" });
    await h.store.begin(approvedJob);
    await h.store.setState({ jobId: approvedJob.jobId, owner, state: "inventory" });
    await h.store.propose({
      jobId: approvedJob.jobId,
      owner,
      proposal: proposal({
        jobId: approvedJob.jobId,
        originalId: approvedJob.originalId,
        originalSha256: approvedJob.originalSha256,
        format: "docx",
        representationId: opaque(6),
        representationSha256: sha("e"),
        proposalDigest: sha("f"),
      }),
    });
    const approval = await h.store.approve({ jobId: approvedJob.jobId, owner });

    await expect(h.store.reconcile()).resolves.toBe(1);
    await expect(h.store.job(activeJob.jobId)).resolves.toMatchObject({ state: "failed" });
    await expect(h.store.job(approvedJob.jobId)).resolves.toMatchObject({ state: "approved" });
    await expect(h.store.approvalFor(opaque(6))).resolves.toEqual(approval);
  });
});
