import { describe, expect, it } from "vitest";

import {
  DEFAULT_EDITOR_PREFS,
  DEFAULT_EDITOR_FONT_SIZE,
  DEFAULT_EDITOR_WIDTH_COLUMNS,
  MAX_EDITOR_FONT_SIZE,
  MAX_EDITOR_WIDTH_COLUMNS,
  MAX_FORMATTERS,
  MAX_FORMATTER_COMMAND_LENGTH,
  MIN_EDITOR_FONT_SIZE,
  MIN_EDITOR_WIDTH_COLUMNS,
  effectiveEditorWidth,
  effectiveWordWrap,
  isSafeFormatterCommand,
  mergeEditorPrefs,
  sanitizeEditorPrefs,
  shouldWrap,
  type EditorPrefs,
  type EditorWidth,
  type EditorWordWrap,
} from "../../src/shared/editor-prefs";
import { LANGUAGE_IDS, isProseLanguage } from "../../src/shared/languages";

describe("sanitizeEditorPrefs", () => {
  it("returns defaults for non-objects", () => {
    expect(sanitizeEditorPrefs(null)).toEqual(DEFAULT_EDITOR_PREFS);
    expect(sanitizeEditorPrefs("x")).toEqual(DEFAULT_EDITOR_PREFS);
    expect(sanitizeEditorPrefs([])).toEqual(DEFAULT_EDITOR_PREFS);
  });

  it("clamps the font size and defaults a missing value", () => {
    expect(sanitizeEditorPrefs({ fontSize: 4 }).fontSize).toBe(MIN_EDITOR_FONT_SIZE);
    expect(sanitizeEditorPrefs({ fontSize: 99 }).fontSize).toBe(MAX_EDITOR_FONT_SIZE);
    expect(sanitizeEditorPrefs({ fontSize: 14.6 }).fontSize).toBe(15);
    expect(sanitizeEditorPrefs({ fontSize: Number.NaN }).fontSize).toBe(DEFAULT_EDITOR_FONT_SIZE);
    expect(sanitizeEditorPrefs({ fontSize: "14" }).fontSize).toBe(DEFAULT_EDITOR_FONT_SIZE);
  });

  it("migrates the legacy boolean wordWrap", () => {
    expect(sanitizeEditorPrefs({ wordWrap: true }).wordWrap).toBe("always");
    expect(sanitizeEditorPrefs({ wordWrap: false }).wordWrap).toBe("auto");
  });

  it("keeps every known wordWrap value and defaults junk", () => {
    expect(sanitizeEditorPrefs({ wordWrap: "auto" }).wordWrap).toBe("auto");
    expect(sanitizeEditorPrefs({ wordWrap: "always" }).wordWrap).toBe("always");
    expect(sanitizeEditorPrefs({ wordWrap: "never" }).wordWrap).toBe("never");
    expect(sanitizeEditorPrefs({ wordWrap: "yes" }).wordWrap).toBe("auto");
    expect(sanitizeEditorPrefs({ wordWrap: 1 }).wordWrap).toBe("auto");
    expect(sanitizeEditorPrefs({}).wordWrap).toBe("auto");
  });

  it("keeps every known width value and defaults junk", () => {
    expect(sanitizeEditorPrefs({ width: "auto" }).width).toBe("auto");
    expect(sanitizeEditorPrefs({ width: "full" }).width).toBe("full");
    expect(sanitizeEditorPrefs({ width: "compact" }).width).toBe("compact");
    expect(sanitizeEditorPrefs({ width: "wide" }).width).toBe("auto");
    expect(sanitizeEditorPrefs({ width: 120 }).width).toBe("auto");
    expect(sanitizeEditorPrefs({}).width).toBe("auto");
  });

  it("clamps and rounds the compact column count", () => {
    expect(sanitizeEditorPrefs({ widthColumns: 59 }).widthColumns).toBe(MIN_EDITOR_WIDTH_COLUMNS);
    expect(sanitizeEditorPrefs({ widthColumns: 201 }).widthColumns).toBe(MAX_EDITOR_WIDTH_COLUMNS);
    expect(sanitizeEditorPrefs({ widthColumns: 100 }).widthColumns).toBe(100);
    expect(sanitizeEditorPrefs({ widthColumns: 80.4 }).widthColumns).toBe(80);
    expect(sanitizeEditorPrefs({ widthColumns: 80.6 }).widthColumns).toBe(81);
    expect(sanitizeEditorPrefs({ widthColumns: Number.NaN }).widthColumns).toBe(
      DEFAULT_EDITOR_WIDTH_COLUMNS,
    );
    expect(sanitizeEditorPrefs({ widthColumns: Number.POSITIVE_INFINITY }).widthColumns).toBe(
      DEFAULT_EDITOR_WIDTH_COLUMNS,
    );
    expect(sanitizeEditorPrefs({}).widthColumns).toBe(DEFAULT_EDITOR_WIDTH_COLUMNS);
    expect(sanitizeEditorPrefs({ widthColumns: "120" }).widthColumns).toBe(
      DEFAULT_EDITOR_WIDTH_COLUMNS,
    );
  });

  it("treats unknown booleans as off", () => {
    const prefs = sanitizeEditorPrefs({
      formatOnSave: 1,
      allowCommandFormatters: "true",
    });
    expect(prefs.formatOnSave).toBe(false);
    expect(prefs.allowCommandFormatters).toBe(false);
  });

  it("keeps only known languages and safe commands", () => {
    const prefs = sanitizeEditorPrefs({
      formatters: {
        go: "gofmt",
        python: "  ruff format -  ",
        notALanguage: "echo nope",
        rust: "rustfmt\nrm -rf /",
        typescript: "",
        java: "clang-format",
        cpp: "x".repeat(MAX_FORMATTER_COMMAND_LENGTH + 1),
      },
    });
    expect(prefs.formatters).toEqual({
      go: "gofmt",
      python: "ruff format -",
      java: "clang-format",
    });
  });

  it("caps the number of formatters", () => {
    const formatters: Record<string, string> = {};
    // Repeating a known id cannot exceed the map size; use the known set.
    const languages = ["go", "python", "rust", "typescript", "java", "cpp", "php", "ruby"];
    for (let index = 0; index < MAX_FORMATTERS + 10; index += 1) {
      const language = languages[index % languages.length] ?? "go";
      formatters[language] = `fmt-${index}`;
    }
    expect(Object.keys(sanitizeEditorPrefs({ formatters }).formatters)).toHaveLength(
      languages.length,
    );
  });
});

