import { describe, expect, it } from "vitest";
import { frameText } from "../../src/renderer/src/tui/frame-text";

/**
 * Plain text for the clipboard (2026-10-30 copy plan). The raw frame lines carry
 * ANSI escapes and terminal padding; copying them verbatim would put escape
 * sequences on the clipboard.
 */

describe("frameText", () => {
  it("strips ANSI colours and trailing padding", () => {
    expect(
      frameText({
        seq: 1,
        width: 10,
        height: 3,
        lines: ["\x1b[31mred\x1b[39m   ", "plain   ", "   "],
        cursor: null,
      }),
    ).toBe("red\nplain");
  });

  it("keeps leading indentation", () => {
    expect(
      frameText({
        seq: 2,
        width: 12,
        height: 2,
        lines: ["  - choice", "    detail"],
        cursor: null,
      }),
    ).toBe("  - choice\n    detail");
  });

  it("returns an empty string for an empty or blank frame", () => {
    expect(frameText({ seq: 3, width: 4, height: 0, lines: [], cursor: null })).toBe("");
    expect(frameText({ seq: 4, width: 4, height: 2, lines: ["  ", ""], cursor: null })).toBe("");
  });
});
