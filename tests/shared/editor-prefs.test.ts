import { describe, expect, it } from "vitest";

import {
  DEFAULT_EDITOR_PREFS,
  DEFAULT_EDITOR_FONT_SIZE,
  MAX_EDITOR_FONT_SIZE,
  MAX_FORMATTERS,
  MAX_FORMATTER_COMMAND_LENGTH,
  MIN_EDITOR_FONT_SIZE,
  isSafeFormatterCommand,
  mergeEditorPrefs,
  sanitizeEditorPrefs,
} from "../../src/shared/editor-prefs";

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

  it("treats unknown booleans as off", () => {
    const prefs = sanitizeEditorPrefs({
      wordWrap: "yes",
      formatOnSave: 1,
      allowCommandFormatters: "true",
    });
    expect(prefs.wordWrap).toBe(false);
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
      wordWrap: true,
      formatters: { go: "gofmt" },
    };
    const merged = mergeEditorPrefs(current, { fontSize: 12 });
    expect(merged.fontSize).toBe(12);
    expect(merged.wordWrap).toBe(true);
    expect(merged.formatters).toEqual({ go: "gofmt" });
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
