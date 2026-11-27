/**
 * The AI commit-message prompt and cleaner (2026-11-25 plan, step 14).
 *
 * Two pure functions, no Electron, no SDK and no filesystem: the git engine
 * reads a bounded `GitCommitContext` (step 15), this module turns it into a
 * prompt and turns the model's reply back into a message `git commit` accepts.
 *
 * The prompt is bounded twice: the context arrives bounded by
 * `MAX_COMMIT_CONTEXT_BYTES`, and `buildCommitMessagePrompt` still cuts the
 * patch at a line boundary so the final prompt never exceeds `MAX_PROMPT_CHARS`
 * — the wire bound `sanitizeTextGenerationRequest` enforces. The cleaner is the
 * other half: models add fences, labels and quotes even when told not to, and a
 * commit message must be plain text with a short subject.
 *
 * Bounds live next to the functions that enforce them so a test can pin them.
 */

import { MAX_COMMIT_MESSAGE, MAX_RECENT_COMMIT_SUBJECTS, type GitCommitContext } from "./git";
import { MAX_PROMPT_CHARS } from "./text-generation";

/** Longest subject line the cleaner keeps (git's own convention). */
export const COMMIT_SUBJECT_MAX = 72;
/** Most body lines the cleaner keeps. */
export const COMMIT_BODY_MAX_LINES = 6;
/** The marker the prompt carries when the patch is incomplete. */
export const PATCH_TRUNCATED_MARKER = "(patch truncated)";

/**
 * The one system prompt for the commit generator. Short because the constraint
 * list is short: a subject, a blank line, a small body, and no decoration.
 */
export const COMMIT_MESSAGE_SYSTEM =
  "You write git commit messages. Reply with only the commit message — a subject " +
  "line of at most 72 characters in the imperative mood, then a blank line and at " +
  "most 6 short body lines. No code fences, no labels, no trailers.";

/** A `--stat` is a summary, not a diff; a hostile context cannot inflate it. */
const MAX_STAT_CHARS = 8_000;
/** One recent subject is a style hint, not content. */
const MAX_SUBJECT_HINT_CHARS = 200;
/** The line that keeps the model from describing the prompt itself. */
const SCOPE_INSTRUCTION =
  "Describe only the staged changes shown below. Do not mention the diff, the prompt " +
  "or these instructions.";

function normaliseNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

/** Trim and bound the stat block; trailing blank lines add nothing. */
function clipStat(stat: string): string {
  const trimmed = normaliseNewlines(stat).replace(/\s+$/, "");
  return trimmed.length > MAX_STAT_CHARS ? trimmed.slice(0, MAX_STAT_CHARS) : trimmed;
}

/**
 * Cut the patch to `available` characters at the last complete line, so a
 * partial `diff --git` header never reaches the model. Returns "" when not even
 * one line fits, and never returns text longer than `available`.
 */
function truncatePatchAtLine(patch: string, available: number): string {
  if (available <= 0) return "";
  const window = patch.slice(0, available);
  const lastBreak = window.lastIndexOf("\n");
  const cut = lastBreak >= 0 ? window.slice(0, lastBreak) : window;
  return cut.replace(/\s+$/, "");
}

/**
 * Builds the one-shot prompt for a staged commit message.
 *
 * Sections, in order: the branch (or `(detached)`), the `--stat` summary (or
 * "no staged changes"), the recent subjects as a style hint when the caller
 * supplied them, the scope instruction, then the unified patch under `Diff:`.
 * A truncated patch is followed by its own marker line.
 */
export function buildCommitMessagePrompt(context: GitCommitContext): {
  system: string;
  prompt: string;
} {
  const sections: string[] = [`Branch: ${context.branch ?? "(detached)"}`];

  const stat = clipStat(context.stat);
  sections.push(stat.length > 0 ? `Staged files:\n${stat}` : "Staged files: no staged changes");

  const subjects = context.recentSubjects
    .slice(0, MAX_RECENT_COMMIT_SUBJECTS)
    .map((subject) => subject.replace(/\s+/g, " ").trim().slice(0, MAX_SUBJECT_HINT_CHARS))
    .filter((subject) => subject.length > 0);
  if (subjects.length > 0) {
    sections.push(
      `Recent commit subjects:\n${subjects.map((subject) => `- ${subject}`).join("\n")}`,
    );
  }

  sections.push(SCOPE_INSTRUCTION);
  const head = `${sections.join("\n\n")}\n\nDiff:\n`;

  const patch = normaliseNewlines(context.patch).replace(/\s+$/, "");
  const reserve = `\n${PATCH_TRUNCATED_MARKER}`.length;
  const available = Math.max(0, MAX_PROMPT_CHARS - head.length - reserve);
  const patchFits = patch.length <= available;
  const body = patchFits ? patch : truncatePatchAtLine(patch, available);
  const truncated = context.truncated || !patchFits;
  const prompt = `${head}${body}${truncated ? `\n${PATCH_TRUNCATED_MARKER}` : ""}`;

  // Defence in depth: a pathological stat could in theory exceed the wire
  // bound, and the request sanitiser refuses over-long prompts outright.
  return { system: COMMIT_MESSAGE_SYSTEM, prompt: prompt.slice(0, MAX_PROMPT_CHARS) };
}

