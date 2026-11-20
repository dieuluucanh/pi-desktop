import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TERMINAL_THEME_VARIABLES } from "../../src/shared/terminal-theme";

/**
 * The terminal resolves its colours from these tokens, so both palettes must
 * define every one. A theme that only sets the ANSI slots leaves the canvas
 * black-on-black; a missing slot falls back silently in code, which is exactly
 * the kind of drift a text-level guard catches.
 */
describe("terminal theme tokens", () => {
  const css = readFileSync("src/renderer/src/styles/tokens.css", "utf8");

  it("defines every terminal and ANSI variable in both palettes", () => {
    for (const name of TERMINAL_THEME_VARIABLES) {
      const occurrences = css.split(`${name}:`).length - 1;
      expect(occurrences, `${name} is defined ${occurrences} time(s)`).toBe(2);
    }
  });
});
