import { describe, expect, it } from "vitest";

import { caretLabel, caretPosition } from "../../src/renderer/src/session/caret";

/**
 * The caret readout (plan step 1).
 *
 * The composer's caret offset is already tracked for the completion engine; the
 * readout only has to turn that offset into the line/column an editor shows.
 * These cases pin the two things a user would notice being wrong: the line
 * count on a multi-line draft, and the clamping of an offset that points past
 * the end of the text.
 */

describe("caretPosition", () => {
  it("starts at the first line and column", () => {
    expect(caretPosition("", 0)).toEqual({ line: 1, column: 1 });
  });

  it("counts the column from the start of the line", () => {
    expect(caretPosition("hello", 0)).toEqual({ line: 1, column: 1 });
    expect(caretPosition("hello", 5)).toEqual({ line: 1, column: 6 });
  });

  it("moves to the next line after a newline", () => {
    expect(caretPosition("one\ntwo", 3)).toEqual({ line: 1, column: 4 });
    expect(caretPosition("one\ntwo", 4)).toEqual({ line: 2, column: 1 });
    expect(caretPosition("one\ntwo", 7)).toEqual({ line: 2, column: 4 });
  });

  it("counts every line of a multi-line draft", () => {
    expect(caretPosition("a\nb\nc", 6)).toEqual({ line: 3, column: 2 });
  });

  it("clamps an offset past the end of the text", () => {
    expect(caretPosition("hi", 99)).toEqual({ line: 1, column: 3 });
    expect(caretPosition("hi", -5)).toEqual({ line: 1, column: 1 });
  });
});

describe("caretLabel", () => {
  it("formats the position the way the composer shows it", () => {
    expect(caretLabel({ line: 1, column: 1 })).toBe("Ln 1 · Col 1");
    expect(caretLabel({ line: 2, column: 7 })).toBe("Ln 2 · Col 7");
  });
});
