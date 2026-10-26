/**
 * `/share` and `/bug` (2026-10-26 session-parity plan step 18).
 *
 * Terminal Pi uploads a session as a **secret** gist and opens the viewer URL,
 * and builds a bug-report zip (optionally uploaded to Radius). This module is
 * the Electron-free policy behind both: it owns the exact `gh` arguments, the
 * viewer URL, the redaction rules and the zip layout, so a fake filesystem and a
 * fake command runner fully cover it.
 *
 * Secret gists are **unlisted, not private**: anyone with the URL can read them.
 * The caller shows that sentence before uploading.
 */

import { zipSync, strToU8 } from "fflate";
import type { CommandRunner } from "./office/exec";
import type { FsPort } from "./fs-port";

/** The viewer base Pi uses; `PI_SHARE_VIEWER_URL` overrides it. */
export const DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/";

export function shareViewerUrl(
  gistId: string,
  env: Record<string, string | undefined> = {},
): string {
  const base = env.PI_SHARE_VIEWER_URL?.trim();
  return `${base && base.length > 0 ? base : DEFAULT_SHARE_VIEWER_URL}#${gistId}`;
}

/** Extracts the gist id from `gh gist create` output (it prints the URL). */
export function parseGistId(output: string): string | null {
  const match = /gist\.github\.com\/(?:[\w.-]+\/)?([0-9a-f]{8,})/i.exec(output);
  return match?.[1] ?? null;
}

/**
 * Redacts the shapes a transcript usually leaks: provider keys, bearer tokens,
 * GitHub tokens and long base64-ish blobs that look like credentials.
 */
export function redactSecrets(text: string): string {
  let redacted = text;
  const patterns: Array<[RegExp, string]> = [
    [/\b(sk-[A-Za-z0-9_-]{16,})/g, "[redacted key]"],
    [/\b(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{16,}/g, "[redacted github token]"],
    [/\b(Bearer\s+)[A-Za-z0-9._-]{16,}/gi, "$1[redacted]"],
    [/\b(xox[baprs]-[A-Za-z0-9-]{10,})/g, "[redacted slack token]"],
    [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted aws key]"],
    [
      /\b(api[_-]?key|token|secret|password|authorization)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi,
      "$1$2[redacted]",
    ],
  ];
  for (const [pattern, replacement] of patterns) redacted = redacted.replace(pattern, replacement);
  return redacted;
}

export interface ShareResult {
  ok: boolean;
  /** The gist page (for the user to delete/rotate). */
  gistUrl?: string;
  /** The viewer URL Pi's terminal opens. */
  viewerUrl?: string;
  /** The local file that was uploaded, kept for "show me the file". */
  file?: string;
  /** Stable codes so the renderer can pick the right message. */
  error?: "gh_missing" | "gh_not_authenticated" | "gh_failed" | "no_file" | "fs_failed";
  detail?: string;
}

export interface ShareDeps {
  fs: FsPort;
  runner: CommandRunner;
  /** A writable scratch directory (the app's blob/temp area). */
  scratchDir: string;
  env?: Record<string, string | undefined>;
  /** Injected for tests; the command runner's default is too short? (Not for gh.) */
  now?: () => number;
}

/** `gh gist create` refuses more than one file with the same base name; keep it simple. */
function shareFileName(sessionFile: string, now: number): string {
  const base = sessionFile.split(/[\\/]/).pop() ?? "session.jsonl";
  const stem = base.replace(/\.jsonl$/i, "").slice(0, 60) || "session";
  return `${stem}-${now}.jsonl`;
}

/**
 * Copies the session JSONL into the scratch area (redacted), uploads it as a
 * secret gist and returns the viewer URL.
 */
export async function shareSession(deps: ShareDeps, sessionFile: string): Promise<ShareResult> {
  const raw = await deps.fs.readTextFile(sessionFile);
  if (raw === null || raw.length === 0) return { ok: false, error: "no_file" };
  const fileName = shareFileName(sessionFile, (deps.now ?? Date.now)());
  const file = `${deps.scratchDir}/${fileName}`;
  try {
    await deps.fs.ensureDir(deps.scratchDir);
    await deps.fs.writeTextFile(file, redactSecrets(raw));
  } catch (error) {
    return { ok: false, error: "fs_failed", detail: String(error) };
  }

  const version = await deps.runner.run("gh", ["--version"], { timeoutMs: 10_000 });
  if (version.missing) return { ok: false, error: "gh_missing" };

  // `--public=false` is explicit: gh's default is already secret, and a change
  // in that default must not publish a transcript.
  const created = await deps.runner.run("gh", ["gist", "create", "--public=false", file], {
    timeoutMs: 60_000,
  });
  if (created.code !== 0) {
    const combined = `${created.stdout}\n${created.stderr}`;
    if (/auth|login|scope/i.test(combined)) {
      return { ok: false, error: "gh_not_authenticated", detail: combined.trim() };
    }
    return { ok: false, error: "gh_failed", detail: combined.trim() };
  }
  const gistId = parseGistId(created.stdout) ?? parseGistId(created.stderr);
  if (!gistId) return { ok: false, error: "gh_failed", detail: created.stdout.trim() };
  return {
    ok: true,
    gistUrl: `https://gist.github.com/${gistId}`,
    viewerUrl: shareViewerUrl(gistId, deps.env ?? {}),
    file,
  };
}

// ---------------------------------------------------------------------------
// Bug report
// ---------------------------------------------------------------------------

export interface BugReportInput {
  /** App / Electron / Node / Pi versions, as the diagnostics view shows them. */
  versions: Record<string, string | null | undefined>;
  /** Free-form diagnostics (runtime problems, host state, …). */
  diagnostics?: unknown;
  /** The session JSONL contents, when the user consents to sharing it. */
  transcript?: string | null;
  /** What the user was doing (the `/bug <hint>` argument). */
  hint?: string | null;
  /** A local, non-LLM summary: first message + counts + model. */
  summary: string;
}

export interface BugReportResult {
  ok: boolean;
  path?: string;
  bytes?: number;
  error?: string;
}

/** The zip's file list, in a stable order so a test can assert it. */
export function bugReportEntries(
  input: BugReportInput,
  now = Date.now(),
): Record<string, Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  const report = {
    createdAt: new Date(now).toISOString(),
    versions: input.versions,
    hint: input.hint ?? null,
    summary: input.summary,
    diagnostics: input.diagnostics ?? null,
    includesTranscript: typeof input.transcript === "string" && input.transcript.length > 0,
  };
  entries["report.json"] = strToU8(JSON.stringify(report, null, 2));
  entries["summary.txt"] = strToU8(
    [
      `Pi Desktop bug report — ${new Date(now).toISOString()}`,
      "",
      input.summary,
      "",
      input.hint ? `What happened: ${input.hint}` : "",
      "",
      Object.entries(input.versions)
        .map(([key, value]) => `${key}: ${value ?? "unknown"}`)
        .join("\n"),
    ]
      .filter((line, index, lines) => line.length > 0 || lines[index - 1] !== "")
      .join("\n"),
  );
  if (typeof input.transcript === "string" && input.transcript.length > 0) {
    // The transcript is redacted: a bug report is uploaded, so it leaves the machine.
    entries["session.jsonl"] = strToU8(redactSecrets(input.transcript));
  }
  return entries;
}

