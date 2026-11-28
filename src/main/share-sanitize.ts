/**
 * Attachment-private transcript sanitization for sharing and bug reports.
 *
 * Public share and bug reports leave the machine, so this is a default-deny
 * projection, not a cosmetic redaction:
 *  - inline image blocks and their base64 are removed everywhere;
 *  - SDK association entries (the managed descriptors) are removed;
 *  - a managed user turn is reduced to the user's prose only when the persisted
 *    envelope matches the trusted association exactly; an ambiguous or damaged
 *    managed turn is omitted rather than published raw;
 *  - session names, headers, cwd/paths and other entry metadata are dropped;
 *  - compaction/branch summaries and unmodeled entries are omitted;
 *  - credentials and long base64-looking runs are redacted in remaining text.
 *
 * Assistant answers and ordinary user prose may still quote attachment details;
 * the caller must say so. There is no semantic-redaction promise here.
 */

import {
  ATTACHMENT_SUBMISSION_CUSTOM_TYPE,
  validateAttachmentSubmissionMetadata,
  type AttachmentSubmissionMetadata,
} from "../shared/attachments";
import { parseAttachmentTextEnvelope } from "../shared/attachment-text-envelope";

export const MAX_SANITIZED_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_DIAGNOSTIC_DEPTH = 6;
const MAX_DIAGNOSTIC_KEYS = 200;
const MAX_DIAGNOSTIC_STRING = 512;

export interface SanitizedTranscript {
  /** A JSONL transcript safe to publish under the documented policy. */
  readonly jsonl: string;
  readonly entries: number;
  readonly messages: number;
  readonly omittedUserEntries: number;
  readonly omittedEntries: number;
  readonly removedImages: number;
  readonly removedManagedSections: number;
  readonly warnings: readonly string[];
}

export class TranscriptTooLargeError extends Error {
  constructor() {
    super("transcript exceeds the sharing limit");
    this.name = "TranscriptTooLargeError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The same credential shapes the old share path redacted. */
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

/** Remove inline data URLs and long base64-looking runs from free text. */
export function stripBinaryText(text: string): string {
  return text
    .replace(/data:[a-z0-9.+/-]+;base64,[A-Za-z0-9+/=]{32,}/gi, "[redacted inline data]")
    .replace(/\b[A-Za-z0-9+/]{512,}={0,2}\b/g, "[redacted binary data]");
}

function safeText(text: string): string {
  return stripBinaryText(redactSecrets(text));
}

interface Association {
  readonly metadata: AttachmentSubmissionMetadata;
  readonly userEntryId: string;
}

function readAssociation(value: unknown): Association | { readonly userEntryId: string } | null {
  const entry = record(value);
  if (!entry || entry.customType !== ATTACHMENT_SUBMISSION_CUSTOM_TYPE) return null;
  const data = record(entry.data);
  const userId = typeof data?.userEntryId === "string" ? data.userEntryId : null;
  const metadata = validateAttachmentSubmissionMetadata(data);
  if (!metadata) return userId ? { userEntryId: userId } : null;
  return { metadata, userEntryId: metadata.userEntryId };
}

/** Map a message's text content to sanitized blocks; drop images/tool calls. */
function sanitizeMessage(
  message: Record<string, unknown>,
  managed: Association | { readonly userEntryId: string } | null,
  stats: {
    omittedUserEntries: number;
    removedImages: number;
    removedManagedSections: number;
    warnings: string[];
  },
): Record<string, unknown> | null {
  const role = typeof message.role === "string" ? message.role : "";
  if (role.length === 0) return null;
  if (role === "assistant" && message.display === false) return null;

  const content = message.content;
  if (typeof content === "string") {
    return { role, content: safeText(content) };
  }
  if (!Array.isArray(content)) return { role };

  const blocks: Array<Record<string, unknown>> = [];
  let textBlocks = 0;
  for (const raw of content) {
    const block = record(raw);
    if (!block) continue;
    if (block.type === "image") {
      stats.removedImages++;
      continue;
    }
    if (block.type !== "text") continue;
    const text = typeof block.text === "string" ? block.text : "";
    blocks.push({ type: "text", text });
    textBlocks++;
  }

  if (managed && role === "user") {
    if (!("metadata" in managed)) {
      stats.omittedUserEntries++;
      stats.warnings.push("A managed attachment turn had invalid metadata and was omitted.");
      return null;
    }
    const expected = managed.metadata.representations.map((item) => ({
      id: item.originalId,
      name: item.display?.name,
      representationBytes: item.display?.representationBytes,
    }));
    const text = textBlocks === 1 ? String(blocks[0]?.text ?? "") : null;
    const parsed = text === null ? null : parseAttachmentTextEnvelope(text, expected);
    if (!parsed) {
      stats.omittedUserEntries++;
      stats.warnings.push("A managed attachment turn did not match its record and was omitted.");
      return null;
    }
    stats.removedManagedSections += parsed.sections.length;
    const prose = parsed.prose;
    return {
      role,
      content: prose.length > 0 ? [{ type: "text", text: safeText(prose) }] : [],
    };
  }

  const cleaned = blocks
    .map((block) => ({ type: "text", text: safeText(String(block.text ?? "")) }))
    .filter((block) => block.text.length > 0);
  return { role, content: cleaned };
}

/**
 * Project a Pi JSONL transcript into the shareable subset.
 *
 * A malformed line is skipped (the report still builds); an oversized input is
 * refused rather than truncated silently. Names/content can never forge a
 * managed boundary: only a validated association plus an exact envelope match
 * strips a section.
 */
export function sanitizeTranscriptJsonl(
  text: string,
  options: { readonly maxBytes?: number } = {},
): SanitizedTranscript {
  const maxBytes = options.maxBytes ?? MAX_SANITIZED_TRANSCRIPT_BYTES;
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new TranscriptTooLargeError();

  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const parsed: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as unknown;
      const recordValue = record(entry);
      if (recordValue) parsed.push(recordValue);
    } catch {
      // A corrupt line is skipped, never published raw.
    }
  }

