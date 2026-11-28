import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  appendAttachmentSubmissionAssociation,
  findPersistedUserEntry,
  readAttachmentSubmissionAssociations,
  readAttachmentSubmissionHistory,
  type AttachmentSubmissionSession,
} from "../../src/host/sdk/attachment-submission";
import type {
  AttachmentDeliveryScope,
  AuthorizedAttachmentAsset,
} from "../../src/shared/attachments";

const opaque = (n: number): string =>
  `123e4567-e89b-42d3-a456-${String(426614174000 + n).padStart(12, "0")}`;
const scope: AttachmentDeliveryScope = {
  authorityId: opaque(1),
  leaseId: opaque(2),
  profileKey: "a".repeat(64),
  tabId: "tab-1",
  draftId: opaque(3),
  hostGeneration: 4,
  processGeneration: 8,
  sessionId: "session-1",
  sessionEpoch: 3,
  branchId: null,
  revision: "revision-1",
};

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function textAsset(): AuthorizedAttachmentAsset {
  const bytes = new TextEncoder().encode("managed source");
  const digest = sha256(bytes);
  const originalId = opaque(10);
  return {
    original: {
      id: originalId,
      name: "note.txt",
      kind: "text",
      bytes: bytes.length,
      sha256: digest,
    },
    representation: {
      id: opaque(11),
      attachmentId: originalId,
      modality: "text",
      origin: "direct",
      bytes: bytes.length,
      originalSha256: digest,
      representationSha256: digest,
      preparationVersion: "test-v1",
      approved: true,
      warnings: [],
    },
    image: null,
    approvalDigest: null,
  };
}

function fixture() {
  const text = "review this attachment";
  const message = { role: "user", content: [{ type: "text", text }] };
  const entries: Array<Record<string, unknown>> = [
    { type: "message", id: "user-entry-1", message },
  ];
  const sessionManager = {
    getEntryCount: () => entries.length,
    getEntries: () => [...entries],
    // The public SessionManager contract exposes both views. Recovery reads all
    // entries; transcript/display reads the active branch only.
    getBranch: () => [...entries],
    getSessionId: () => scope.sessionId,
    isPersisted: () => entries.some((entry) => entry.type === "message"),
    appendCustomEntry: (customType: string, data: unknown) => {
      const id = "association-entry-1";
      entries.push({ type: "custom", customType, data, id });
      return id;
    },
  };
  const session = { sessionManager } as unknown as AttachmentSubmissionSession;
  const assets = [textAsset()];
  const association = appendAttachmentSubmissionAssociation(session, {
    planId: opaque(20),
    turnId: opaque(21),
    attemptId: opaque(22),
    sourceTextSha256: sha256(text),
    scope,
    text,
    images: [],
    assets,
    userEntryId: "user-entry-1",
    createdAt: 1_000,
  });
  return { session, entries, message, text, association };
}

