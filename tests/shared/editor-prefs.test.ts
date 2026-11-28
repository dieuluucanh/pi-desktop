import { describe, expect, it } from "vitest";

import {
  DEFAULT_EDITOR_PREFS,
  DEFAULT_EDITOR_FONT_SIZE,
  MAX_EDITOR_FONT_SIZE,
  MAX_FORMATTERS,
  MAX_FORMATTER_COMMAND_LENGTH,
  MIN_EDITOR_FONT_SIZE,
  effectiveWordWrap,
  isSafeFormatterCommand,
  mergeEditorPrefs,
  sanitizeEditorPrefs,
  type EditorPrefs,
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

describe("legacy width keys", () => {
  it("drops the removed width keys instead of migrating them", () => {
    const sanitized = sanitizeEditorPrefs({ width: "compact", widthColumns: 72 });
    expect(sanitized).toEqual(DEFAULT_EDITOR_PREFS);
    expect("width" in sanitized).toBe(false);
    expect("widthColumns" in sanitized).toBe(false);
  });

  it("drops a legacy width key from a merge patch", () => {
    const merged = mergeEditorPrefs(DEFAULT_EDITOR_PREFS, { width: "compact" });
    expect(merged).toEqual(DEFAULT_EDITOR_PREFS);
    expect("width" in merged).toBe(false);
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
      formatters: { go: "gofmt" },
    };
    const merged = mergeEditorPrefs(current, { fontSize: 12 });
    expect(merged.fontSize).toBe(12);
    expect(merged.wordWrap).toBe("never");
    expect(merged.formatters).toEqual({ go: "gofmt" });
  });

  it("sanitizes the wrap field in the patch", () => {
    const merged = mergeEditorPrefs(DEFAULT_EDITOR_PREFS, { wordWrap: true });
    expect(merged.wordWrap).toBe("always");
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

  function prefsOf(wordWrap: EditorWordWrap): EditorPrefs {
    return { ...DEFAULT_EDITOR_PREFS, wordWrap };
  }

  it("treats markdown, mdx and plain text as prose", () => {
    expect(isProseLanguage("markdown")).toBe(true);
    expect(isProseLanguage("mdx")).toBe(true);
    expect(isProseLanguage("plaintext")).toBe(true);
    expect(isProseLanguage("typescript")).toBe(false);
    expect(isProseLanguage("json")).toBe(false);
    expect(isProseLanguage("css")).toBe(false);
  });

  it("wraps prose and not code under the default auto", () => {
    for (const languageId of ["markdown", "mdx", "plaintext"] as const) {
      expect(effectiveWordWrap(languageId, DEFAULT_EDITOR_PREFS), languageId).toBe(true);
    }
    for (const languageId of ["typescript", "json", "css"] as const) {
      expect(effectiveWordWrap(languageId, DEFAULT_EDITOR_PREFS), languageId).toBe(false);
    }
  });

  it("lets an explicit always or never win for every language", () => {
    for (const languageId of LANGUAGE_IDS) {
      expect(effectiveWordWrap(languageId, prefsOf("always")), languageId).toBe(true);
      expect(effectiveWordWrap(languageId, prefsOf("never")), languageId).toBe(false);
    }
  });

  it("resolves the wrap matrix for every language", () => {
    for (const languageId of LANGUAGE_IDS) {
      const prose = isProseLanguage(languageId);
      for (const wordWrap of WRAP_VALUES) {
        const expected = wordWrap === "auto" ? prose : wordWrap === "always";
        expect(effectiveWordWrap(languageId, prefsOf(wordWrap)), `${languageId}/${wordWrap}`).toBe(
          expected,
        );
      }
    }
  });
});
