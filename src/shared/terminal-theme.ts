/**
 * Terminal colour mapping (2026-11-05 native-terminal plan, step 2).
 *
 * xterm paints on a canvas, so it needs concrete colours rather than CSS
 * variables. The renderer resolves them from the app tokens at mount time and
 * re-resolves on a theme change; this module owns the mapping and the fallback
 * chain, so no component hardcodes a colour.
 *
 * Step 10 adds the `--terminal-*` and `--ansi-*` tokens to `tokens.css` and to
 * the Pi-theme projection. Until then (and in tests) the fallbacks below keep a
 * complete, readable theme.
 */

import { ANSI_16_COLORS } from "./ansi";

/** Structurally assignable to xterm's `ITheme` (all fields optional there). */
export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** The CSS variables the terminal reads, in the order they are documented. */
export const TERMINAL_THEME_VARIABLES = [
  "--terminal-bg",
  "--terminal-fg",
  "--terminal-cursor",
  "--terminal-selection",
  "--ansi-0",
  "--ansi-1",
  "--ansi-2",
  "--ansi-3",
  "--ansi-4",
  "--ansi-5",
  "--ansi-6",
  "--ansi-7",
  "--ansi-8",
  "--ansi-9",
  "--ansi-10",
  "--ansi-11",
  "--ansi-12",
  "--ansi-13",
  "--ansi-14",
  "--ansi-15",
] as const;

const ANSI_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

/** App-token fallbacks: a terminal is readable even before step 10 lands. */
export const FALLBACK_TERMINAL_COLORS = {
  background: "#101014",
  foreground: "#e6e6e6",
  cursor: "#e6e6e6",
  selection: "#3a3a4a",
} as const;

function ansiFallback(index: number): string {
  return ANSI_16_COLORS[index] ?? FALLBACK_TERMINAL_COLORS.foreground;
}

/**
 * Builds a complete xterm theme from a CSS-variable reader. `read` returns an
 * empty string for an unset variable (which is what `getComputedStyle` returns).
 * Values are trimmed; a blank value falls through to the next candidate.
 */
export function terminalThemeFromCssVariables(read: (name: string) => string): TerminalTheme {
  const pick = (...names: readonly string[]): string | undefined => {
    for (const name of names) {
      const value = read(name)?.trim();
      if (value && value.length > 0) return value;
    }
    return undefined;
  };

  const background =
    pick("--terminal-bg", "--color-sunken", "--color-canvas") ??
    FALLBACK_TERMINAL_COLORS.background;
  const foreground = pick("--terminal-fg", "--color-ink") ?? FALLBACK_TERMINAL_COLORS.foreground;
  const cursor = pick("--terminal-cursor", "--color-ink") ?? foreground;
  const selection =
    pick("--terminal-selection", "--color-selected", "--color-accent") ??
    FALLBACK_TERMINAL_COLORS.selection;

  const ansi = ANSI_NAMES.map((_, index) => pick(`--ansi-${index}`) ?? ansiFallback(index));
  const at = (index: number): string => ansi[index] ?? FALLBACK_TERMINAL_COLORS.foreground;

  return {
    background,
    foreground,
    cursor,
    cursorAccent: background,
    selectionBackground: selection,
    black: at(0),
    red: at(1),
    green: at(2),
    yellow: at(3),
    blue: at(4),
    magenta: at(5),
    cyan: at(6),
    white: at(7),
    brightBlack: at(8),
    brightRed: at(9),
    brightGreen: at(10),
    brightYellow: at(11),
    brightBlue: at(12),
    brightMagenta: at(13),
    brightCyan: at(14),
    brightWhite: at(15),
  };
}
