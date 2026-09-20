import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  activeThemeSwatches,
  ansi256ToHex,
  BUILTIN_THEME_SWATCHES,
  parseThemeDocument,
  resolveThemeColor,
  resolveThemeSwatches,
  sanitizeThemesSnapshot,
  themeCssVariables,
  ThemeDocumentError,
  themeVariantFromText,
  type ParsedThemeDocument,
} from "../../src/shared/themes";

function sdkTheme(name: "dark" | "light"): {
  vars: Record<string, string>;
  colors: Record<string, string | number>;
} {
  const document = JSON.parse(
    readFileSync(
      join(
        process.cwd(),
        `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/${name}.json`,
      ),
      "utf8",
    ),
  ) as { vars: Record<string, string>; colors: Record<string, string | number> };
  return { vars: document.vars, colors: document.colors };
}

describe("built-in swatches", () => {
  it.each(["dark", "light"] as const)(
    "matches the SDK's %s theme (drift fails the test)",
    (name) => {
      const sdk = sdkTheme(name);
      const resolved = resolveThemeSwatches({ name, vars: sdk.vars, colors: sdk.colors });
      expect(resolved).toEqual(BUILTIN_THEME_SWATCHES[name]);
    },
  );
});

describe("parseThemeDocument", () => {
  it("accepts a complete document", () => {
    const sdk = sdkTheme("dark");
    const parsed = parseThemeDocument(
      JSON.stringify({ name: "mine", vars: sdk.vars, colors: sdk.colors }),
    );
    expect(parsed.name).toBe("mine");
  });

  it("rejects malformed input with a readable error", () => {
    expect(() => parseThemeDocument("not json")).toThrow(ThemeDocumentError);
    expect(() => parseThemeDocument(JSON.stringify({ colors: {} }))).toThrow(/name/);
    expect(() =>
      parseThemeDocument(JSON.stringify({ name: "x", colors: { accent: "#fff" } })),
    ).toThrow(/missing colors/);
  });
});

describe("resolveThemeColor", () => {
  it("passes hex through, resolves vars, maps palette indexes", () => {
    expect(resolveThemeColor("#ABCDEF", {})).toBe("#abcdef");
    expect(resolveThemeColor("#abc", {})).toBe("#aabbcc");
    expect(resolveThemeColor("accent", { accent: "#112233" })).toBe("#112233");
    expect(resolveThemeColor("nope", {})).toBeNull();
    expect(resolveThemeColor(9, {})).toBe("#ff0000");
  });
});

describe("ansi256ToHex", () => {
  it("covers the base, cube and gray ramp", () => {
    expect(ansi256ToHex(0)).toBe("#000000");
    expect(ansi256ToHex(15)).toBe("#ffffff");
    expect(ansi256ToHex(16)).toBe("#000000");
    expect(ansi256ToHex(231)).toBe("#ffffff");
    expect(ansi256ToHex(232)).toBe("#080808");
  });
});

describe("themeVariantFromText", () => {
  it("treats light text as a dark theme", () => {
    expect(themeVariantFromText("#d4d4d4")).toBe("dark");
    expect(themeVariantFromText("#1f2328")).toBe("light");
    expect(themeVariantFromText(null)).toBe("dark");
  });
});

describe("resolveThemeSwatches", () => {
  it("falls back per key instead of failing the theme", () => {
    const parsed: ParsedThemeDocument = {
      name: "partial",
      vars: {},
      colors: { accent: "#123456", text: "#eeeeee" } as ParsedThemeDocument["colors"],
    };
    const swatches = resolveThemeSwatches(parsed);
    expect(swatches.accent).toBe("#123456");
    expect(swatches.text).toBe("#eeeeee");
    expect(swatches.error).toMatch(/^#/);
  });
});

describe("themeCssVariables", () => {
  it("maps swatches onto the chrome tokens", () => {
    const variables = themeCssVariables(
      BUILTIN_THEME_SWATCHES.dark as Record<string, string>,
      "dark",
    );
    expect(variables["data-theme"]).toBe("dark");
    expect(variables["--color-accent"]).toBe("#8abeb7");
    expect(variables["--color-canvas"]).toBe("#18181e");
  });
});

describe("sanitizeThemesSnapshot", () => {
  it("drops hostile payloads and keeps valid rows", () => {
    const snapshot = sanitizeThemesSnapshot({
      active: "mine",
      themes: [
        {
          name: "mine",
          scope: "user",
          active: true,
          variant: "dark",
          swatches: { accent: "#112233" },
        },
        { name: 42 },
        "nope",
      ],
    });
    expect(snapshot.active).toBe("mine");
    expect(snapshot.themes).toHaveLength(1);
    expect(activeThemeSwatches(snapshot)?.name).toBe("mine");
    expect(activeThemeSwatches({ active: "dark", themes: [] })).toBeUndefined();
  });
});
