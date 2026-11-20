import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAttachmentSubmissionJournal,
  createNodeAttachmentSubmissionJournalIo,
  type AttachmentSubmissionJournalBeginInput,
  type AttachmentSubmissionJournalIo,
} from "../../src/main/attachment-submission-journal";
import type {
  AttachmentDeliveryScope,
  AttachmentPromptResult,
  AttachmentSubmissionAssociation,
  AuthorizedAttachmentAsset,
} from "../../src/shared/attachments";

const id = (n: number): string =>
  `123e4567-e89b-42d3-a456-${String(426614174000 + n).padStart(12, "0")}`;
const PROFILE = "a".repeat(64);
const ROOT = "/app-user-data/attachments";
const scope: AttachmentDeliveryScope = {
  authorityId: id(1),
  leaseId: id(2),
  profileKey: PROFILE,
  tabId: "tab-1",
  draftId: id(3),
  hostGeneration: 4,
  processGeneration: 8,
  sessionId: "session-1",
  sessionEpoch: 3,
  branchId: null,
  revision: "revision-1",
};

function textAsset(): AuthorizedAttachmentAsset {
  const bytes = new TextEncoder().encode("private representation");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const originalId = id(10);
  return {
    original: {
      id: originalId,
      name: "private-note.txt",
      kind: "text",
      bytes: bytes.length,
      sha256: digest,
    },
    representation: {
      id: id(11),
      attachmentId: originalId,
      modality: "text",
      origin: "direct",
      bytes: bytes.length,
      originalSha256: digest,
      representationSha256: digest,
      preparationVersion: "test-direct-v1",
      approved: true,
      warnings: [],
    },
    image: null,
    approvalDigest: null,
  };
}

function request(overrides: Partial<AttachmentSubmissionJournalBeginInput> = {}) {
  return {
    planId: id(20),
    turnId: id(21),
    attemptId: id(22),
    scope,
    sourceText: "do not persist this prompt",
    assets: [textAsset()],
    ...overrides,
  } satisfies AttachmentSubmissionJournalBeginInput;
}

function memoryIo(initial?: { path: string; contents: string }) {
  const files = new Map<string, string>();
  const writes: Array<{ path: string; contents: string }> = [];
  if (initial) files.set(initial.path, initial.contents);
  let failWrites = false;
  const io: AttachmentSubmissionJournalIo = {
    async readText(path) {
      return files.get(path) ?? null;
    },
    async writeAtomic(path, contents) {
      if (failWrites) throw new Error("disk full");
      writes.push({ path, contents });
      files.set(path, contents);
    },
  };
  return {
    io,
    files,
    writes,
    failWrites(value: boolean) {
      failWrites = value;
    },
  };
}

function harness(
  initial?: { path: string; contents: string },
  now = 1_000,
  sharedDisk?: ReturnType<typeof memoryIo>,
) {
  const disk = sharedDisk ?? memoryIo(initial);
  const journal = createAttachmentSubmissionJournal({
    root: ROOT,
    profileKey: PROFILE,
    io: disk.io,
    now: () => now,
  });
  return { ...disk, journal, path: join(ROOT, "submissions", `${PROFILE}.json`) };
}

function associationFor(
  entry: Awaited<ReturnType<ReturnType<typeof harness>["journal"]["get"]>> & object,
): AttachmentSubmissionAssociation {
  if (!entry) throw new Error("journal entry missing");
  return {
    associationEntryId: "association-entry-1",
    metadata: {
      version: 1,
      planId: entry.planId,
      turnId: entry.turnId,
      attemptId: entry.attemptId,
      scope: entry.scope,
      sourceTextSha256: entry.sourceTextSha256,
      userEntryId: "user-entry-1",
      textSha256: "b".repeat(64),
      images: entry.images,
      representations: entry.representations,
      createdAt: 1_000,
    },
  };
}

function acceptedResult(
  entry: NonNullable<Awaited<ReturnType<ReturnType<typeof harness>["journal"]["get"]>>>,
): AttachmentPromptResult {
  return {
    outcome: "accepted",
    turnId: entry.turnId,
    attemptId: entry.attemptId,
    userEntryId: "user-entry-1",
    associationEntryId: "association-entry-1",
  };
}

