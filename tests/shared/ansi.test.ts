import { describe, expect, it } from "vitest";
import { visibleWidth as piVisibleWidth } from "@earendil-works/pi-tui";
import {
  ANSI_16_COLORS,
  extractAnsiCode,
  padToWidth,
  parseAnsiLine,
  parseAnsiLines,
  stripAnsi,
  visibleWidth,
} from "../../src/shared/ansi";

/**
 * The terminal-text engine (plan step 17).
 *
 * Two contracts matter: a rendered ANSI line becomes styled spans a React
 * component can render (no HTML rewriting), and the width mirror agrees with
 * pi-tui so the renderer can pad lines to the terminal grid. The width cases
 * are pinned against pi-tui's own `visibleWidth`; if upstream's table changes,
 * the corpus test fails instead of silently misaligning the surface.
 */

describe("ansi parsing", () => {
  it("returns one plain span for unstyled text", () => {
    expect(parseAnsiLine("hello")).toEqual([
      { text: "hello", style: expect.objectContaining({ fg: null, bg: null }), href: null },
    ]);
  });

  it("parses truecolor foreground and background", () => {
    const spans = parseAnsiLine("\x1b[38;2;255;0;128mX\x1b[48;2;0;16;32mY\x1b[0mZ");
    expect(spans[0]).toMatchObject({ text: "X", style: { fg: "#ff0080" } });
    expect(spans[1]).toMatchObject({ text: "Y", style: { fg: "#ff0080", bg: "#001020" } });
    expect(spans[2]).toMatchObject({ text: "Z", style: { fg: null, bg: null } });
  });

  it("parses 256-colour codes with the xterm ramp", () => {
    expect(parseAnsiLine("\x1b[38;5;196mR")[0]?.style.fg).toBe("#ff0000");
    expect(parseAnsiLine("\x1b[38;5;232mD")[0]?.style.fg).toBe("#080808");
    expect(parseAnsiLine("\x1b[38;5;231mW")[0]?.style.fg).toBe("#ffffff");
  });

  it("parses the 16 base colours and attributes", () => {
    const spans = parseAnsiLine("\x1b[1;3;4;7;9;31;44mX");
    expect(spans[0]?.style).toMatchObject({
      bold: true,
      italic: true,
      underline: true,
      inverse: true,
      strike: true,
      fg: ANSI_16_COLORS[1],
      bg: ANSI_16_COLORS[4],
    });
    expect(parseAnsiLine("\x1b[91mB")[0]?.style.fg).toBe(ANSI_16_COLORS[9]);
  });

  it("resets individual attributes without clearing colour", () => {
    const spans = parseAnsiLine("\x1b[1;31mX\x1b[22mY");
    expect(spans[1]?.style).toMatchObject({ bold: false, fg: ANSI_16_COLORS[1] });
  });

  it("keeps a background fill that the line closes with a background reset", () => {
    // Pi closes every filled span with `\x1b[49m` (`theme.bg(color, text)`).
    // The style of an already-parsed span must not change when that reset
    // arrives: an in-place reset wiped the fill of the selected element of an
    // extension-drawn component, so the app could not show which tab was
    // active (plan step 2).
    const spans = parseAnsiLine("\x1b[48;2;58;58;74m Scope \x1b[49m");
    expect(spans[0]).toMatchObject({ text: " Scope ", style: { bg: "#3a3a4a" } });
  });

  it("keeps a foreground that the line closes with a foreground reset", () => {
    const spans = parseAnsiLine("\x1b[38;2;212;212;212m Scope \x1b[39m");
    expect(spans[0]).toMatchObject({ text: " Scope ", style: { fg: "#d4d4d4" } });
  });

  it("captures OSC-8 hyperlinks and closes them", () => {
    const spans = parseAnsiLine("\x1b]8;;https://pi.dev\x07link\x1b]8;;\x07 text");
    expect(spans[0]).toMatchObject({ text: "link", href: "https://pi.dev" });
    expect(spans[1]?.href).toBeNull();
  });

  it("merges adjacent runs with identical style", () => {
    expect(parseAnsiLine("a\x1b[0mb\x1b[0mc")).toHaveLength(1);
  });

  it("strips the cursor marker and other control sequences", () => {
    expect(parseAnsiLine("ab\x1b_pi:c\x07cd")[0]?.text).toBe("abcd");
    expect(stripAnsi("\x1b[31mred\x1b[0m plain")).toBe("red plain");
    expect(stripAnsi("a\x1b[?25lb")).toBe("ab");
  });

  it("extracts sequences and refuses ordinary text", () => {
    expect(extractAnsiCode("x", 0)).toBeNull();
    expect(extractAnsiCode("\x1b[1m", 0)).toEqual({ code: "\x1b[1m", length: 4 });
    expect(extractAnsiCode("\x1b]8;;u\x07", 0)).toEqual({ code: "\x1b]8;;u\x07", length: 7 });
  });

  it("parses a whole frame", () => {
    expect(parseAnsiLines(["\x1b[1mA", "B"])).toHaveLength(2);
  });
});

describe("visibleWidth mirrors pi-tui", () => {
  const corpus = [
    "",
    "hello",
    "hello world",
    "café",
    "cafe\u0301", // combining acute
    "日本語",
    "한국어",
    "中文字",
    "ＡＢＣ", // fullwidth
    "ｈｅｌｌｏ", // halfwidth
    "👋",
    "👍🏽",
    "👨‍👩‍👧‍👦",
    "🏳️‍🌈",
    "🇻🇳",
    "e\u0301",
    "\x1b[31mred\x1b[0m",
    "a\tb",
    "\x1b]8;;https://x\x07link\x1b]8;;\x07",
    "ab\x1b_pi:c\x07cd",
    "Ｈｅｌｌｏ 👋 世界",
    "⏳",
    "©",
    "▶",
  ];

  it.each(corpus)("agrees on %j", (value) => {
    expect(visibleWidth(value)).toBe(piVisibleWidth(value));
  });

  it("pads to the requested width and never truncates", () => {
    expect(padToWidth("日本", 6)).toBe("日本  ");
    expect(padToWidth("日本", 4)).toBe("日本");
    expect(padToWidth("abcdef", 2)).toBe("abcdef");
  });
});
