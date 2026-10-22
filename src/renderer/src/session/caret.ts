import { offsetToPosition } from "../completion/token";

/**
 * The composer's caret readout (plan step 1).
 *
 * The composer is a plain-text buffer (decision D-A5) and its caret offset is
 * already tracked for the completion engine, so the readout only has to turn an
 * offset into a line/column pair. The conversion itself is not re-implemented
 * here: `offsetToPosition` is the same helper the completion stack uses, so the
 * readout and the providers can never disagree about where the cursor is.
 *
 * Lines and columns are **1-based**, the way an editor shows them: the caret
 * before the first character is `Ln 1, Col 1`, and a caret sitting just after a
 * newline is the first column of the next line.
 */

export interface CaretPosition {
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
}

/** The caret's line/column for a character offset inside `text`. */
export function caretPosition(text: string, offset: number): CaretPosition {
  const { line, col } = offsetToPosition(text, offset);
  return { line: line + 1, column: col + 1 };
}

/** The compact readout the composer shows: `Ln 2 · Col 7`. */
export function caretLabel(position: CaretPosition): string {
  return `Ln ${position.line} · Col ${position.column}`;
}