describe("isSafeFormatterCommand", () => {
  it("accepts one-line commands", () => {
    expect(isSafeFormatterCommand("gofmt")).toBe(true);
    expect(isSafeFormatterCommand("rustfmt --emit stdout")).toBe(true);
    expect(isSafeFormatterCommand("  ruff format -  ")).toBe(true);
  });

  it("rejects empty, multiline, control and oversized commands", () => {
    expect(isSafeFormatterCommand("")).toBe(false);
    expect(isSafeFormatterCommand("   ")).toBe(false);
    expect(isSafeFormatterCommand("a\nb")).toBe(false);
    expect(isSafeFormatterCommand("a\rb")).toBe(false);
    expect(isSafeFormatterCommand("a\u0000b")).toBe(false);
    expect(isSafeFormatterCommand("x".repeat(MAX_FORMATTER_COMMAND_LENGTH + 1))).toBe(false);
    expect(isSafeFormatterCommand(42)).toBe(false);
  });
});

describe("mergeEditorPrefs", () => {
  it("applies a partial patch and keeps untouched keys", () => {
    const current = {
      ...DEFAULT_EDITOR_PREFS,
      fontSize: 16,
      wordWrap: "never" as const,
      width: "compact" as const,
      widthColumns: 120,
      formatters: { go: "gofmt" },
    };
    const merged = mergeEditorPrefs(current, { fontSize: 12 });
    expect(merged.fontSize).toBe(12);
    expect(merged.wordWrap).toBe("never");
    expect(merged.width).toBe("compact");
    expect(merged.widthColumns).toBe(120);
    expect(merged.formatters).toEqual({ go: "gofmt" });
  });

  it("sanitizes the wrap and width fields in the patch", () => {
    const merged = mergeEditorPrefs(DEFAULT_EDITOR_PREFS, {
      wordWrap: true,
      width: "compact",
      widthColumns: 999,
    });
    expect(merged.wordWrap).toBe("always");
    expect(merged.width).toBe("compact");
    expect(merged.widthColumns).toBe(MAX_EDITOR_WIDTH_COLUMNS);
  });

  it("merges the formatter map instead of replacing it", () => {
    const current = { ...DEFAULT_EDITOR_PREFS, formatters: { go: "gofmt" } };
    const merged = mergeEditorPrefs(current, { formatters: { python: "ruff format -" } });
    expect(merged.formatters).toEqual({ go: "gofmt", python: "ruff format -" });
  });

  it("removes a formatter when its command becomes empty", () => {
    const current = { ...DEFAULT_EDITOR_PREFS, formatters: { go: "gofmt" } };
    expect(mergeEditorPrefs(current, { formatters: { go: "" } }).formatters).toEqual({});
  });
});

