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
});