describe("SDK attachment submission associations", () => {
  it("binds metadata to the exact newly persisted user entry and reads it back", () => {
    const h = fixture();
    expect(findPersistedUserEntry(h.session, 0, h.message)).toMatchObject({
      id: "user-entry-1",
      message: h.message,
    });
    expect(findPersistedUserEntry(h.session, 1, h.message)).toBeNull();
    expect(h.association).toMatchObject({
      associationEntryId: "association-entry-1",
      metadata: {
        turnId: opaque(21),
        attemptId: opaque(22),
        userEntryId: "user-entry-1",
        sourceTextSha256: sha256(h.text),
        textSha256: sha256(h.text),
      },
    });
    expect(readAttachmentSubmissionAssociations(h.session)).toEqual([h.association]);
  });

  it("rejects a persisted user entry whose text structure no longer matches the association", () => {
    const h = fixture();
    if (!h.association) throw new Error("association fixture failed");
    h.message.content = [
      { type: "text", text: "review this " },
      { type: "text", text: "attachment" },
    ];
    expect(readAttachmentSubmissionAssociations(h.session)).toEqual([]);
  });

  it("does not append an association when the persisted user entry differs from the prompt", () => {
    const h = fixture();
    const sessionManager = h.session.sessionManager as unknown as {
      appendCustomEntry: (type: string, data: unknown) => string;
      getEntries: () => unknown[];
      isPersisted: () => boolean;
    };
    const appendCustomEntry = sessionManager.appendCustomEntry;
    let writes = 0;
    sessionManager.appendCustomEntry = (...args) => {
      writes++;
      return appendCustomEntry(...args);
    };
    h.message.content = [{ type: "text", text: "changed persisted text" }];
    const result = appendAttachmentSubmissionAssociation(h.session, {
      planId: opaque(20),
      turnId: opaque(21),
      attemptId: opaque(22),
      sourceTextSha256: sha256(h.text),
      scope,
      text: h.text,
      images: [],
      assets: [textAsset()],
      userEntryId: "user-entry-1",
      createdAt: 1_000,
    });
    expect(result).toBeNull();
    expect(writes).toBe(0);
  });

  it("keeps recovery associations from every live branch while transcript history stays branch-scoped", () => {
    const h = fixture();
    if (!h.association) throw new Error("association fixture failed");
    const sessionManager = h.session.sessionManager as unknown as {
      getEntries: () => unknown[];
      getBranch: () => unknown[];
    };
    const allEntries = sessionManager.getEntries();
    // The active branch no longer contains the old user entry (for example after
    // a fork), but another live branch still references the asset.
    sessionManager.getBranch = () => [];
    sessionManager.getEntries = () => allEntries;
    expect(readAttachmentSubmissionHistory(h.session, "branch")).toEqual([]);
    expect(readAttachmentSubmissionAssociations(h.session)).toEqual([h.association]);
    expect(readAttachmentSubmissionHistory(h.session, "all")).toHaveLength(1);
  });

  it("reads a fork's copied association although the session id differs", () => {
    const h = fixture();
    const manager = h.session.sessionManager as unknown as { getSessionId: () => string };
    manager.getSessionId = () => "forked-session";
    // Compaction/summary entries in the same branch never hide or invent a card.
    h.entries.splice(1, 0, {
      type: "compaction",
      id: "compaction-1",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const branch = readAttachmentSubmissionHistory(h.session, "branch");
    const all = readAttachmentSubmissionHistory(h.session, "all");
    expect(branch).toHaveLength(1);
    expect(all).toHaveLength(1);
    expect(branch[0]?.association.metadata.scope.sessionId).toBe(scope.sessionId);
    expect(branch[0]?.association.metadata.userEntryId).toBe("user-entry-1");
  });

  it("associates approved converted text with its document original kind", () => {
    const text = "extracted text";
    const message = { role: "user", content: [{ type: "text", text }] };
    const entries: Array<Record<string, unknown>> = [
      { type: "message", id: "user-entry-1", message },
    ];
    const sessionManager = {
      getEntryCount: () => entries.length,
      getEntries: () => [...entries],
      getBranch: () => [...entries],
      getSessionId: () => scope.sessionId,
      isPersisted: () => true,
      appendCustomEntry: (customType: string, data: unknown) => {
        entries.push({ type: "custom", customType, data, id: "association-entry-1" });
        return "association-entry-1";
      },
    };
    const session = { sessionManager } as unknown as AttachmentSubmissionSession;
    const bytes = new TextEncoder().encode(text);
    const digest = sha256(bytes);
    const original = {
      id: opaque(30),
      name: "report.pdf",
      kind: "pdf" as const,
      bytes: 100_000,
      sha256: "a".repeat(64),
    };
    const asset: AuthorizedAttachmentAsset = {
      original,
      representation: {
        id: opaque(31),
        attachmentId: original.id,
        modality: "text",
        origin: "converted",
        bytes: bytes.length,
        originalSha256: original.sha256,
        representationSha256: digest,
        preparationVersion: "pdfjs@6.5.438",
        approved: true,
        warnings: [],
      },
      image: null,
      approvalDigest: "b".repeat(64),
    };
    const association = appendAttachmentSubmissionAssociation(session, {
      planId: opaque(32),
      turnId: opaque(33),
      attemptId: opaque(34),
      sourceTextSha256: sha256(text),
      scope,
      text,
      images: [],
      assets: [asset],
      userEntryId: "user-entry-1",
      createdAt: 1_000,
    });
    expect(association?.metadata.representations[0]).toMatchObject({
      modality: "text",
      display: { originalKind: "pdf", origin: "converted" },
    });
  });
});
