/**
 * Text helpers shared by the completion sources (plan step 7).
 *
 * The provider contract works on `lines[]` + a cursor line/column, while the
 * composer holds one buffer string; these conversions keep both views honest and
 * are pure, so they are unit-tested without a DOM.
 */

/** Splits a buffer into lines the way the editor sees them. */
export function splitBuffer(text: string): string[] {
  return text.split("\n");
}

/** Joins lines back into a buffer (the inverse of `splitBuffer`). */
export function joinBuffer(lines: readonly string[]): string {
  return lines.join("\n");
}

export interface BufferPosition {
  line: number;
  col: number;
}

/** Converts a character offset into a line/column pair. */
export function offsetToPosition(text: string, offset: number): BufferPosition {
  const bounded = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, bounded);
  const line = (before.match(/\n/g) ?? []).length;
  const lastBreak = before.lastIndexOf("\n");
  return { line, col: bounded - (lastBreak + 1) };
}

/** Converts a line/column pair back into a character offset. */
export function positionToOffset(lines: readonly string[], position: BufferPosition): number {
  let offset = 0;
  for (let index = 0; index < position.line && index < lines.length; index += 1) {
    offset += (lines[index]?.length ?? 0) + 1;
  }
  return offset + position.col;
}

export interface TokenRange {
  /** Start of the token on the cursor line. */
  start: number;
  /** End of the whole token (whitespace or line end). */
  end: number;
  /** The whole token. */
  text: string;
  /** The part from `start` to the caret: what a completion replaces. */
  query: string;
}

/**
 * The whitespace-delimited token under the caret. Pi's providers behave the same
 * way: a trigger character and its argument are one token, and accepting a
 * suggestion replaces only the part before the caret.
 */
export function tokenAtCursor(
  lines: readonly string[],
  cursorLine: number,
  cursorCol: number,
): TokenRange {
  const line = lines[cursorLine] ?? "";
  const col = Math.max(0, Math.min(cursorCol, line.length));
  let start = col;
  while (start > 0 && !isBoundary(line[start - 1]!)) start -= 1;
  let end = col;
  while (end < line.length && !isBoundary(line[end]!)) end += 1;
  return {
    start,
    end,
    text: line.slice(start, end),
    query: line.slice(start, col),
  };
}

/** True for characters that end a completion token. */
export function isBoundary(char: string): boolean {
  return char === " " || char === "\t";
}

/** Replaces a range inside a single-buffer string and reports the new caret. */
export function replaceRange(
  text: string,
  start: number,
  end: number,
  replacement: string,
): { text: string; caret: number } {
  const boundedStart = Math.max(0, Math.min(start, text.length));
  const boundedEnd = Math.max(boundedStart, Math.min(end, text.length));
  return {
    text: `${text.slice(0, boundedStart)}${replacement}${text.slice(boundedEnd)}`,
    caret: boundedStart + replacement.length,
  };
}