/** The real host association also carries renderer-only display metadata. */
function withDisplay(
  association: AttachmentSubmissionAssociation,
): AttachmentSubmissionAssociation {
  return {
    ...association,
    metadata: {
      ...association.metadata,
      representations: association.metadata.representations.map((representation) => ({
        ...representation,
        display: {
          name: "private-note.txt",
          originalKind: "text" as const,
          originalBytes: 26,
          representationBytes: 26,
          origin: "direct" as const,
          preparationVersion: "test-direct-v1",
          warnings: [],
          coverage: { kind: "entire-file" as const },
          image: null,
        },
      })),
    },
  };
}

describe("app-owned attachment submission journal", () => {
  it("atomically records a bounded dispatch intent without source content or filenames", async () => {
    const h = harness();
    const result = await h.journal.begin(request());
    expect(result.kind).toBe("dispatch");
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]?.path).toBe(h.path);
    expect(h.writes[0]?.contents).toContain('"state":"dispatching"');
    expect(h.writes[0]?.contents).not.toContain("do not persist this prompt");
    expect(h.writes[0]?.contents).not.toContain("private-note.txt");
    expect(h.writes[0]?.contents).not.toContain("private representation");
  });

  it("deduplicates exact attempt IDs and rejects identity reuse for different content", async () => {
    const h = harness();
    const first = await h.journal.begin(request());
    const replay = await h.journal.begin(request());
    const conflict = await h.journal.begin(request({ sourceText: "different prompt" }));
    expect(first.kind).toBe("dispatch");
    expect(replay.kind).toBe("existing");
    expect(conflict.kind).toBe("conflict");
    expect(h.writes).toHaveLength(1);
  });

  it("serializes concurrent double-click attempts so only one may dispatch", async () => {
    const h = harness();
    const [first, second] = await Promise.all([
      h.journal.begin(request()),
      h.journal.begin(request()),
    ]);
    expect([first.kind, second.kind].sort()).toEqual(["dispatch", "existing"]);
    expect(h.writes).toHaveLength(1);
  });

  it("blocks duplicate turn IDs unless the previous outcome is explicitly retried", async () => {
    const h = harness();
    const firstRequest = request();
    const first = await h.journal.begin(firstRequest);
    if (first.kind !== "dispatch") throw new Error("expected initial dispatch");
    const duplicate = await h.journal.begin(request({ attemptId: id(23), explicitRetry: false }));
    expect(duplicate.kind).toBe("conflict");
    await h.journal.complete(firstRequest.turnId, firstRequest.attemptId, {
      outcome: "uncertain",
      turnId: firstRequest.turnId,
      attemptId: firstRequest.attemptId,
    });
    const retry = await h.journal.begin(request({ attemptId: id(23), explicitRetry: true }));
    expect(retry.kind).toBe("dispatch");
    if (retry.kind === "dispatch")
      expect(retry.entry.retryOfAttemptId).toBe(firstRequest.attemptId);
  });

  it("persists handled and blocked dispositions without automatic retry", async () => {
    const h = harness();
    const dispositions = [
      {
        turnId: id(31),
        attemptId: id(32),
        result: { outcome: "handled" as const, turnId: id(31), attemptId: id(32) },
      },
      {
        turnId: id(33),
        attemptId: id(34),
        result: {
          outcome: "blocked" as const,
          reasons: ["busy"] as const,
          turnId: id(33),
          attemptId: id(34),
        },
      },
    ];
    for (const disposition of dispositions) {
      const input = request({ turnId: disposition.turnId, attemptId: disposition.attemptId });
      const begun = await h.journal.begin(input);
      if (begun.kind !== "dispatch") throw new Error("expected initial dispatch");
      await h.journal.complete(input.turnId, input.attemptId, disposition.result);
      const persisted = await h.journal.get(input.turnId, input.attemptId);
      expect(persisted).toMatchObject({
        state: disposition.result.outcome,
        result: disposition.result,
      });
      const automaticRetry = await h.journal.begin(
        request({ turnId: input.turnId, attemptId: id(35) }),
      );
      expect(automaticRetry.kind).toBe("conflict");
    }
  });

  it("recovers a persisted SDK association after a crash before the app acknowledgement", async () => {
    const firstProcess = harness();
    const begun = await firstProcess.journal.begin(request());
    if (begun.kind !== "dispatch") throw new Error("expected initial dispatch");
    const secondProcess = harness(undefined, 2_000, firstProcess);
    // Process/lease generations change on restart, but a matching persisted
    // association remains bound to the original full session/branch scope.
    const resumedScope = {
      ...scope,
      authorityId: id(40),
      leaseId: id(41),
      hostGeneration: 9,
      processGeneration: 10,
      sessionEpoch: 4,
    };
    await secondProcess.journal.reconcile(resumedScope, [associationFor(begun.entry)]);
    const recovered = await secondProcess.journal.get(begun.entry.turnId, begun.entry.attemptId);
    expect(recovered).toMatchObject({ state: "accepted", result: acceptedResult(begun.entry) });
  });

  it("preserves a late accepted association when an explicit retry is already journaled", async () => {
    const h = harness();
    const firstInput = request();
    const first = await h.journal.begin(firstInput);
    if (first.kind !== "dispatch") throw new Error("expected initial dispatch");
    await h.journal.complete(firstInput.turnId, firstInput.attemptId, {
      outcome: "uncertain",
      turnId: firstInput.turnId,
      attemptId: firstInput.attemptId,
    });
    const retryInput = request({ attemptId: id(23), explicitRetry: true });
    const retry = await h.journal.begin(retryInput);
    if (retry.kind !== "dispatch") throw new Error("expected explicit retry");
    await h.journal.reconcile(scope, [associationFor(first.entry)]);
    const recoveredFirst = await h.journal.get(firstInput.turnId, firstInput.attemptId);
    const pendingRetry = await h.journal.get(retryInput.turnId, retryInput.attemptId);
    expect(recoveredFirst?.state).toBe("accepted");
    expect(pendingRetry).toMatchObject({
      state: "dispatching",
      retryOfAttemptId: firstInput.attemptId,
    });
  });

  it("turns an unacknowledged dispatch into uncertain after restart and never resends it", async () => {
    const firstProcess = harness();
    const begun = await firstProcess.journal.begin(request());
    if (begun.kind !== "dispatch") throw new Error("expected initial dispatch");
    const restarted = harness(undefined, 2_000, firstProcess);
    await expect(restarted.journal.list()).resolves.toMatchObject([{ state: "uncertain" }]);
    const sameAttempt = await restarted.journal.begin(request());
    expect(sameAttempt.kind).toBe("existing");
    if (sameAttempt.kind === "existing") expect(sameAttempt.entry.state).toBe("uncertain");
    const retryWithoutConsent = await restarted.journal.begin(request({ attemptId: id(23) }));
    expect(retryWithoutConsent.kind).toBe("conflict");
  });

  it("does not reconcile association metadata from another branch or delivery scope", async () => {
    const firstProcess = harness();
    const begun = await firstProcess.journal.begin(request());
    if (begun.kind !== "dispatch") throw new Error("expected initial dispatch");
    const restarted = harness(undefined, 2_000, firstProcess);
    const proof = associationFor(begun.entry);
    const wrongBranchProof: AttachmentSubmissionAssociation = {
      ...proof,
      metadata: { ...proof.metadata, scope: { ...proof.metadata.scope, branchId: "branch-other" } },
    };
    await restarted.journal.reconcile(scope, [wrongBranchProof]);
    const recovered = await restarted.journal.get(begun.entry.turnId, begun.entry.attemptId);
    expect(recovered?.state).toBe("uncertain");
  });

  it("requires an exact persisted association as proof before accepting", async () => {
    const h = harness();
    const begun = await h.journal.begin(request());
    if (begun.kind !== "dispatch") throw new Error("expected initial dispatch");
    const accepted = acceptedResult(begun.entry);
    await expect(
      h.journal.complete(begun.entry.turnId, begun.entry.attemptId, accepted),
    ).rejects.toThrow(/journal/);
    const proof = associationFor(begun.entry);
    await h.journal.complete(begun.entry.turnId, begun.entry.attemptId, accepted, proof);
    const persisted = await h.journal.get(begun.entry.turnId, begun.entry.attemptId);
    expect(persisted).toMatchObject({ state: "accepted", result: accepted });
  });

  it("matches real host associations that carry display metadata", async () => {
    const firstProcess = harness();
    const begun = await firstProcess.journal.begin(request());
    if (begun.kind !== "dispatch") throw new Error("expected initial dispatch");
    // Recovered after restart; the SDK association includes renderer display
    // fields that the journal deliberately does not store.
    const restarted = harness(undefined, 2_000, firstProcess);
    const proof = withDisplay(associationFor(begun.entry));
    await restarted.journal.reconcile(scope, [proof]);
    const recovered = await restarted.journal.get(begun.entry.turnId, begun.entry.attemptId);
    expect(recovered).toMatchObject({ state: "accepted", result: acceptedResult(begun.entry) });
    // A normal (not explicit) retry still cannot resend an accepted turn.
    expect((await restarted.journal.begin(request({ attemptId: id(23) }))).kind).toBe("conflict");
  });

  it("rejects proof whose representation order or digests changed", async () => {
    const h = harness();
    const begun = await h.journal.begin(request());
    if (begun.kind !== "dispatch") throw new Error("expected initial dispatch");
    const proof = associationFor(begun.entry);
    const reordered: AttachmentSubmissionAssociation = {
      ...proof,
      metadata: {
        ...proof.metadata,
        representations: proof.metadata.representations.map((representation) => ({
          ...representation,
          representationSha256: "c".repeat(64),
        })),
      },
    };
    await h.journal.reconcile(scope, [reordered]);
    const stillDispatching = await h.journal.get(begun.entry.turnId, begun.entry.attemptId);
    expect(stillDispatching?.state).toBe("dispatching");
    await expect(
      h.journal.complete(
        begun.entry.turnId,
        begun.entry.attemptId,
        acceptedResult(begun.entry),
        reordered,
      ),
    ).rejects.toThrow(/journal/);
  });

  it("releases an in-flight marker when completion fails so recovery is not pinned", async () => {
    const h = harness();
    const begun = await h.journal.begin(request());
    if (begun.kind !== "dispatch") throw new Error("expected initial dispatch");
    h.failWrites(true);
    await expect(
      h.journal.complete(begun.entry.turnId, begun.entry.attemptId, {
        outcome: "uncertain",
        turnId: begun.entry.turnId,
        attemptId: begun.entry.attemptId,
      }),
    ).rejects.toThrow(/journal/);
    h.failWrites(false);
    // The marker is gone, so the surviving dispatching record normalizes to
    // uncertain instead of blocking reconcile/retry for the process lifetime.
    await expect(h.journal.list()).resolves.toMatchObject([{ state: "uncertain" }]);
  });

  it("does not overwrite a malformed journal and fails closed on persistence errors", async () => {
    const path = join(ROOT, "submissions", `${PROFILE}.json`);
    const malformed = harness({ path, contents: "{" });
    await expect(malformed.journal.begin(request())).rejects.toThrow(/journal/);
    expect(malformed.writes).toHaveLength(0);
    const oversized = harness({ path, contents: "x".repeat(2 * 1024 * 1024 + 1) });
    await expect(oversized.journal.list()).rejects.toThrow(/journal/);
    expect(oversized.writes).toHaveLength(0);

    const failing = harness();
    failing.failWrites(true);
    await expect(failing.journal.begin(request())).rejects.toThrow(/journal/);
    expect(failing.files.size).toBe(0);
  });

  it("uses a private same-directory atomic file for the production journal adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-attachment-journal-"));
    try {
      const journal = createAttachmentSubmissionJournal({
        root,
        profileKey: PROFILE,
        io: createNodeAttachmentSubmissionJournalIo(),
        now: () => 1_000,
      });
      const begun = await journal.begin(request());
      expect(begun.kind).toBe("dispatch");
      const directory = join(root, "submissions");
      const files = await readdir(directory);
      expect(files).toEqual([`${PROFILE}.json`]);
      const contents = await readFile(join(directory, files[0]!), "utf8");
      expect(contents).toContain('"state":"dispatching"');
      expect(contents).not.toContain("do not persist this prompt");
      await writeFile(join(directory, "linked.json"), "{}");
      await expect(journal.list()).resolves.toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never retries an accepted turn, even when explicit retry was requested", async () => {
    const h = harness();
    const begun = await h.journal.begin(request());
    if (begun.kind !== "dispatch") throw new Error("expected initial dispatch");
    const proof = associationFor(begun.entry);
    await h.journal.reconcile(scope, [proof]);
    const retry = await h.journal.begin(request({ attemptId: id(23), explicitRetry: true }));
    expect(retry.kind).toBe("conflict");
  });
});
