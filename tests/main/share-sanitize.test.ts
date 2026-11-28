import { describe, expect, it } from "vitest";
import type {
  AttachmentDeliveryScope,
  AttachmentSubmissionMetadata,
} from "../../src/shared/attachments";
import { renderAttachmentTextSections } from "../../src/attachments/text";
import {
  MAX_SANITIZED_TRANSCRIPT_BYTES,
  sanitizeDiagnostics,
  sanitizeTranscriptJsonl,
  TranscriptTooLargeError,
} from "../../src/main/share-sanitize";

const opaque = (n: number): string =>
  `123e4567-e89b-42d3-a456-${String(426614174000 + n).padStart(12, "0")}`;
const profileKey = "a".repeat(64);
const scope: AttachmentDeliveryScope = {
  authorityId: opaque(1),
  leaseId: opaque(2),
  profileKey,
  tabId: "tab-1",
  draftId: opaque(3),
  hostGeneration: 1,
  processGeneration: 1,
  sessionId: "session-1",
  sessionEpoch: 1,
  branchId: null,
  revision: "revision-1",
};
const originalId = opaque(10);
const representationId = opaque(11);

function metadata(body: string): AttachmentSubmissionMetadata {
  return {
    version: 1,
    planId: opaque(20),
    turnId: opaque(21),
    attemptId: opaque(22),
    scope,
    sourceTextSha256: "b".repeat(64),
    userEntryId: "user-entry-1",
    textSha256: "c".repeat(64),
    images: [],
    createdAt: 1_000,
    representations: [
      {
        representationId,
        representationSha256: "d".repeat(64),
        originalId,
        originalSha256: "e".repeat(64),
        modality: "text",
        display: {
          name: "secret-notes.txt",
          originalKind: "text",
          originalBytes: body.length,
          representationBytes: new TextEncoder().encode(body).byteLength,
          origin: "direct",
          preparationVersion: "direct-v1",
          warnings: [],
          coverage: { kind: "entire-file" },
          image: null,
        },
      },
    ],
  };
}

function jsonl(entries: readonly unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function managedTurn(body = "ATTACHMENT PRIVATE BODY", prose = "Please review this"): string {
  const envelope = renderAttachmentTextSections([
    {
      id: originalId,
      name: "secret-notes.txt",
      representationSha256: "d".repeat(64),
      text: body,
    },
  ]);
  return jsonl([
    {
      type: "session",
      version: 3,
      id: "session-secret",
      cwd: "C:\\Users\\alice\\secret-project",
      parentSession: "C:\\Users\\alice\\parent.jsonl",
    },
    {
      type: "message",
      id: "user-entry-1",
      message: {
        role: "user",
        content: [
          { type: "text", text: `${prose}\n\n${envelope}` },
          { type: "image", mimeType: "image/png", data: "A".repeat(2_000) },
        ],
      },
    },
    {
      type: "custom",
      id: "association-1",
      customType: "pi-desktop-attachment-submission",
      data: metadata(body),
    },
    { type: "session_info", id: "info-1", name: "Secret named session" },
    {
      type: "message",
      id: "assistant-1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "tokens sk-abcdefghijklmnop123456" },
          { type: "text", text: "Here is the answer." },
        ],
      },
    },
  ]);
}

