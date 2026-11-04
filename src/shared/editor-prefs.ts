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
 */

import { isKnownLanguageId } from "./languages";

export const MIN_EDITOR_FONT_SIZE = 11;
export const MAX_EDITOR_FONT_SIZE = 20;
export const DEFAULT_EDITOR_FONT_SIZE = 13;

/** A formatter command line is a command, not a script. */
export const MAX_FORMATTER_COMMAND_LENGTH = 200;
export const MAX_FORMATTERS = 40;

export interface EditorPrefs {
  /** CodeMirror content font size in CSS pixels. */
  fontSize: number;
  /** Soft-wrap long lines. Off by default, like most code editors. */
  wordWrap: boolean;
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
  wordWrap: false,
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
    wordWrap: source.wordWrap === true,
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