  const associations = new Map<string, Association | { userEntryId: string }>();
  for (const entry of parsed) {
    if (entry.type !== "custom") continue;
    const association = readAssociation(entry);
    if (!association) continue;
    const existing = associations.get(association.userEntryId);
    if (existing) {
      // Two records for one user entry are ambiguous: omit that turn.
      associations.set(association.userEntryId, { userEntryId: association.userEntryId });
    } else {
      associations.set(association.userEntryId, association);
    }
  }

  const stats = {
    omittedUserEntries: 0,
    removedImages: 0,
    removedManagedSections: 0,
    warnings: [] as string[],
  };
  const output: Record<string, unknown>[] = [];
  let messages = 0;
  let omittedEntries = 0;
  for (const entry of parsed) {
    const type = typeof entry.type === "string" ? entry.type : "";
    if (type === "session") {
      // Keep only the schema version; id/cwd/parentSession/timestamp are metadata.
      output.push({
        type: "session",
        version: typeof entry.version === "number" ? entry.version : undefined,
      });
      continue;
    }
    if (type === "message") {
      const message = record(entry.message);
      if (!message) {
        omittedEntries++;
        continue;
      }
      const managed = typeof entry.id === "string" ? (associations.get(entry.id) ?? null) : null;
      const sanitized = sanitizeMessage(message, managed, stats);
      if (!sanitized) {
        omittedEntries++;
        continue;
      }
      output.push({ type: "message", message: sanitized });
      messages++;
      continue;
    }
    // Association descriptors, session names, compaction/branch summaries and
    // unmodeled entries are omitted by default.
    omittedEntries++;
  }

  return {
    jsonl: output.length > 0 ? `${output.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "",
    entries: lines.length,
    messages,
    omittedUserEntries: stats.omittedUserEntries,
    omittedEntries,
    removedImages: stats.removedImages,
    removedManagedSections: stats.removedManagedSections,
    warnings: stats.warnings,
  };
}

/** A bounded JSON value safe to place in a report that leaves the machine. */
export type SafeDiagnosticValue =
  string | number | boolean | null | SafeDiagnosticValue[] | { [key: string]: SafeDiagnosticValue };

/** Bounded, credential-redacted diagnostics for a report that leaves the machine. */
export function sanitizeDiagnostics(value: unknown): SafeDiagnosticValue {
  const walk = (input: unknown, depth: number): SafeDiagnosticValue => {
    if (depth > MAX_DIAGNOSTIC_DEPTH) return "[truncated]";
    if (typeof input === "string") return safeText(input).slice(0, MAX_DIAGNOSTIC_STRING);
    if (typeof input === "number" || typeof input === "boolean" || input === null) return input;
    if (Array.isArray(input)) {
      return input.slice(0, MAX_DIAGNOSTIC_KEYS).map((item) => walk(item, depth + 1));
    }
    const object = record(input);
    if (!object) return null;
    const output: { [key: string]: SafeDiagnosticValue } = {};
    let keys = 0;
    for (const [key, item] of Object.entries(object)) {
      if (keys >= MAX_DIAGNOSTIC_KEYS) break;
      if (/path|dir|file|cwd|home|token|secret|password|auth|credential/i.test(key)) continue;
      output[key] = walk(item, depth + 1);
      keys++;
    }
    return output;
  };
  return walk(value, 0);
}
