import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MULTILINE_TEXT_CLASS, MultilineText } from "../../src/renderer/src/ui/multiline-text";

/**
 * The shared verbatim-multiline primitive (2026-11-14 transcript-line-parity).
 *
 * jsdom cannot compute layout, so the class is the visual contract: every
 * extension plain-text surface must carry `whitespace-pre-wrap` (and
 * `break-words` for long paths). The text itself keeps its newlines and leading
 * indentation, which is what `ctx.ui.notify` sends from an extension.
 */

describe("MultilineText", () => {
  it("carries the line-preserving contract", () => {
    const { container } = render(
      <MultilineText data-testid="multiline">{"line one\n  line two"}</MultilineText>,
    );
    const element = screen.getByTestId("multiline");

    expect(element.className).toContain("whitespace-pre-wrap");
    expect(element.className).toContain("break-words");
    expect(element.className).toBe(MULTILINE_TEXT_CLASS);
    expect(container.textContent).toContain("line one\n  line two");
  });

  it("merges caller layout classes without dropping the contract", () => {
    render(
      <MultilineText data-testid="multiline" className="min-w-0 flex-1">
        body
      </MultilineText>,
    );

    const element = screen.getByTestId("multiline");
    expect(element.className).toContain("whitespace-pre-wrap");
    expect(element.className).toContain("break-words");
    expect(element.className).toContain("min-w-0");
    expect(element.className).toContain("flex-1");
  });

  it("forwards span attributes and renders nested content", () => {
    render(
      <MultilineText data-testid="multiline" title="full text">
        <strong>first</strong>
        {"\n"}
        <em>second</em>
      </MultilineText>,
    );

    const element = screen.getByTestId("multiline");
    expect(element).toHaveAttribute("title", "full text");
    expect(element.querySelector("strong")?.textContent).toBe("first");
    expect(element.querySelector("em")?.textContent).toBe("second");
  });
});
