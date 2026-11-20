import { describe, expect, it } from "vitest";
import { parseThemeChoice, resolveTheme, storageValue } from "../src/lib/theme";

describe("theme choice", () => {
  it("parses only the three known values, defaulting to auto", () => {
    expect(parseThemeChoice("light")).toBe("light");
    expect(parseThemeChoice("dark")).toBe("dark");
    expect(parseThemeChoice("auto")).toBe("auto");
    expect(parseThemeChoice("")).toBe("auto");
    expect(parseThemeChoice(null)).toBe("auto");
    expect(parseThemeChoice("sepia")).toBe("auto");
  });

  it("resolves auto from the system preference", () => {
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("auto", true)).toBe("light");
    expect(resolveTheme("auto", false)).toBe("dark");
  });

  it("stores auto the way Starlight expects", () => {
    expect(storageValue("auto")).toBe("");
    expect(storageValue("light")).toBe("light");
    expect(storageValue("dark")).toBe("dark");
  });
});
