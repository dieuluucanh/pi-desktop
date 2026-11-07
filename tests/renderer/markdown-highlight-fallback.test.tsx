import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Markdown } from "../../src/renderer/src/session/Markdown";

/**
 * Highlighting is a nicety, never a reason for the transcript to show nothing
 * (2026-11-07 transcript-highlight-stability).
 *
 * This lives in its own file because `Markdown.tsx` memoizes its Shiki import:
 * a rejecting `createHighlighter` resolves to `null` for the life of the module,
 * so a failure case in `markdown-highlight.test.tsx` would poison every later
 * test in that file. The store still caches nothing in this case, and the block
 * must paint its source text.
 */

vi.mock("shiki/bundle/web", () => ({
  createHighlighter: async () => {
    throw new Error("shiki is not available in this bundle");
  },
}));

describe("code block fallback", () => {
  it("renders the source text when the highlighter cannot load", async () => {
    const { container } = render(<Markdown>{"```bash\n# no shiki\necho plain\n```"}</Markdown>);

    // Let the failed import settle, then the block keeps its plain text.
    await waitFor(() => expect(container.querySelector("pre")).not.toBeNull());
    expect(container.querySelector("pre")?.textContent).toContain("# no shiki");
    expect(container.querySelector("pre")?.textContent).toContain("echo plain");
    expect(container.querySelector("pre span[style]")).toBeNull();
  });

  it("keeps the surrounding prose when a fence falls back", () => {
    render(<Markdown>{"Before.\n\n```\nplain fence\n```\n\nAfter."}</Markdown>);

    expect(screen.getByText("Before.")).toBeInTheDocument();
    expect(screen.getByText("After.")).toBeInTheDocument();
  });
});
