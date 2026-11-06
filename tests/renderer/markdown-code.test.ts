import { describe, expect, it } from "vitest";
import { blockCodeOf } from "../../src/renderer/src/session/markdown-code";

/**
 * The `pre > code` extractor (2026-11-06 transcript-markdown-parity).
 *
 * The renderer must not decide block vs inline from a `language-*` class: a
 * fence without an info string has no class. These cases pin the AST shape the
 * renderer relies on, including the `<mark>` wrappers the transcript find bar
 * inserts into text nodes.
 */

function text(value: string): Record<string, unknown> {
  return { type: "text", value };
}

function code(
  children: unknown[],
  properties: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type: "element", tagName: "code", properties, children };
}

function pre(children: unknown[]): Record<string, unknown> {
  return { type: "element", tagName: "pre", properties: {}, children };
}

describe("blockCodeOf", () => {
  it("reads a language-tagged fence", () => {
    expect(
      blockCodeOf(pre([code([text("const a = 1;\n")], { className: ["language-ts"] })])),
    ).toEqual({ code: "const a = 1;", language: "ts" });
  });

  it("treats a fence without a language as a block", () => {
    // `className` is absent for ``` with no info string, so a class check would
    // misclassify this as inline.
    expect(blockCodeOf(pre([code([text("plain\n")])]))).toEqual({
      code: "plain",
      language: null,
    });
  });

  it("accepts a space-separated className as well as an array", () => {
    expect(blockCodeOf(pre([code([text("ls\n")], { className: "language-bash other" })]))).toEqual({
      code: "ls",
      language: "bash",
    });
  });

  it("finds the first language class among several", () => {
    expect(
      blockCodeOf(pre([code([text("x\n")], { className: ["hljs", "language-yml"] })])),
    ).toEqual({ code: "x", language: "yml" });
  });

  it("flattens a find-highlight mark instead of stringifying it", () => {
    const marked = pre([
      code([
        text("const "),
        { type: "element", tagName: "mark", children: [text("needle")] },
        text(" = 1;\n"),
      ]),
    ]);
    expect(blockCodeOf(marked)).toEqual({ code: "const needle = 1;", language: null });
  });

  it("strips exactly one trailing newline", () => {
    expect(blockCodeOf(pre([code([text("a\n\n")])]))?.code).toBe("a\n");
  });

  it("keeps an empty fence as a block", () => {
    expect(blockCodeOf(pre([code([])]))).toEqual({ code: "", language: null });
  });

  it("returns null for an inline code span", () => {
    expect(blockCodeOf(code([text("never")]))).toBeNull();
  });

  it("returns null for a pre without a code child", () => {
    expect(blockCodeOf(pre([text("raw")]))).toBeNull();
  });

  it("returns null for a non-element or a missing node", () => {
    expect(blockCodeOf(undefined)).toBeNull();
    expect(blockCodeOf(null)).toBeNull();
    expect(blockCodeOf("pre")).toBeNull();
    expect(blockCodeOf({ type: "text", value: "x" })).toBeNull();
  });
});
