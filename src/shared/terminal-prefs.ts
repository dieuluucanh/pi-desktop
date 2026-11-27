/**
 * Integrated-terminal preferences (2026-11-05 native-terminal plan, step 1).
 *
 * These are **app** preferences (not Pi settings): they describe the desktop
 * terminal surface, not the agent. Pi's `shellPath`/`shellCommandPrefix` drive
 * the agent's bash tool and `!` commands, and on Windows that path may be a
 * POSIX bash — sharing it would be wrong for an interactive shell, so the
 * terminal has its own `shellPath` and profile choice.
 *
 * The block follows the house pattern (`editor-prefs.ts`): a closed set of keys,
 * a sanitizer that clamps/drops untrusted input, and a one-level merge for
 * partial patches. Nothing here can spawn a process: main resolves and validates
 * the actual shell path again before forking.
 */

export const MIN_TERMINAL_FONT_SIZE = 11;
export const MAX_TERMINAL_FONT_SIZE = 24;
/**
 * New profiles start at 14 px. Stored values are intentionally not migrated:
 * the resolved-font fix makes an existing 13 px real rather than a 10 px
 * fallback, and Settings offers a reset to this default.
 */
export const DEFAULT_TERMINAL_FONT_SIZE = 14;

export const MIN_TERMINAL_SCROLLBACK = 1000;
export const MAX_TERMINAL_SCROLLBACK = 50_000;
export const DEFAULT_TERMINAL_SCROLLBACK = 10_000;

export const MAX_TERMINAL_FONT_FAMILY_LENGTH = 200;
export const MAX_TERMINAL_SHELL_PATH_LENGTH = 4096;
export const MAX_TERMINAL_PROFILE_ID_LENGTH = 64;

export const TERMINAL_CURSOR_STYLES = ["block", "underline", "bar"] as const;
export type TerminalCursorStyle = (typeof TERMINAL_CURSOR_STYLES)[number];

export interface TerminalPrefs {
  /** xterm content font size in CSS pixels; Ctrl+=/-/0 changes it. */
  fontSize: number;
  /** `null` means the app's `--font-mono` token; any other value is a CSS family list. */
  fontFamily: string | null;
  /** Lines kept by xterm's scrollback buffer. */
  scrollback: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  /**
   * A detected profile id (`auto` resolves to the platform default) or `custom`.
   * Main owns the profile list; this is only the user's choice.
   */
  defaultProfile: string;
  /** Explicit shell executable; absolute, and re-validated in main before spawn. */
  shellPath: string | null;
  /** Copy immediately when a selection settles, like macOS terminals. */
  copyOnSelection: boolean;
  /** Flash the terminal surface on BEL instead of making a sound. */
  enableBell: boolean;
  /** macOS: treat Option as Meta so Alt+b/f reach the shell's readline. */
  macOptionIsMeta: boolean;
}

export const DEFAULT_TERMINAL_PREFS: TerminalPrefs = {
  fontSize: DEFAULT_TERMINAL_FONT_SIZE,
  fontFamily: null,
  scrollback: DEFAULT_TERMINAL_SCROLLBACK,
  cursorStyle: "block",
  cursorBlink: true,
  defaultProfile: "auto",
  shellPath: null,
  copyOnSelection: false,
  enableBell: false,
  macOptionIsMeta: false,
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Absolute on Windows (drive or UNC) or POSIX. Mirrors `path.isAbsolute` without
 * importing `node:path`, because this module is bundled into the renderer too.
 */
export function isAbsoluteTerminalPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\/.test(value) || value.startsWith("/");
}

/** True when a CSS family list contains a newline or another control character. */
function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * The profile-id shape main accepts. Shared so the sanitizer and the IPC parser
 * cannot drift; a renderer can only name a detected id, never a path.
 */
export function isTerminalProfileId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TERMINAL_PROFILE_ID_LENGTH &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
  );
}

/**
 * True for a one-line CSS family list that is safe to hand to xterm. xterm
 * injects the value into a stylesheet, so CSS structural characters are
 * rejected in addition to control characters.
 */
export function isTerminalFontFamily(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TERMINAL_FONT_FAMILY_LENGTH) return false;
  return !hasControlCharacter(trimmed) && !/[{}<>;]/.test(trimmed);
}

function sanitizeFontFamily(value: unknown): string | null {
  return isTerminalFontFamily(value) ? value.trim() : null;
}

function sanitizeProfileId(value: unknown): string {
  if (!isTerminalProfileId(value)) return DEFAULT_TERMINAL_PREFS.defaultProfile;
  return value.trim();
}

function sanitizeShellPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TERMINAL_SHELL_PATH_LENGTH) return null;
  if (!isAbsoluteTerminalPath(trimmed) || trimmed.includes("\0")) return null;
  return trimmed;
}

function sanitizeCursorStyle(value: unknown): TerminalCursorStyle {
  return (TERMINAL_CURSOR_STYLES as readonly unknown[]).includes(value)
    ? (value as TerminalCursorStyle)
    : DEFAULT_TERMINAL_PREFS.cursorStyle;
}

/** Coerces an untrusted block into a complete `TerminalPrefs`. */
export function sanitizeTerminalPrefs(value: unknown): TerminalPrefs {
  const source = asRecord(value);
  return {
    fontSize: clampInteger(
      source.fontSize,
      MIN_TERMINAL_FONT_SIZE,
      MAX_TERMINAL_FONT_SIZE,
      DEFAULT_TERMINAL_FONT_SIZE,
    ),
    fontFamily: sanitizeFontFamily(source.fontFamily),
    scrollback: clampInteger(
      source.scrollback,
      MIN_TERMINAL_SCROLLBACK,
      MAX_TERMINAL_SCROLLBACK,
      DEFAULT_TERMINAL_SCROLLBACK,
    ),
    cursorStyle: sanitizeCursorStyle(source.cursorStyle),
    // Boolean defaults are explicit: a fresh profile must not opt into a bell.
    cursorBlink:
      typeof source.cursorBlink === "boolean"
        ? source.cursorBlink
        : DEFAULT_TERMINAL_PREFS.cursorBlink,
    defaultProfile: sanitizeProfileId(source.defaultProfile),
    shellPath: sanitizeShellPath(source.shellPath),
    copyOnSelection:
      typeof source.copyOnSelection === "boolean"
        ? source.copyOnSelection
        : DEFAULT_TERMINAL_PREFS.copyOnSelection,
    enableBell:
      typeof source.enableBell === "boolean"
        ? source.enableBell
        : DEFAULT_TERMINAL_PREFS.enableBell,
    macOptionIsMeta:
      typeof source.macOptionIsMeta === "boolean"
        ? source.macOptionIsMeta
        : DEFAULT_TERMINAL_PREFS.macOptionIsMeta,
  };
}

/** Applies a partial patch; every key is flat, so the sanitizer does the merge. */
export function mergeTerminalPrefs(current: TerminalPrefs, patch: unknown): TerminalPrefs {
  const source = asRecord(patch);
  return sanitizeTerminalPrefs({ ...current, ...source });
}
