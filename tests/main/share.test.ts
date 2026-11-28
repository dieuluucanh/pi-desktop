import { normalize } from "node:path";
import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import {
  bugReportEntries,
  buildBugReport,
  messagesFromJsonl,
  parseGistId,
  redactSecrets,
  shareSession,
  shareViewerUrl,
  summarizeForBugReport,
} from "../../src/main/share";
import { createMemoryFsPort } from "../../src/main/fs-port";
import { createFakeCommandRunner } from "../../src/main/office/exec";
import { renderAttachmentTextSections } from "../../src/attachments/text";

/**
 * `/share` and `/bug` (2026-10-26 session-parity plan step 18).
 *
 * The upload path must be exact: a secret gist, the viewer URL Pi builds, and a
 * redacted transcript. The zip must contain the report without ever requiring a
 * model call.
 */

const SESSION = "/profile/sessions/s1.jsonl";

function shareFs(
  raw = '{"type":"message","message":{"role":"user","content":"hi sk-abcdefghijklmnopqrst"}}\n',
) {
  return createMemoryFsPort({ files: { [SESSION]: raw }, dirs: ["/scratch"] });
}

function managedSession(): string {
  const originalId = "123e4567-e89b-42d3-a456-426614174010";
  const body = "ATTACHMENT PRIVATE BODY";
  const envelope = renderAttachmentTextSections([
    { id: originalId, name: "secret-notes.txt", representationSha256: "d".repeat(64), text: body },
  ]);
  return (
    [
      {
        type: "session",
        version: 3,
        id: "session-secret",
        cwd: "C:/Users/alice/secret-project",
      },
      {
        type: "message",
        id: "user-entry-1",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: `Please review this

${envelope}`,
            },
            { type: "image", mimeType: "image/png", data: "A".repeat(2_000) },
          ],
        },
      },
      {
        type: "custom",
        id: "association-1",
        customType: "pi-desktop-attachment-submission",
        data: {
          version: 1,
          planId: "123e4567-e89b-42d3-a456-426614174020",
          turnId: "123e4567-e89b-42d3-a456-426614174021",
          attemptId: "123e4567-e89b-42d3-a456-426614174022",
          scope: {
            authorityId: "123e4567-e89b-42d3-a456-426614174001",
            leaseId: "123e4567-e89b-42d3-a456-426614174002",
            profileKey: "a".repeat(64),
            tabId: "tab-1",
            draftId: "123e4567-e89b-42d3-a456-426614174003",
            hostGeneration: 1,
            processGeneration: 1,
            sessionId: "session-1",
            sessionEpoch: 1,
            branchId: null,
            revision: "revision-1",
          },
          sourceTextSha256: "b".repeat(64),
          userEntryId: "user-entry-1",
          textSha256: "c".repeat(64),
          images: [],
          createdAt: 1_000,
          representations: [
            {
              representationId: "123e4567-e89b-42d3-a456-426614174011",
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
        },
      },
      { type: "session_info", id: "info-1", name: "Secret named session" },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n"
  );
}

function deps(
  fs = shareFs(),
  runner = createFakeCommandRunner([
    { command: "gh", args: ["--version"], stdout: "gh version 2.63.0" },
    {
      command: "gh",
      args: ["gist", "create", "--public=false"],
      stdout: "https://gist.github.com/user/0123456789abcdef\n",
    },
  ]),
) {
  return { fs, runner, scratchDir: "/scratch", env: {}, now: () => 1700000000000 };
}

describe("share URLs", () => {
  it("builds Pi's viewer URL and honours the override", () => {
    expect(shareViewerUrl("abc123")).toBe("https://pi.dev/session/#abc123");
    expect(shareViewerUrl("abc123", { PI_SHARE_VIEWER_URL: "https://x.test/s/" })).toBe(
      "https://x.test/s/#abc123",
    );
  });

  it("extracts the id from gh's output", () => {
    expect(parseGistId("https://gist.github.com/u/0123456789abcdef")).toBe("0123456789abcdef");
    expect(parseGistId("nothing here")).toBeNull();
  });
});

describe("redaction", () => {
  it("redacts provider keys, bearer tokens and key=value secrets", () => {
    const redacted = redactSecrets(
      'key sk-abcdefghijklmnopqrst auth: Bearer abcdefghijklmnopqrstuv token="hunter2"',
    );
    expect(redacted).not.toContain("abcdefghijklmnopqrst");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain("[redacted");
  });
});

describe("shareSession", () => {
  it("uploads a redacted secret gist and returns the viewer URL", async () => {
    const context = deps();
    const result = await shareSession(context, SESSION);

    expect(result.ok).toBe(true);
    expect(result.viewerUrl).toBe("https://pi.dev/session/#0123456789abcdef");
    expect(result.gistUrl).toBe("https://gist.github.com/0123456789abcdef");

    const calls = context.runner.calls.map((call) => [call.command, [...call.args]]);
    expect(calls).toEqual([
      ["gh", ["--version"]],
      ["gh", ["gist", "create", "--public=false", "/scratch/s1-1700000000000.jsonl"]],
    ]);
    const uploaded = context.fs.files.get(normalize("/scratch/s1-1700000000000.jsonl")) ?? "";
    expect(uploaded).not.toContain("sk-abcdefghijklmnopqrst");
    expect(uploaded).toContain("[redacted key]");
  });

  it("reports a missing gh instead of failing silently", async () => {
    const runner = createFakeCommandRunner([
      { command: "gh", args: ["--version"], missing: true, code: 127 },
    ]);
    const result = await shareSession(deps(shareFs(), runner), SESSION);
    expect(result).toMatchObject({ ok: false, error: "gh_missing" });
  });

  it("reports an auth/scope failure with the hint code", async () => {
    const runner = createFakeCommandRunner([
      { command: "gh", args: ["--version"], stdout: "gh version 2" },
      {
        command: "gh",
        args: ["gist", "create"],
        code: 1,
        stderr: "You are not logged into any GitHub hosts. Run gh auth login",
      },
    ]);
    const result = await shareSession(deps(shareFs(), runner), SESSION);
    expect(result).toMatchObject({ ok: false, error: "gh_not_authenticated" });
  });

  it("refuses an empty or missing session file", async () => {
    const fs = createMemoryFsPort({});
    const result = await shareSession(deps(fs), SESSION);
    expect(result).toMatchObject({ ok: false, error: "no_file" });
  });
});

