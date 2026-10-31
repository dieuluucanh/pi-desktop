/**
 * Plain text for an extension TUI frame (2026-10-30 copy plan).
 *
 * `TuiFrame.lines` still carry ANSI escapes because that is what the host
 * rendered; `AnsiBlock` parses them for display. Copying the raw lines would put
 * escape sequences on the clipboard, so this helper re-parses each line and
 * joins the spans' visible text. Trailing padding is stripped and blank edge
 * lines are removed, but leading indentation is preserved (a questionnaire's
 * layout is part of what the user is copying).
 */

import { parseAnsiLine } from "../../../shared/ansi";
import type { TuiFrame } from "../../../shared/tui-surface";

/** The visible text of one frame, ready for the clipboard. */
export function frameText(frame: TuiFrame): string {
  const lines = frame.lines.map((line) =>
    parseAnsiLine(line)
      .map((span) => span.text)
      .join(""),
  );
  while (lines.length > 0 && lines[0]!.trim().length === 0) lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim().length === 0) lines.pop();
  return lines.map((line) => line.replace(/\s+$/, "")).join("\n");
}
