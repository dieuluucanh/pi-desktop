import { readFileSync } from "node:fs";
import { join } from "node:path";
import { colorToRgb, parseColor } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import {
  activeThemeSwatches,
  ansi256ToHex,
  APP_CHROME_SWATCHES,
  BUILTIN_THEME_SWATCHES,
  contrastRatio,
  parseThemeDocument,
  resolvedChromeSwatches,
  resolveThemeColor,
  resolveThemeSwatches,
  sanitizeThemesSnapshot,
  themeCssVariables,
  ThemeDocumentError,
  THEME_CHROME_VARIABLES,
  THEME_COLOR_KEYS,
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
  ) as {
    vars: Record<string, string>;
    colors: Record<string, string | number>;
    export?: Record<string, string | number>;
  };
  // Pi 1.4 moved pageBg/cardBg into `export`; the host parser merges it.
  return { vars: document.vars, colors: { ...document.colors, ...(document.export ?? {}) } };
}

function sdkColor(value: string | number, vars: Record<string, string>): string | null {
  const raw = typeof value === "number" ? value : (vars[value] ?? value);
  try {
    const { r, g, b } = colorToRgb(parseColor(raw));
    return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return null;
  }
}

describe("built-in swatches", () => {
  it.each(["dark", "light"] as const)(
    "matches the SDK's %s theme (drift fails the test)",
    (name) => {
      const sdk = sdkTheme(name);
      const resolved = resolveThemeSwatches({ name, vars: sdk.vars, colors: sdk.colors }, sdkColor);
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
  const builtinDark = {
    name: "dark",
    scope: "builtin" as const,
    active: true,
    variant: "dark" as const,
    swatches: BUILTIN_THEME_SWATCHES.dark as Record<string, string>,
  };

  it("maps a theme onto all chrome tokens", () => {
    const variables = themeCssVariables(builtinDark);
    expect(variables["data-theme"]).toBe("dark");
    // Built-in surfaces use the app high-contrast palette, not Pi's dark JSON.
    expect(variables["--color-canvas"]).toBe(APP_CHROME_SWATCHES.dark.canvas);
    expect(variables["--color-line"]).toBe(APP_CHROME_SWATCHES.dark.line);
    expect(variables["--color-accent"]).toBe("#a798d7");
    // `info` is app-owned (Pi themes have no info foreground) and must be applied.
    expect(variables["--color-info"]).toBe(APP_CHROME_SWATCHES.dark.info);
    expect(THEME_CHROME_VARIABLES).toEqual(
      THEME_COLOR_KEYS.map((key) =>
        key === "lineStrong"
          ? "--color-line-strong"
          : key === "inkMuted"
            ? "--color-ink-muted"
            : key === "inkFaint"
              ? "--color-ink-faint"
              : `--color-${key}`,
      ),
    );
  });

  it("keeps a custom theme's surfaces and lets overrides win", () => {
    const custom = {
      name: "mine",
      scope: "user" as const,
      active: true,
      variant: "dark" as const,
      swatches: {
        canvas: "#111111",
        surface: "#222222",
        text: "#eeeeee",
        accent: "#ff0000",
      },
    };
    const resolved = resolvedChromeSwatches(custom, { line: "#123456", info: "#654321" });
    expect(resolved.canvas).toBe("#111111");
    expect(resolved.surface).toBe("#222222");
    expect(resolved.ink).toBe("#eeeeee");
    expect(resolved.line).toBe("#123456");
    expect(resolved.lineStrong).toBe(APP_CHROME_SWATCHES.dark.lineStrong);
    // A custom Pi theme still gets the app default unless the user overrides it.
    expect(resolved.info).toBe("#654321");
  });

  it("guards the dark separator contrast", () => {
    const dark = APP_CHROME_SWATCHES.dark;
    expect(contrastRatio(dark.line, dark.surface)).toBeGreaterThanOrEqual(2.5);
    expect(contrastRatio(dark.lineStrong, dark.surface)).toBeGreaterThanOrEqual(3);
  });

  it("keeps the info colour readable in both variants", () => {
    for (const variant of ["dark", "light"] as const) {
      const palette = APP_CHROME_SWATCHES[variant];
      expect(contrastRatio(palette.info, palette.surface)).toBeGreaterThanOrEqual(3);
    }
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
