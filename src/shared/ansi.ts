/**
 * Terminal text: ANSI parsing and cell widths (plan step 17).
 *
 * The extension TUI surface renders Pi's real components into ANSI lines in the
 * host process and ships those lines to the renderer. This module is the pure
 * half of that contract:
 *
 * - `parseAnsiLine` turns one rendered line into styled spans (SGR colours,
 *   attributes and OSC-8 hyperlinks) that React can render without any
 *   `dangerouslySetInnerHTML`.
 * - `visibleWidth` mirrors pi-tui's width calculation so the renderer can pad a
 *   line to the host's declared column count and keep wide characters, emoji
 *   and combining marks aligned with the hardware cursor.
 *
 * No pi-tui import: the renderer bundle must stay free of pi-tui's Node-only
 * modules (`node:fs`, `node:child_process`). `tests/shared/ansi.test.ts` pins
 * both behaviours against the real pi-tui implementation, exactly like the
 * completion engine pins its fuzzy matcher.
 */

import { eastAsianWidth } from "get-east-asian-width";

/** The 16 ANSI colours Pi may emit for `\x1b[30-37m` / `\x1b[90-97m`. */
export const ANSI_16_COLORS: readonly string[] = [
  "#1c1c1c", // 0 black
  "#d75f5f", // 1 red
  "#5faf5f", // 2 green
  "#d7af5f", // 3 yellow
  "#5f87d7", // 4 blue
  "#af5fd7", // 5 magenta
  "#5fafaf", // 6 cyan
  "#d0d0d0", // 7 white
  "#6c6c6c", // 8 bright black
  "#ff8787", // 9 bright red
  "#87d787", // 10 bright green
  "#ffd787", // 11 bright yellow
  "#87afff", // 12 bright blue
  "#d787ff", // 13 bright magenta
  "#87d7d7", // 14 bright cyan
  "#ffffff", // 15 bright white
];

export interface AnsiStyle {
  /** Resolved `#rrggbb` foreground, or null for the terminal default. */
  fg: string | null;
  /** Resolved `#rrggbb` background, or null for the terminal default. */
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  strike: boolean;
  /** Concealed text (`\x1b[8m`); rendered invisible but kept in the DOM. */
  hidden: boolean;
}

export interface AnsiSpan {
  text: string;
  style: AnsiStyle;
  /** OSC-8 hyperlink target for this span, or null. */
  href: string | null;
}

export const EMPTY_ANSI_STYLE: AnsiStyle = {
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  strike: false,
  hidden: false,
};

function styleKey(style: AnsiStyle, href: string | null): string {
  return [
    style.fg ?? "",
    style.bg ?? "",
    style.bold ? "b" : "",
    style.dim ? "d" : "",
    style.italic ? "i" : "",
    style.underline ? "u" : "",
    style.inverse ? "v" : "",
    style.strike ? "s" : "",
    style.hidden ? "h" : "",
    href ?? "",
  ].join("|");
}

/**
 * Extracts one escape sequence at `pos`, or null when the character there is
 * ordinary text. Handles CSI, OSC, APC/PM/SOS/DCS and two-character escapes —
 * the same families pi-tui's `extractAnsiCode` handles, so `stripAnsi` and the
 * width mirror agree with the terminal.
 */
export function extractAnsiCode(
  text: string,
  pos: number,
): { code: string; length: number } | null {
  if (text.charCodeAt(pos) !== 0x1b) return null;
  const next = text[pos + 1];
  if (next === undefined) return null;
  if (next === "[") {
    // CSI: parameter/intermediate bytes then one final byte 0x40-0x7e.
    let i = pos + 2;
    while (i < text.length) {
      const code = text.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) {
        return { code: text.slice(pos, i + 1), length: i + 1 - pos };
      }
      if (code < 0x20 || code > 0x3f) break;
      i++;
    }
    return null;
  }
  if (next === "]" || next === "_" || next === "P" || next === "^" || next === "X") {
    // String sequences end at BEL (0x07) or ST (ESC \).
    let i = pos + 2;
    while (i < text.length) {
      if (text.charCodeAt(i) === 0x07) return { code: text.slice(pos, i + 1), length: i + 1 - pos };
      if (text.charCodeAt(i) === 0x1b && text[i + 1] === "\\") {
        return { code: text.slice(pos, i + 2), length: i + 2 - pos };
      }
      i++;
    }
    return { code: text.slice(pos), length: text.length - pos };
  }
  // Two-character escape (ESC + 0x20-0x2f then 0x30-0x7e, or ESC + 0x30-0x7e).
  let i = pos + 1;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code >= 0x30 && code <= 0x7e) return { code: text.slice(pos, i + 1), length: i + 1 - pos };
    if (code < 0x20 || code > 0x2f) break;
    i++;
  }
  return null;
}

