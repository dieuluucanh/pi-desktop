import { describe, expect, it, vi } from "vitest";

import {
  createThemeHandlers,
  listThemes,
  ThemeError,
  validateThemeImport,
  type ThemePort,
} from "../../src/host/themes";
import { BUILTIN_THEME_SWATCHES } from "../../src/shared/themes";

const COMPLETE_COLORS: Record<string, string> = {
  accent: "#111111",
  border: "#111111",
  borderAccent: "#111111",
  borderMuted: "#111111",
  success: "#111111",
  error: "#111111",
  warning: "#111111",
  muted: "#222222",
  dim: "#333333",
  text: "#eeeeee",
  selectedBg: "#111111",
  userMessageBg: "#111111",
  userMessageText: "#eeeeee",
  customMessageBg: "#111111",
  customMessageText: "#eeeeee",
  customMessageLabel: "#111111",
  toolPendingBg: "#111111",
  toolSuccessBg: "#111111",
  toolErrorBg: "#111111",
  toolTitle: "#eeeeee",
  toolOutput: "#222222",
  mdHeading: "#111111",
  mdLink: "#111111",
  mdLinkUrl: "#333333",
  mdCode: "#111111",
  mdCodeBlock: "#111111",
  mdCodeBlockBorder: "#222222",
  mdQuote: "#222222",
  mdQuoteBorder: "#222222",
  mdHr: "#222222",
  mdListBullet: "#111111",
  toolDiffAdded: "#111111",
  toolDiffRemoved: "#111111",
  toolDiffContext: "#222222",
};

function themeFile(name: string, colors: Record<string, string> = COMPLETE_COLORS): string {
  return JSON.stringify({ name, colors });
}

function port(overrides: Partial<ThemePort> = {}): ThemePort {
  return {
    listLoaded: async () => [],
    getActive: async () => "dark",
    readFile: async () => null,
    importFile: async (filename: string) => `/themes/${filename}`,
    ...overrides,
  };
}

describe("listThemes", () => {
  it("always lists the built-ins with pinned swatches and marks the active one", async () => {
    const snapshot = await listThemes(port({ getActive: async () => "light" }));
    expect(snapshot.active).toBe("light");
    expect(snapshot.themes.map((entry) => entry.name)).toEqual(["dark", "light"]);
    expect(snapshot.themes[0]?.swatches).toEqual(BUILTIN_THEME_SWATCHES.dark);
    expect(snapshot.themes.find((entry) => entry.name === "light")?.active).toBe(true);
    expect(snapshot.themes.find((entry) => entry.name === "dark")?.active).toBe(false);
  });

  it("resolves swatches for file themes and keeps unreadable ones listed", async () => {
    const snapshot = await listThemes(
      port({
        listLoaded: async () => [
          { name: "mine", path: "/u/mine.json", scope: "user" },
          { name: "broken", path: "/u/broken.json", scope: "user" },
        ],
        readFile: async (path: string) =>
          path.endsWith("mine.json") ? themeFile("mine") : "not json{",
      }),
    );
    expect(snapshot.themes.map((entry) => entry.name)).toEqual(["dark", "light", "mine", "broken"]);
    expect(snapshot.themes[2]?.swatches.accent).toBe("#111111");
    expect(snapshot.themes[2]?.variant).toBe("dark");
    expect(snapshot.themes[3]?.swatches).toEqual({});
  });
});

describe("validateThemeImport", () => {
  it("accepts a matching name and rejects traversal, mismatches and partial files", () => {
    expect(validateThemeImport("mine.json", themeFile("mine"))).toEqual({ name: "mine" });
    expect(() => validateThemeImport("../evil.json", themeFile("evil"))).toThrow(ThemeError);
    expect(() => validateThemeImport("mine.json", themeFile("other"))).toThrow(/does not match/);
    expect(() => validateThemeImport("mine.json", themeFile("mine").slice(0, 20))).toThrow(
      ThemeError,
    );
    expect(() =>
      validateThemeImport(
        "mine.json",
        JSON.stringify({ name: "mine", colors: { accent: "#fff" } }),
      ),
    ).toThrow(/missing colors/);
  });
});

describe("createThemeHandlers", () => {
  it("validates before writing and returns the written path", async () => {
    const importFile = vi.fn(async (filename: string) => `/themes/${filename}`);
    const handlers = createThemeHandlers({ resolvePort: () => port({ importFile }) }).handlers();
    const result = (await handlers["themes.import"]?.(
      {
        filename: "mine.json",
        content: themeFile("mine"),
      },
      {} as never,
    )) as { name: string; path: string };
    expect(result).toEqual({ name: "mine", path: "/themes/mine.json" });
    expect(importFile).toHaveBeenCalledOnce();
    await expect(
      handlers["themes.import"]?.(
        { filename: "mine.json", content: themeFile("other") },
        {} as never,
      ),
    ).rejects.toThrow(ThemeError);
    expect(importFile).toHaveBeenCalledOnce();
  });

  it("answers not_implemented without a port", async () => {
    const handlers = createThemeHandlers({ resolvePort: () => null }).handlers();
    await expect(handlers["themes.list"]?.({}, {} as never)).rejects.toMatchObject({
      code: "not_implemented",
    });
  });
});