/** Removes one wrapping fence (with an optional language tag) when it wraps it all. */
function stripWrappingFence(value: string): string {
  const lines = value.split("\n");
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (lines.length < 2 || first === undefined || last === undefined) return value;
  const open = /^(`{3,}|~{3,})[^\n]*$/.exec(first.trim());
  const close = /^(`{3,}|~{3,})$/.exec(last.trim());
  if (!open || !close) return value;
  // A mismatched fence pair is not a wrapper.
  if (open[1]?.[0] !== close[1]?.[0]) return value;
  return lines.slice(1, -1).join("\n").trim();
}

/** Removes a leading `commit message:` / `message:` label. */
function stripLabel(value: string): string {
  return value.replace(/^(?:commit\s+message|message)\s*:\s*/i, "").trim();
}

/**
 * Removes one pair of quotes/backticks only when they wrap the whole message.
 * Content that contains the same quote is left alone: `"a" and "b"` is a
 * message, not a quoted message.
 */
function stripSurroundingQuotes(value: string): string {
  const first = value[0];
  const last = value[value.length - 1];
  if (value.length < 2 || first === undefined || first !== last) return value;
  if (first !== '"' && first !== "'" && first !== "`") return value;
  const inner = value.slice(1, -1).trim();
  if (inner.length === 0 || inner.includes(first)) return value;
  return inner;
}

/** CRLF-free lines, no trailing whitespace per line, and no double blank line. */
function normaliseLines(value: string): string[] {
  const lines = normaliseNewlines(value)
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""));
  const out: string[] = [];
  for (const line of lines) {
    if (line.length === 0) {
      // Collapse any run of blank lines to one: a commit body separates
      // paragraphs with a single blank line.
      if (out.length === 0 || out[out.length - 1] === "") continue;
      out.push(line);
      continue;
    }
    out.push(line);
  }
  while (out.length > 0 && out[0] === "") out.shift();
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/**
 * Caps the subject at {@link COMMIT_SUBJECT_MAX}. The cut prefers the last word
 * boundary, but a single long token (a path, a sha) is still cut rather than
 * dropped entirely.
 */
function truncateSubject(subject: string): string {
  if (subject.length <= COMMIT_SUBJECT_MAX) return subject;
  const clipped = subject.slice(0, COMMIT_SUBJECT_MAX);
  const space = clipped.lastIndexOf(" ");
  const base = space >= COMMIT_SUBJECT_MAX / 2 ? clipped.slice(0, space) : clipped;
  return base.replace(/[\s,;:.]+$/, "");
}

/**
 * Turns a model reply into a commit message, or `null` when nothing usable is
 * left. The result always passes `sanitizeCommitMessage`: LF newlines, no
 * leading or trailing whitespace, at most {@link MAX_COMMIT_MESSAGE} characters,
 * a subject of at most {@link COMMIT_SUBJECT_MAX} and at most
 * {@link COMMIT_BODY_MAX_LINES} body lines.
 */
export function cleanCommitMessage(text: string): string | null {
  let value = normaliseNewlines(text).trim();
  if (value.length === 0) return null;

  value = stripWrappingFence(value);
  value = stripLabel(value);
  value = stripSurroundingQuotes(value);

  const lines = normaliseLines(value);
  const subjectIndex = lines.findIndex((line) => line.length > 0);
  if (subjectIndex < 0) return null;

  const subject = truncateSubject(lines[subjectIndex] ?? "");
  if (subject.length === 0) return null;

  const bodyLines = lines.slice(subjectIndex + 1);
  while (bodyLines.length > 0 && bodyLines[0] === "") bodyLines.shift();
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === "") bodyLines.pop();
  const body = bodyLines.slice(0, COMMIT_BODY_MAX_LINES);

  const message = body.length > 0 ? `${subject}\n\n${body.join("\n")}` : subject;
  const bounded = message.slice(0, MAX_COMMIT_MESSAGE).replace(/\s+$/, "");
  return bounded.length > 0 ? bounded : null;
}