export async function buildBugReport(
  deps: ShareDeps,
  input: BugReportInput,
): Promise<BugReportResult> {
  const now = (deps.now ?? Date.now)();
  try {
    await deps.fs.ensureDir(deps.scratchDir);
    const zip = zipSync(bugReportEntries(input, now), { level: 6 });
    const path = `${deps.scratchDir}/pi-bug-report-${now}.zip`;
    await deps.fs.writeBinaryFile(path, zip);
    return { ok: true, path, bytes: zip.length };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/**
 * A local, non-LLM summary (the plan forbids a model call here): the first user
 * message, the counts and the model. It is what the report shows without the
 * transcript.
 */
export function summarizeForBugReport(messages: readonly unknown[]): string {
  const records = messages as Array<Record<string, unknown>>;
  const firstUser = records.find((message) => message.role === "user");
  const content = firstUser?.content;
  const firstText =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((block) => {
              const record = block as Record<string, unknown>;
              return record.type === "text" ? String(record.text ?? "") : "";
            })
            .join(" ")
        : "";
  const assistant = records.filter((message) => message.role === "assistant").length;
  const tools = records.filter((message) => message.role === "toolResult").length;
  return [
    firstText.length > 0 ? `First request: ${firstText.slice(0, 300)}` : "No user message yet.",
    `Messages: ${records.length} (assistant ${assistant}, tool results ${tools}).`,
  ].join("\n");
}

/**
 * The messages inside a Pi session JSONL. Each line is an entry; message entries
 * carry the message in `message`, and older files store the message inline.
 * Tolerant on purpose: a bug report must still build from a damaged file.
 */
export function messagesFromJsonl(text: string): unknown[] {
  const messages: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.type === "message" && entry.message && typeof entry.message === "object") {
        messages.push(entry.message);
      } else if (typeof entry.role === "string") {
        messages.push(entry);
      }
    } catch {
      // Skip a corrupt line rather than losing the whole report.
    }
  }
  return messages;
}
