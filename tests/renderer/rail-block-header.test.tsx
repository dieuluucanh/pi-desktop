import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RailBlockHeader } from "../../src/renderer/src/rail/RailBlockHeader";

/**
 * The pinned block header (2026-10-30 rail-headers plan).
 *
 * `ChangesSection` and `HistorySection` both render this component, so the
 * sticky rule is asserted here once: a header that scrolls away takes the block's
 * name and its one block-wide control with it.
 */

describe("RailBlockHeader", () => {
  it("shows the title under the caller's test id", () => {
    render(<RailBlockHeader title="Commit History" testId="history-header" />);

    const header = screen.getByTestId("history-header");
    expect(header).toHaveTextContent("Commit History");
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("Commit History");
  });

  it("stays pinned to the top of its block with an opaque surface", () => {
    render(<RailBlockHeader title="Changes" testId="changes-header" />);

    const header = screen.getByTestId("changes-header");
    // Sticky against the block's own `overflow-y-auto`; `bg-surface` is what
    // stops rows ghosting through the header while it is stuck.
    expect(header.className).toContain("sticky");
    expect(header.className).toContain("top-0");
    expect(header.className).toContain("bg-surface");
    expect(header.className).toContain("border-line");
  });

  it("omits the badge rather than rendering a meaningless zero", () => {
    const { rerender } = render(<RailBlockHeader title="Changes" testId="h" />);
    expect(screen.queryByTestId("h-count")).not.toBeInTheDocument();

    rerender(<RailBlockHeader title="Changes" testId="h" count={3} countTestId="h-count" />);
    expect(screen.getByTestId("h-count")).toHaveTextContent("3");
  });

  it("keeps the refresh icon-only but fully named", async () => {
    const onRefresh = vi.fn();
    render(
      <RailBlockHeader
        title="Changes"
        testId="h"
        onRefresh={onRefresh}
        refreshLabel="Refresh changes"
      />,
    );

    const refresh = screen.getByRole("button", { name: "Refresh changes" });
    // The label beside a refresh arrow was pure repetition (2026-10-30 plan).
    expect(refresh.textContent?.trim()).toBe("");
    expect(refresh).toHaveAttribute("title", "Refresh changes");

    await userEvent.click(refresh);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("places extra trailing controls before the refresh button", () => {
    render(
      <RailBlockHeader
        title="Changes"
        testId="h"
        onRefresh={() => undefined}
        refreshLabel="Refresh changes"
      >
        <span data-testid="extra" />
      </RailBlockHeader>,
    );

    const header = screen.getByTestId("h");
    const extra = screen.getByTestId("extra");
    const refresh = screen.getByRole("button", { name: "Refresh changes" });
    expect(
      header.compareDocumentPosition(extra) & Node.DOCUMENT_POSITION_CONTAINED_BY,
    ).toBeTruthy();
    expect(extra.compareDocumentPosition(refresh) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders no refresh button when the caller supplies no action", () => {
    render(<RailBlockHeader title="Changes" testId="h" refreshLabel="Refresh changes" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