/** Removes every escape sequence, preserving visible text. */
export function stripAnsi(text: string): string {
  if (!text.includes("\x1b")) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ansi = extractAnsiCode(text, i);
    if (ansi) {
      i += ansi.length;
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

function ansi256ToHex(index: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index > 255) return null;
  if (index < 16) return ANSI_16_COLORS[index] ?? null;
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return rgbToHex(level, level, level);
  }
  const value = index - 16;
  const r = Math.floor(value / 36);
  const g = Math.floor((value % 36) / 6);
  const b = value % 6;
  const channel = (n: number): number => (n === 0 ? 0 : 55 + n * 40);
  return rgbToHex(channel(r), channel(g), channel(b));
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));
  const hex = (n: number): string => clamp(n).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

interface ParsedSgr {
  fg: string | null | undefined;
  bg: string | null | undefined;
  reset: boolean;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strike?: boolean;
  hidden?: boolean;
}

/** Parses one SGR sequence's parameters; `undefined` means "leave unchanged". */
function parseSgr(params: string): ParsedSgr {
  const result: ParsedSgr = { fg: undefined, bg: undefined, reset: false };
  // SGR params may use `;` or `:` (ITU T.416 sub-parameters) — split on both.
  const parts = params
    .split(/[;:]/)
    .filter((part) => part.length > 0)
    .map((part) => Number.parseInt(part, 10));
  if (params.length === 0) parts.push(0);
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (code === undefined || Number.isNaN(code)) continue;
    if (code === 0) {
      result.reset = true;
      continue;
    }
    if (code === 1) result.bold = true;
    else if (code === 2) result.dim = true;
    else if (code === 3) result.italic = true;
    else if (code === 4) result.underline = true;
    else if (code === 7) result.inverse = true;
    else if (code === 8) result.hidden = true;
    else if (code === 9) result.strike = true;
    else if (code === 21 || code === 22) {
      result.bold = false;
      result.dim = false;
    } else if (code === 23) result.italic = false;
    else if (code === 24) result.underline = false;
    else if (code === 27) result.inverse = false;
    else if (code === 28) result.hidden = false;
    else if (code === 29) result.strike = false;
    else if (code >= 30 && code <= 37) result.fg = ANSI_16_COLORS[code - 30] ?? null;
    else if (code === 39) result.fg = null;
    else if (code >= 40 && code <= 47) result.bg = ANSI_16_COLORS[code - 40] ?? null;
    else if (code === 49) result.bg = null;
    else if (code >= 90 && code <= 97) result.fg = ANSI_16_COLORS[code - 90 + 8] ?? null;
    else if (code >= 100 && code <= 107) result.bg = ANSI_16_COLORS[code - 100 + 8] ?? null;
    else if (code === 38 || code === 48) {
      const isFg = code === 38;
      const mode = parts[i + 1];
      if (mode === 5) {
        const value = ansi256ToHex(parts[i + 2] ?? -1);
        if (isFg) result.fg = value;
        else result.bg = value;
        i += 2;
      } else if (mode === 2) {
        const value = rgbToHex(parts[i + 2] ?? 0, parts[i + 3] ?? 0, parts[i + 4] ?? 0);
        if (isFg) result.fg = value;
        else result.bg = value;
        i += 4;
      }
    }
  }
  return result;
}

function applySgr(style: AnsiStyle, sgr: ParsedSgr): AnsiStyle {
  if (sgr.reset) style = { ...EMPTY_ANSI_STYLE };
  if (sgr.fg !== undefined) style.fg = sgr.fg;
  if (sgr.bg !== undefined) style.bg = sgr.bg;
  if (sgr.bold !== undefined) style.bold = sgr.bold;
  if (sgr.dim !== undefined) style.dim = sgr.dim;
  if (sgr.italic !== undefined) style.italic = sgr.italic;
  if (sgr.underline !== undefined) style.underline = sgr.underline;
  if (sgr.inverse !== undefined) style.inverse = sgr.inverse;
  if (sgr.strike !== undefined) style.strike = sgr.strike;
  if (sgr.hidden !== undefined) style.hidden = sgr.hidden;
  return style;
}

/** Parses the payload of an OSC-8 sequence (`8;params;url`). */
function parseOsc8(payload: string): { href: string | null } | null {
  const match = payload.match(/^8;([^;]*);(.*)$/);
  if (!match) return null;
  const url = match[2] ?? "";
  return { href: url.length > 0 ? url : null };
}

/**
 * Parses one rendered line into styled spans. Adjacent runs with identical style
 * and hyperlink are merged, so a line of plain text stays a single span.
 */