describe("effective view helpers", () => {
  const WRAP_VALUES: readonly EditorWordWrap[] = ["auto", "always", "never"];
  const WIDTH_VALUES: readonly EditorWidth[] = ["auto", "full", "compact"];

  function prefsOf(wordWrap: EditorWordWrap, width: EditorWidth): EditorPrefs {
    return { ...DEFAULT_EDITOR_PREFS, wordWrap, width };
  }

  it("treats markdown, mdx and plain text as prose", () => {
    expect(isProseLanguage("markdown")).toBe(true);
    expect(isProseLanguage("mdx")).toBe(true);
    expect(isProseLanguage("plaintext")).toBe(true);
    expect(isProseLanguage("typescript")).toBe(false);
    expect(isProseLanguage("json")).toBe(false);
    expect(isProseLanguage("css")).toBe(false);
  });

  it("resolves the defaults to wrap+compact for prose and no-wrap+full for code", () => {
    for (const languageId of ["markdown", "plaintext", "mdx"] as const) {
      expect(effectiveWordWrap(languageId, DEFAULT_EDITOR_PREFS)).toBe(true);
      expect(effectiveEditorWidth(languageId, DEFAULT_EDITOR_PREFS)).toBe("compact");
      expect(shouldWrap(languageId, DEFAULT_EDITOR_PREFS)).toBe(true);
    }
    expect(effectiveWordWrap("typescript", DEFAULT_EDITOR_PREFS)).toBe(false);
    expect(effectiveEditorWidth("typescript", DEFAULT_EDITOR_PREFS)).toBe("full");
    expect(shouldWrap("typescript", DEFAULT_EDITOR_PREFS)).toBe(false);
  });

  it("resolves the wrap x width matrix for prose and code", () => {
    const languageIds = ["markdown", "plaintext", "mdx", "typescript"] as const;
    for (const languageId of languageIds) {
      const prose = isProseLanguage(languageId);
      for (const wordWrap of WRAP_VALUES) {
        for (const width of WIDTH_VALUES) {
          const prefs = prefsOf(wordWrap, width);
          const label = `${languageId}/${wordWrap}/${width}`;
          const expectedWrap = wordWrap === "auto" ? prose : wordWrap === "always";
          const expectedWidth = width === "auto" ? (prose ? "compact" : "full") : width;
          const expectedShouldWrap = expectedWidth === "compact" || expectedWrap;

          expect(effectiveWordWrap(languageId, prefs), `${label} wrap`).toBe(expectedWrap);
          expect(effectiveEditorWidth(languageId, prefs), `${label} width`).toBe(expectedWidth);
          expect(shouldWrap(languageId, prefs), `${label} shouldWrap`).toBe(expectedShouldWrap);
        }
      }
    }
  });

  it("lets compact force wrapping even when wrap is never", () => {
    for (const languageId of ["markdown", "typescript"] as const) {
      const prefs = prefsOf("never", "compact");
      expect(effectiveWordWrap(languageId, prefs)).toBe(false);
      expect(effectiveEditorWidth(languageId, prefs)).toBe("compact");
      expect(shouldWrap(languageId, prefs)).toBe(true);
    }
  });

  it("leaves full + never unwrapped", () => {
    for (const languageId of ["markdown", "typescript"] as const) {
      const prefs = prefsOf("never", "full");
      expect(effectiveEditorWidth(languageId, prefs)).toBe("full");
      expect(effectiveWordWrap(languageId, prefs)).toBe(false);
      expect(shouldWrap(languageId, prefs)).toBe(false);
    }
  });

  it("honours an explicit wrap value for every language and width", () => {
    for (const languageId of LANGUAGE_IDS) {
      for (const width of WIDTH_VALUES) {
        expect(effectiveWordWrap(languageId, prefsOf("always", width)), languageId).toBe(true);
        expect(effectiveWordWrap(languageId, prefsOf("never", width)), languageId).toBe(false);
      }
    }
  });

  it("returns only full or compact for every language and preference", () => {
    for (const languageId of LANGUAGE_IDS) {
      for (const wordWrap of WRAP_VALUES) {
        for (const width of WIDTH_VALUES) {
          expect(["full", "compact"]).toContain(
            effectiveEditorWidth(languageId, prefsOf(wordWrap, width)),
          );
        }
      }
    }
  });
});
