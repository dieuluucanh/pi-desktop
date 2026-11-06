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