export function parseAnsiLine(line: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  if (line.length === 0) return spans;
  let style: AnsiStyle = { ...EMPTY_ANSI_STYLE };
  let href: string | null = null;
  let buffer = "";
  let bufferKey: string | null = null;

  const flush = (): void => {
    if (buffer.length === 0) return;
    spans.push({ text: buffer, style, href });
    buffer = "";
  };

  let i = 0;
  while (i < line.length) {
    const ansi = extractAnsiCode(line, i);
    if (ansi) {
      const code = ansi.code;
      if (code.startsWith("\x1b[")) {
        const body = code.slice(2);
        if (body.endsWith("m")) {
          const nextStyle = applySgr(style, parseSgr(body.slice(0, -1)));
          if (buffer.length > 0 && styleKey(nextStyle, href) !== bufferKey) flush();
          style = nextStyle;
          bufferKey = styleKey(style, href);
        }
      } else if (code.startsWith("\x1b]")) {
        let body = code.slice(2);
        if (body.endsWith("\x07")) body = body.slice(0, -1);
        else if (body.endsWith("\x1b\\")) body = body.slice(0, -2);
        const osc8 = parseOsc8(body);
        if (osc8) {
          if (buffer.length > 0 && styleKey(style, osc8.href) !== bufferKey) flush();
          href = osc8.href;
          bufferKey = styleKey(style, href);
        }
      }
      i += ansi.length;
      continue;
    }
    const key = styleKey(style, href);
    if (bufferKey !== null && key !== bufferKey) flush();
    bufferKey = key;
    buffer += line[i];
    i++;
  }
  flush();
  return spans;
}

/** Parses every line of a frame. */
export function parseAnsiLines(lines: readonly string[]): AnsiSpan[][] {
  return lines.map((line) => parseAnsiLine(line));
}

/* ------------------------------------------------------------------------- *
 * Cell widths (a pinned mirror of pi-tui's `visibleWidth`)
 * ------------------------------------------------------------------------- */

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const zeroWidthRegex =
  /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mark}|\p{Surrogate})+$/u;
const leadingNonPrintingRegex =
  /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+/u;
const nonPrintingCharRegex =
  /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Mark}|\p{Surrogate})$/u;
const markCharRegex = /^\p{Mark}$/u;
const spacingMarkRegex = /^\p{Spacing_Mark}+$/u;
const legacySpacingMarkRegex =
  /^[\u065F\u0F7F\u102B\u102C\u1031\u1033-\u1035\u1038\u103A-\u103E]+$/u;
// Code points in the `Spacing_Mark` category that legacy wcwidth tables do not
// allocate a cell for (pi-tui excludes them from its `\p{Spacing_Mark}--[...]`).
const NON_SPACING_MARK_EXCEPTIONS = new Set([0x1734, 0x302e, 0x302f]);
const rgiEmojiRegex = new RegExp("^\\p{RGI_Emoji}$", "v");

/** pi-tui's terminal-spacing-mark test, without the ES2024-only `v` set difference. */
function isTerminalSpacingMark(segment: string): boolean {
  if (legacySpacingMarkRegex.test(segment)) return true;
  if (!spacingMarkRegex.test(segment)) return false;
  for (const char of segment) {
    if (NON_SPACING_MARK_EXCEPTIONS.has(char.codePointAt(0) ?? -1)) return false;
  }
  return true;
}

function couldBeEmoji(segment: string): boolean {
  const cp = segment.codePointAt(0);
  if (cp === undefined) return false;
  return (
    (cp >= 0x1f000 && cp <= 0x1fbff) ||
    (cp >= 0x2300 && cp <= 0x23ff) ||
    (cp >= 0x2600 && cp <= 0x27bf) ||
    (cp >= 0x2b50 && cp <= 0x2b55) ||
    segment.includes("\uFE0F") ||
    segment.length > 2
  );
}

function graphemeWidth(segment: string): number {
  if (segment === "\t") return 3;
  if (isTerminalSpacingMark(segment)) return [...segment].length;
  if (zeroWidthRegex.test(segment)) return 0;
  if (couldBeEmoji(segment) && rgiEmojiRegex.test(segment)) return 2;
  const base = segment.replace(leadingNonPrintingRegex, "");
  const cp = base.codePointAt(0);
  if (cp === undefined) return 0;
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return 2;
  let width = eastAsianWidth(cp);
  let followsMark = false;
  for (const char of [...base].slice(1)) {
    if (isTerminalSpacingMark(char)) {
      width += 1;
      followsMark = false;
    } else if (markCharRegex.test(char)) {
      followsMark = true;
    } else if (!nonPrintingCharRegex.test(char)) {
      const c = char.codePointAt(0);
      if (c === undefined) continue;
      if (followsMark || (c >= 0xff00 && c <= 0xffef)) width += eastAsianWidth(c);
      else if (c === 0x0e33 || c === 0x0eb3) width += 1;
      followsMark = false;
    }
  }
  return width;
}

function isPrintableAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/** Terminal cell width of a string (ANSI-aware, wide-character-aware). */
export function visibleWidth(text: string): number {
  if (text.length === 0) return 0;
  if (isPrintableAscii(text)) return text.length;
  let clean = text.includes("\t") ? text.replace(/\t/g, "   ") : text;
  if (clean.includes("\x1b")) clean = stripAnsi(clean);
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(clean)) width += graphemeWidth(segment);
  return width;
}

/**
 * Pads a line with spaces to exactly `width` cells (never truncates). Used so a
 * background colour or the cursor column lines up with the terminal grid.
 */
export function padToWidth(text: string, width: number): string {
  const actual = visibleWidth(text);
  if (actual >= width) return text;
  return `${text}${" ".repeat(width - actual)}`;
}