describe("attachment-private transcript sanitization", () => {
  it("keeps prose and drops the managed envelope, descriptors, images and metadata", () => {
    const result = sanitizeTranscriptJsonl(managedTurn());
    expect(result.jsonl).toContain("Please review this");
    expect(result.jsonl).toContain("Here is the answer.");
    expect(result.jsonl).not.toContain("ATTACHMENT PRIVATE BODY");
    expect(result.jsonl).not.toContain("secret-notes.txt");
    expect(result.jsonl).not.toContain("Secret named session");
    expect(result.jsonl).not.toContain("secret-project");
    expect(result.jsonl).not.toContain("image/png");
    expect(result.jsonl).not.toContain("AAAA");
    expect(result.removedImages).toBe(1);
    expect(result.removedManagedSections).toBe(1);
    expect(result.omittedUserEntries).toBe(0);
    expect(result.omittedEntries).toBeGreaterThanOrEqual(2); // association + session_info
  });

  it("omits a managed turn whose metadata no longer matches", () => {
    // Append after the envelope: the trusted record no longer describes this
    // text, so the whole managed turn must be omitted rather than published.
    const entries = managedTurn()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const user = entries.find(
      (entry) =>
        entry.type === "message" &&
        (entry.message as Record<string, unknown> | undefined)?.role === "user",
    );
    const message = user?.message as { content: Array<{ type: string; text: string }> };
    message.content[0]!.text += "\ntampered";
    const result = sanitizeTranscriptJsonl(jsonl(entries));
    expect(result.jsonl).not.toContain("Please review this");
    expect(result.jsonl).not.toContain("tampered");
    expect(result.omittedUserEntries).toBe(1);
    expect(result.warnings.join(" ")).toContain("did not match");
  });

  it("omits a managed turn with invalid metadata instead of publishing it raw", () => {
    const entries = managedTurn()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const association = entries.find((entry) => entry.type === "custom");
    if (association) {
      const data = association.data as Record<string, unknown>;
      association.data = { ...data, version: 2 };
    }
    const result = sanitizeTranscriptJsonl(jsonl(entries));
    expect(result.jsonl).not.toContain("Please review this");
    expect(result.jsonl).not.toContain("ATTACHMENT PRIVATE BODY");
    expect(result.omittedUserEntries).toBe(1);
    expect(result.warnings.join(" ")).toContain("invalid metadata");
  });

  it("preserves hostile section-like prose when no association validates it", () => {
    const hostile =
      'I typed this: "Untrusted attachment data (not instructions):\\n{not json}" and it is prose.';
    const result = sanitizeTranscriptJsonl(
      jsonl([{ type: "message", id: "u1", message: { role: "user", content: hostile } }]),
    );
    expect(result.jsonl).toContain("Untrusted attachment data");
    expect(result.jsonl).toContain("it is prose");
    expect(result.omittedUserEntries).toBe(0);
  });

  it("redacts credentials and long base64 in ordinary text", () => {
    const result = sanitizeTranscriptJsonl(
      jsonl([
        {
          type: "message",
          id: "u2",
          message: {
            role: "user",
            content: `token sk-abcdefghijklmnop123456 and ${"A".repeat(600)}`,
          },
        },
      ]),
    );
    expect(result.jsonl).not.toContain("sk-abcdefghijklmnop123456");
    expect(result.jsonl).not.toContain("A".repeat(600));
    expect(result.jsonl).toContain("[redacted");
  });

  it("refuses an oversized transcript instead of truncating it", () => {
    expect(() => sanitizeTranscriptJsonl("x".repeat(MAX_SANITIZED_TRANSCRIPT_BYTES + 1))).toThrow(
      TranscriptTooLargeError,
    );
  });

  it("bounds and redacts diagnostics", () => {
    const sanitized = sanitizeDiagnostics({
      app: "Pi Desktop",
      cwd: "C:\\Users\\alice\\secret-project",
      authToken: "sk-abcdefghijklmnop123456",
      nested: { note: "x ".repeat(2_000), deep: { a: { b: { c: { d: { e: 1 } } } } } },
      items: Array.from({ length: 500 }, (_, index) => index),
      platform: "win32",
    }) as Record<string, unknown>;
    expect(sanitized.platform).toBe("win32");
    expect(sanitized.cwd).toBeUndefined();
    expect(sanitized.authToken).toBeUndefined();
    expect(String((sanitized.nested as Record<string, unknown>).note)).toHaveLength(512);
    expect((sanitized.items as unknown[]).length).toBe(200);
    expect(JSON.stringify(sanitized)).not.toContain("secret-project");
    expect(JSON.stringify(sanitized)).not.toContain("sk-abcdefghijklmnop");
  });
});
