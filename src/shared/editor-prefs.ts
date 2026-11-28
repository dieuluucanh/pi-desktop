/**
 * Editor preferences.
 *
 * These are app preferences (not Pi settings): they describe the desktop
 * editor surface, not the model runtime. The block follows the same house
 * pattern as `rail`/`checkpoints`: a closed set of keys, a sanitizer that
 * clamps/drops untrusted input, and a one-level-deeper merge for partial
 * patches.
 *
 * `formatters` is the only dangerous key: it maps a language id to a command
 * line that main will execute when the user runs Format Document. It is gated
 * by `allowCommandFormatters` and is sanitized here, but the real policy is in
 * `src/main/editor-format.ts` — the renderer can never supply a command.
 *
 * The editor always fills the pane, so there is no width preference. Legacy
 * `width`/`widthColumns` keys from older `app-state.json` files are dropped by
 * `sanitizeEditorPrefs` (it builds a fresh object): no migration, no schema
 * version bump, and no parse error — rule 5 covers malformed JSON, not unknown
 * keys.
 */

import { isKnownLanguageId, isProseLanguage, type LanguageId } from "./languages";

export const MIN_EDITOR_FONT_SIZE = 11;
export const MAX_EDITOR_FONT_SIZE = 20;
export const DEFAULT_EDITOR_FONT_SIZE = 13;

/** VS Code's vocabulary: wrap every line, never, or only prose. */
export type EditorWordWrap = "auto" | "always" | "never";

export const DEFAULT_EDITOR_WORD_WRAP: EditorWordWrap = "auto";

/** A formatter command line is a command, not a script. */
export const MAX_FORMATTER_COMMAND_LENGTH = 200;
export const MAX_FORMATTERS = 40;

export interface EditorPrefs {
  /** CodeMirror content font size in CSS pixels. */
  fontSize: number;
  /**
   * Soft-wrap long lines. `auto` wraps prose (markdown, mdx, plain text) and
   * leaves code unwrapped; `always`/`never` are unconditional.
   */
  wordWrap: EditorWordWrap;
  /** Format the document before writing it on Ctrl/Cmd+S. */
  formatOnSave: boolean;
  /**
   * Explicit opt-in for command formatters. Off means a configured command is
   * ignored and the built-in Prettier provider is used instead.
   */
  allowCommandFormatters: boolean;
  /** languageId -> command line (e.g. `gofmt`, `rustfmt --emit stdout`). */
  formatters: Record<string, string>;
}

export const DEFAULT_EDITOR_PREFS: EditorPrefs = {
  fontSize: DEFAULT_EDITOR_FONT_SIZE,
  wordWrap: DEFAULT_EDITOR_WORD_WRAP,
  formatOnSave: false,
  allowCommandFormatters: false,
  formatters: {},
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A command is one line: no newlines, no NUL, bounded length. */
export function isSafeFormatterCommand(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_FORMATTER_COMMAND_LENGTH) return false;
  for (const character of trimmed) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function sanitizeFontSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_EDITOR_FONT_SIZE;
  return Math.min(MAX_EDITOR_FONT_SIZE, Math.max(MIN_EDITOR_FONT_SIZE, Math.round(value)));
}

/**
 * `wordWrap` used to be a boolean. `true` meant "wrap everything", which is
 * today's `always`; `false` meant "leave it alone", which is the new `auto`
 * (prose wraps, code does not). Anything else falls back to the default.
 */
function sanitizeWordWrap(value: unknown): EditorWordWrap {
  if (value === true) return "always";
  if (value === false) return DEFAULT_EDITOR_WORD_WRAP;
  if (value === "always" || value === "never" || value === "auto") return value;
  return DEFAULT_EDITOR_WORD_WRAP;
}

function sanitizeFormatters(value: unknown): Record<string, string> {
  const source = asRecord(value);
  const formatters: Record<string, string> = {};
  for (const [languageId, command] of Object.entries(source)) {
    if (!isKnownLanguageId(languageId)) continue;
    if (!isSafeFormatterCommand(command)) continue;
    formatters[languageId] = command.trim();
    if (Object.keys(formatters).length >= MAX_FORMATTERS) break;
  }
  return formatters;
}

/** Coerces an untrusted editor block into a usable one. */
export function sanitizeEditorPrefs(value: unknown): EditorPrefs {
  const source = asRecord(value);
  return {
    fontSize: sanitizeFontSize(source.fontSize),
    wordWrap: sanitizeWordWrap(source.wordWrap),
    formatOnSave: source.formatOnSave === true,
    allowCommandFormatters: source.allowCommandFormatters === true,
    formatters: sanitizeFormatters(source.formatters),
  };
}

/**
 * Applies a partial patch. The formatter map is the one nested value: a patch
 * that only mentions `fontSize` must not drop every configured command. An
 * empty command removes that language (the sanitizer drops it).
 */
export function mergeEditorPrefs(current: EditorPrefs, patch: unknown): EditorPrefs {
  const source = asRecord(patch);
  const formatters =
    "formatters" in source
      ? { ...current.formatters, ...asRecord(source.formatters) }
      : current.formatters;
  return sanitizeEditorPrefs({ ...current, ...source, formatters });
}

/**
 * The resolved wrap flag for one document.
 *
 * `always`/`never` are unconditional; `auto` follows the language, so prose
 * wraps at the pane width and code keeps today's unwrapped behaviour.
 */
export function effectiveWordWrap(languageId: LanguageId, prefs: EditorPrefs): boolean {
  if (prefs.wordWrap === "always") return true;
  if (prefs.wordWrap === "never") return false;
  return isProseLanguage(languageId);
}
