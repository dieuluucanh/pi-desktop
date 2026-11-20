import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { Markdown } from "../../src/renderer/src/session/Markdown";
import { FindPatternContext } from "../../src/renderer/src/session/find-context";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";

/**
 * Markdown block/inline contract (2026-11-06 transcript-markdown-parity).
 *
 * `react-markdown` 10 calls the `code` renderer for both an inline span and a
 * `pre > code` block and has no `inline` prop. The desktop used to send both to
 * `CodeBlock`, so a span like `` `never` `` became a block-level `<pre>` inside
 * the sentence. These tests pin the structural split, including the
 * language-less fence a class-based check would regress on, and the find-mark
 * case that used to render `[object Object]`.
 */

beforeEach(() => {
  // MermaidBlock reads `prefs`/`settings` when a fence asks for it.
  useAppStore.setState({ prefs: { ...DEFAULT_PREFS }, settings: { global: {}, project: {} } });
});

describe("inline code", () => {
  it("stays inside its paragraph instead of becoming a block", () => {
    const { container } = render(<Markdown>{"(commit policy `never`)."}</Markdown>);

    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelector("p code")?.textContent).toBe("never");
    expect(container.querySelector("p")?.textContent).toBe("(commit policy never).");
  });

  it("keeps several spans in one paragraph, punctuation included", () => {
    const { container } = render(
      <Markdown>{"Run `tui.resize`, `tui.state`, `messages.get`, etc. now."}</Markdown>,
    );

    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.querySelectorAll("p code")).toHaveLength(3);
    expect(container.querySelector("p")?.textContent).toBe(
      "Run tui.resize, tui.state, messages.get, etc. now.",
    );
  });

  it("uses the inline pill style rather than the code-block chrome", () => {
    const { container } = render(<Markdown>{"a `span` here"}</Markdown>);
    const span = container.querySelector("p code");

    expect(span?.className).toContain("bg-code-bg");
    expect(span?.className).toContain("font-mono");
    expect(span?.className).not.toContain("p-3");
  });
});

describe("code blocks", () => {
  it("renders a language fence as exactly one block", () => {
    const { container } = render(
      <Markdown>{"Before\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nAfter"}</Markdown>,
    );

    expect(container.querySelectorAll("pre")).toHaveLength(1);
    expect(container.querySelector("pre code")?.textContent).toContain("const a = 1;");
    expect(container.querySelector("pre code")?.textContent).toContain("const b = 2;");
    expect(container.querySelectorAll("p")).toHaveLength(2);
  });

  it("renders a fence without an info string as a block", () => {
    // This is the case a `language-*` heuristic would regress: `className` is
    // absent on the `code` element, exactly like an inline span.
    const { container } = render(<Markdown>{"```\nplain text\n```"}</Markdown>);

    expect(container.querySelectorAll("pre")).toHaveLength(1);
    expect(container.querySelector("pre code")?.textContent).toContain("plain text");
    expect(container.querySelector("p")).toBeNull();
  });

  it("renders an indented block as a block", () => {
    const { container } = render(<Markdown>{"    const a = 1;"}</Markdown>);

    expect(container.querySelectorAll("pre")).toHaveLength(1);
    expect(container.querySelector("pre code")?.textContent).toContain("const a = 1;");
  });

  it("keeps the single pre > code shape after the renderer hoist", () => {
    // 2026-11-07 transcript-highlight-stability: the element overrides moved to
    // module scope, so a block must still be exactly one `pre > code` — a nested
    // or duplicated wrapper would break both copy and the token cache key.
    const { container } = render(<Markdown>{"```ts\nconst a = 1;\n```"}</Markdown>);

    expect(container.querySelectorAll("pre")).toHaveLength(1);
    expect(container.querySelector("pre > code")).not.toBeNull();
    expect(container.querySelector("pre code")?.textContent).toContain("const a = 1;");
  });
});

describe("soft line breaks (terminal parity)", () => {
  it("renders a single newline as a line break, like terminal Pi", () => {
    // 2026-11-14 transcript-line-parity: pi-tui keeps every `\n` inside inline
    // text; CommonMark alone would collapse this into one space.
    const { container } = render(<Markdown>{"line one\nline two"}</Markdown>);

    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.querySelectorAll("p br")).toHaveLength(1);
    expect(container.querySelector("p")?.textContent).toContain("line one");
    expect(container.querySelector("p")?.textContent).toContain("line two");
  });

  it("keeps every struck Build Complete TODO on its own line", () => {
    const source = "**Build Complete! ✓**\n\n~~1. first~~\n~~2. second~~\n~~3. third~~";
    const { container } = render(<Markdown>{source}</Markdown>);

    expect(container.querySelectorAll("del")).toHaveLength(3);
    expect(container.querySelectorAll("p br")).toHaveLength(2);
    expect([...container.querySelectorAll("del")].map((el) => el.textContent)).toEqual([
      "1. first",
      "2. second",
      "3. third",
    ]);
  });

  it("does not turn blank lines or fenced code into breaks", () => {
    const { container } = render(
      <Markdown>{"Before\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nAfter"}</Markdown>,
    );

    expect(container.querySelectorAll("p")).toHaveLength(2);
    expect(container.querySelectorAll("p br")).toHaveLength(0);
    expect(container.querySelector("pre br")).toBeNull();
    expect(container.querySelector("pre code")?.textContent).toContain("const b = 2;");
  });

  it("keeps inline code inline across a soft break", () => {
    const { container } = render(<Markdown>{"Run `a` then\n`b`."}</Markdown>);

    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.querySelectorAll("p code")).toHaveLength(2);
    expect(container.querySelectorAll("p br")).toHaveLength(1);
  });

  it("still paints a find mark within a line after the break", () => {
    const { container } = render(
      <FindPatternContext.Provider value={/needle/gi}>
        <Markdown>{"first line\nneedle here"}</Markdown>
      </FindPatternContext.Provider>,
    );

    expect(container.querySelector("p mark.pi-find")?.textContent).toBe("needle");
    expect(container.querySelectorAll("p br")).toHaveLength(1);
  });
});

describe("find highlighting in code", () => {
  it("keeps the span text and lets the mark render inline", () => {
    const { container } = render(
      <FindPatternContext.Provider value={/needle/gi}>
        <Markdown>{"Use `needle` here."}</Markdown>
      </FindPatternContext.Provider>,
    );

    expect(container.querySelector("p code mark.pi-find")?.textContent).toBe("needle");
    expect(container.querySelector("p code")?.textContent).toBe("needle");
  });

  it("renders a matched fence exactly, without stringifying the mark", () => {
    const { container } = render(
      <FindPatternContext.Provider value={/needle/gi}>
        <Markdown>{"```\nconst needle = 1;\n```"}</Markdown>
      </FindPatternContext.Provider>,
    );

    expect(container.querySelector("pre code")?.textContent).toContain("const needle = 1;");
    expect(container.querySelector("pre mark")).toBeNull();
    expect(container.textContent).not.toContain("[object Object]");
  });
});
