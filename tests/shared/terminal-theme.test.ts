import { describe, expect, it } from "vitest";
import { ANSI_16_COLORS } from "../../src/shared/ansi";
import {
  FALLBACK_TERMINAL_COLORS,
  TERMINAL_THEME_VARIABLES,
  terminalThemeFromCssVariables,
} from "../../src/shared/terminal-theme";

function reader(values: Record<string, string>): (name: string) => string {
  return (name) => values[name] ?? "";
}

describe("terminalThemeFromCssVariables", () => {
  it("supplies a complete theme when no tokens exist yet", () => {
    const theme = terminalThemeFromCssVariables(() => "");
    expect(theme.background).toBe(FALLBACK_TERMINAL_COLORS.background);
    expect(theme.foreground).toBe(FALLBACK_TERMINAL_COLORS.foreground);
    expect(theme.cursor).toBe(theme.foreground);
    expect(theme.cursorAccent).toBe(theme.background);
    expect(theme.selectionBackground).toBe(FALLBACK_TERMINAL_COLORS.selection);
    expect([theme.black, theme.red, theme.green, theme.white]).toEqual([
      ANSI_16_COLORS[0],
      ANSI_16_COLORS[1],
      ANSI_16_COLORS[2],
      ANSI_16_COLORS[7],
    ]);
    expect(theme.brightWhite).toBe(ANSI_16_COLORS[15]);
    expect(
      Object.values(theme).every((value) => typeof value === "string" && value.length > 0),
    ).toBe(true);
  });

  it("reads every terminal token and ANSI slot", () => {
    const values: Record<string, string> = {
      "--terminal-bg": "#101010",
      "--terminal-fg": "#f0f0f0",
      "--terminal-cursor": "#ff0000",
      "--terminal-selection": "#004488",
    };
    for (let index = 0; index < 16; index += 1) {
      values[`--ansi-${index}`] = `#0000${index.toString(16).padStart(2, "0")}`;
    }
    const theme = terminalThemeFromCssVariables(reader(values));
    expect(theme.background).toBe("#101010");
    expect(theme.foreground).toBe("#f0f0f0");
    expect(theme.cursor).toBe("#ff0000");
    expect(theme.selectionBackground).toBe("#004488");
    expect(theme.cursorAccent).toBe("#101010");
    expect(theme.black).toBe("#000000");
    expect(theme.brightYellow).toBe("#00000b");
  });

  it("falls through blank values and trims the rest", () => {
    const theme = terminalThemeFromCssVariables(
      reader({
        "--terminal-bg": "   ",
        "--color-sunken": " #222222 ",
        "--terminal-fg": "",
        "--color-ink": "#eeeeee",
        "--terminal-selection": "",
        "--color-selected": "",
        "--color-accent": "#3366ff",
      }),
    );
    expect(theme.background).toBe("#222222");
    expect(theme.foreground).toBe("#eeeeee");
    expect(theme.selectionBackground).toBe("#3366ff");
  });

  it("prefers the app canvas over the hardcoded fallback", () => {
    const theme = terminalThemeFromCssVariables(
      reader({ "--color-canvas": "#151515", "--color-ink": "#dddddd" }),
    );
    expect(theme.background).toBe("#151515");
    expect(theme.foreground).toBe("#dddddd");
  });
});

describe("TERMINAL_THEME_VARIABLES", () => {
  it("names every token exactly once, including all 16 ANSI slots", () => {
    expect(new Set(TERMINAL_THEME_VARIABLES).size).toBe(TERMINAL_THEME_VARIABLES.length);
    for (let index = 0; index < 16; index += 1) {
      expect(TERMINAL_THEME_VARIABLES).toContain(`--ansi-${index}`);
    }
    expect(TERMINAL_THEME_VARIABLES).toContain("--terminal-bg");
    expect(TERMINAL_THEME_VARIABLES).toContain("--terminal-selection");
  });
});
