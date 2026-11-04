import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_EDITOR_CONFIG,
  applyEditorStyle,
  detectIndent,
  editorConfigGlobToRegex,
  editorConfigPatternMatches,
  parseEditorConfig,
  resolveEditorConfig,
  type EditorConfigIo,
} from "../../src/workspace/editorconfig";

function fakeConfigs(files: Record<string, string>): EditorConfigIo {
  const byKey = new Map(Object.entries(files).map(([path, text]) => [resolve(path), text]));
  return {
    async readTextFile(target) {
      return byKey.get(resolve(target)) ?? null;
    },
  };
}

describe("parseEditorConfig", () => {
  it("parses globals, sections and root", () => {
    const parsed = parseEditorConfig(
      [
        "root = true",
        "",
        "# comment",
        "indent_style = space",
        "indent_size = 2",
        "",
        "[*.ts]",
        "indent_size = 4",
        "",
        "[*.md]",
        "trim_trailing_whitespace = false",
      ].join("\n"),
    );
    expect(parsed.root).toBe(true);
    expect(parsed.globals).toEqual({ indent_style: "space", indent_size: "2" });
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.sections[0]).toEqual({ pattern: "*.ts", values: { indent_size: "4" } });
    expect(parsed.sections[1]).toEqual({
      pattern: "*.md",
      values: { trim_trailing_whitespace: "false" },
    });
  });

  it("ignores blank lines, comments and malformed lines", () => {
    expect(parseEditorConfig("\n#x\n;y\nnot a pair\n[]\n")).toEqual({
      root: false,
      globals: {},
      sections: [],
    });
  });
});

describe("glob matching", () => {
  it("translates the supported glob shapes", () => {
    expect(editorConfigGlobToRegex("*")).toBe("[^/]*");
    expect(editorConfigGlobToRegex("**")).toBe(".*");
    expect(editorConfigGlobToRegex("*.{ts,tsx}")).toBe("[^/]*\\.(?:ts|tsx)");
  });

  it("matches names without a slash at any depth", () => {
    expect(editorConfigPatternMatches("*", "src/app.ts")).toBe(true);
    expect(editorConfigPatternMatches("*.ts", "src/app.ts")).toBe(true);
    expect(editorConfigPatternMatches("*.ts", "src/app.js")).toBe(false);
  });

  it("matches paths with a slash against the whole relative path", () => {
    expect(editorConfigPatternMatches("src/**", "src/lib/app.ts")).toBe(true);
    expect(editorConfigPatternMatches("src/**", "other/app.ts")).toBe(false);
    expect(editorConfigPatternMatches("**/*.md", "docs/readme.md")).toBe(true);
  });

  it("supports braces and character classes", () => {
    expect(editorConfigPatternMatches("*.{ts,tsx}", "a.tsx")).toBe(true);
    expect(editorConfigPatternMatches("*.{ts,tsx}", "a.js")).toBe(false);
    expect(editorConfigPatternMatches("file[0-9].ts", "file3.ts")).toBe(true);
    expect(editorConfigPatternMatches("file[!0-9].ts", "filex.ts")).toBe(true);
  });
});

describe("resolveEditorConfig", () => {
  it("applies root and nested configs in order", async () => {
    const io = fakeConfigs({
      "/project/.editorconfig": [
        "root = true",
        "indent_style = space",
        "indent_size = 2",
        "end_of_line = lf",
      ].join("\n"),
      "/project/src/.editorconfig": ["[*.ts]", "indent_size = 4"].join("\n"),
    });
    const config = await resolveEditorConfig(io, "/project", "src/app.ts");
    expect(config.indentStyle).toBe("space");
    expect(config.indentSize).toBe(4);
    expect(config.endOfLine).toBe("lf");
    expect(config.insertFinalNewline).toBe(DEFAULT_EDITOR_CONFIG.insertFinalNewline);
  });

  it("uses the nearest config and respects root = true", async () => {
    const io = fakeConfigs({
      "/project/.editorconfig": ["indent_size = 2"].join("\n"),
      "/project/src/.editorconfig": ["root = true", "indent_size = 3"].join("\n"),
    });
    expect((await resolveEditorConfig(io, "/project", "src/app.ts")).indentSize).toBe(3);
  });

  it("resolves indent_size = tab from tab_width", async () => {
    const io = fakeConfigs({
      "/project/.editorconfig": ["indent_style = tab", "indent_size = tab", "tab_width = 8"].join(
        "\n",
      ),
    });
    const config = await resolveEditorConfig(io, "/project", "app.ts");
    expect(config.indentStyle).toBe("tab");
    expect(config.indentSize).toBe(8);
    expect(config.tabWidth).toBe(8);
  });

  it("applies eol and whitespace flags", async () => {
    const io = fakeConfigs({
      "/project/.editorconfig": [
        "[*.md]",
        "end_of_line = crlf",
        "insert_final_newline = false",
        "trim_trailing_whitespace = false",
      ].join("\n"),
    });
    const config = await resolveEditorConfig(io, "/project", "README.md");
    expect(config.endOfLine).toBe("crlf");
    expect(config.insertFinalNewline).toBe(false);
    expect(config.trimTrailingWhitespace).toBe(false);
  });

  it("falls back to the defaults when no config exists", async () => {
    expect(await resolveEditorConfig(fakeConfigs({}), "/project", "app.ts")).toEqual(
      DEFAULT_EDITOR_CONFIG,
    );
  });
});

describe("applyEditorStyle", () => {
  it("trims trailing whitespace and inserts one final newline", () => {
    expect(
      applyEditorStyle("a  \nb\t\n", {
        trimTrailingWhitespace: true,
        insertFinalNewline: true,
      }),
    ).toBe("a\nb\n");
    expect(applyEditorStyle("a", { trimTrailingWhitespace: true, insertFinalNewline: true })).toBe(
      "a\n",
    );
  });

  it("leaves whitespace alone when disabled", () => {
    expect(
      applyEditorStyle("a  \n\n", {
        trimTrailingWhitespace: false,
        insertFinalNewline: false,
      }),
    ).toBe("a  \n\n");
  });
});

describe("detectIndent", () => {
  it("detects spaces and the smallest unit", () => {
    expect(detectIndent("  a\n    b\n  c\n")).toEqual({
      indentStyle: "space",
      indentSize: 2,
      tabWidth: 2,
    });
    expect(detectIndent("    a\n        b\n")).toEqual({
      indentStyle: "space",
      indentSize: 4,
      tabWidth: 4,
    });
  });

  it("detects tabs", () => {
    expect(detectIndent("\ta\n\t\tb\n c\n")).toMatchObject({
      indentStyle: "tab",
      indentSize: 4,
    });
  });

  it("defaults to two spaces for a flat document", () => {
    expect(detectIndent("a\nb\n")).toEqual({
      indentStyle: "space",
      indentSize: 2,
      tabWidth: 2,
    });
  });
});
