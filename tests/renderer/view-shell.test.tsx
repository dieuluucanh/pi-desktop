import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ViewShell } from "../../src/renderer/src/views/ViewShell";

/**
 * The product views' frame.
 *
 * The reported bug: the scroll container was the centred reading column, so the
 * scrollbar sat in the middle of the window and the wheel did nothing over the
 * side gutters. The shell exists to keep those two jobs separate.
 */

describe("ViewShell", () => {
  it("scrolls the full main area and centres the content inside it", () => {
    render(
      <ViewShell width="standard" gap={5}>
        <p>content</p>
      </ViewShell>,
    );

    const scroll = screen.getByTestId("view-scroll");
    expect(scroll).toHaveClass("h-full", "overflow-y-auto");
    expect(scroll).not.toHaveClass("mx-auto");

    const content = screen.getByTestId("view-content");
    expect(content.parentElement).toBe(scroll);
    expect(content).toHaveClass("mx-auto", "w-full", "min-h-full", "max-w-4xl", "gap-5");
    // The inner column must not own scrolling: that was the bug.
    expect(content).not.toHaveClass("overflow-y-auto");
  });

  it("offers the narrow reading width and every gap", () => {
    const { rerender } = render(
      <ViewShell width="narrow" gap={6}>
        <p>content</p>
      </ViewShell>,
    );
    expect(screen.getByTestId("view-content")).toHaveClass("max-w-3xl", "gap-6");

    rerender(
      <ViewShell width="standard" gap={4}>
        <p>content</p>
      </ViewShell>,
    );
    expect(screen.getByTestId("view-content")).toHaveClass("max-w-4xl", "gap-4");
  });

  it("defaults to the wider column and the normal rhythm", () => {
    render(
      <ViewShell>
        <p>content</p>
      </ViewShell>,
    );
    expect(screen.getByTestId("view-content")).toHaveClass("max-w-4xl", "gap-5");
  });
});