describe("bug report", () => {
  const input = {
    versions: { app: "0.1.0", electron: "39.0.0" },
    diagnostics: { runtimeProblems: [] },
    transcript:
      '{"type":"message","message":{"role":"user","content":"api key sk-abcdefghijklmnopqrst"}}\n',
    hint: "the transcript is empty",
    summary: "First request: hello",
  };

  it("includes a machine report, a summary and a redacted transcript", () => {
    const entries = bugReportEntries(input, 1700000000000);
    expect(Object.keys(entries)).toEqual(["report.json", "summary.txt", "session.jsonl"]);
    const report = JSON.parse(strFromU8(entries["report.json"]!)) as Record<string, unknown>;
    expect(report).toMatchObject({
      includesTranscript: true,
      hint: "the transcript is empty",
      versions: { app: "0.1.0" },
    });
    const summary = strFromU8(entries["summary.txt"]!);
    expect(summary).toContain("First request: hello");
    expect(summary).toContain("electron: 39.0.0");
    const transcript = strFromU8(entries["session.jsonl"]!);
    expect(transcript).not.toContain("sk-abcdefghijklmnopqrst");
  });

  it("omits the transcript when the user declines", () => {
    const entries = bugReportEntries({ ...input, transcript: null }, 1700000000000);
    expect(Object.keys(entries)).toEqual(["report.json", "summary.txt"]);
  });

  it("writes a real zip through the fs port", async () => {
    const context = deps();
    const result = await buildBugReport(context, input);
    expect(result.ok).toBe(true);
    expect(result.path).toBe("/scratch/pi-bug-report-1700000000000.zip");
    const bytes = context.fs.binary.get(normalize(result.path!));
    expect(bytes).toBeTruthy();
    const unzipped = unzipSync(bytes!);
    expect(Object.keys(unzipped).sort()).toEqual(["report.json", "session.jsonl", "summary.txt"]);
  });

  it("summarizes locally without a model call", () => {
    const summary = summarizeForBugReport([
      { role: "user", content: "please fix the parser" },
      { role: "assistant", content: [{ type: "text", text: "on it" }] },
      { role: "toolResult", content: [] },
    ]);
    expect(summary).toContain("please fix the parser");
    expect(summary).toContain("Messages: 3");
  });

  it("reads messages out of a Pi JSONL file, skipping corrupt lines", () => {
    const text = [
      '{"type":"session_info","name":"x"}',
      '{"type":"message","message":{"role":"user","content":"one"}}',
      "not json",
      '{"type":"message","message":{"role":"assistant","content":"two"}}',
    ].join("\n");
    const messages = messagesFromJsonl(text) as Array<{ role: string }>;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("uploads only the attachment-private projection, never the managed envelope", async () => {
    const raw = managedSession();
    const context = deps(shareFs(raw));
    const result = await shareSession(context, SESSION);
    expect(result.ok).toBe(true);
    expect(result.file).toBeTruthy();
    const written = context.fs.files.get(normalize(result.file!)) ?? "";
    expect(written).toContain("Please review this");
    expect(written).not.toContain("ATTACHMENT PRIVATE BODY");
    expect(written).not.toContain("secret-notes.txt");
    expect(written).not.toContain("image/png");
    expect(written).not.toContain("Secret named session");
  });

  it("keeps attachment content, images, names and descriptors out of every zip entry", async () => {
    const entries = bugReportEntries(
      {
        versions: { app: "0.1.0" },
        diagnostics: { runtimeProblems: [], cwd: "C:/Users/alice/secret-project" },
        transcript: managedSession(),
        hint: null,
        summary: "First request: Please review this\nMessages: 2.",
      },
      1700000000000,
    );
    const decoded = Object.fromEntries(
      Object.entries(entries).map(([name, bytes]) => [name, strFromU8(bytes)]),
    );
    for (const [name, text] of Object.entries(decoded)) {
      expect(text, name).not.toContain("ATTACHMENT PRIVATE BODY");
      expect(text, name).not.toContain("secret-notes.txt");
      expect(text, name).not.toContain("image/png");
      expect(text, name).not.toContain("Secret named session");
      expect(text, name).not.toContain("secret-project");
      expect(text, name).not.toContain("AAAAAAAA");
    }
    const report = JSON.parse(decoded["report.json"]!) as {
      attachmentPrivacy: Record<string, unknown>;
      includesTranscript: boolean;
    };
    expect(report.includesTranscript).toBe(true);
    expect(report.attachmentPrivacy).toMatchObject({
      originals: false,
      inlineImages: false,
      managedText: false,
      names: false,
    });
    expect(decoded["summary.txt"]).toContain("Attachments:");
  });
});
