import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewBar } from "../../src/renderer/src/session/ReviewBar";
import {
  REVIEW_HANDOFF_LINE,
  REVIEW_PAUSED_LINE,
  REVIEW_RUNNING_LINE,
} from "../../src/shared/workflow-mode";

/**
 * The Review row (2026-11-14 review-mode-isolation plan step 12; merged into one
 * line by the 2026-11-18 review-status-line plan).
 *
 * The row's text is the extension's `workflow-review` line; the tests pin that
 * it is rendered (ANSI stripped in the accessible text, full text in `title`)
 * and that each phase keeps the correct desktop controls.
 */

const handlers = () => ({
  onPause: vi.fn(),
  onResume: vi.fn(),
  onAbort: vi.fn(),
  onOpenReview: vi.fn(),
});

const RUNNING_TEXT = `${REVIEW_RUNNING_LINE} · pass 2/2 · 1 finding · ● verifying`;

describe("ReviewBar", () => {
  it("renders the extension's running line and offers Pause and Abort", () => {
    const events = handlers();
    render(<ReviewBar phase="running" text={RUNNING_TEXT} canOpenReview={false} {...events} />);

    expect(screen.getByTestId("review-bar")).toHaveAttribute("data-phase", "running");
    expect(screen.getByTestId("review-bar")).toHaveTextContent(RUNNING_TEXT);
    expect(screen.getByTitle(RUNNING_TEXT)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Abort" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open review tab" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.click(screen.getByRole("button", { name: "Abort" }));
    expect(events.onPause).toHaveBeenCalledTimes(1);
    expect(events.onAbort).toHaveBeenCalledTimes(1);
  });

  it("keeps ANSI colour in the line but strips it from the title", () => {
    const events = handlers();
    const colored = `\x1b[2m${RUNNING_TEXT}\x1b[0m`;
    render(<ReviewBar phase="running" text={colored} canOpenReview={false} {...events} />);

    expect(screen.getByTestId("review-bar")).toHaveTextContent(RUNNING_TEXT);
    expect(screen.getByTestId("review-bar").textContent).not.toContain("\x1b");
    expect(screen.getByTitle(RUNNING_TEXT)).toBeInTheDocument();
  });

  it("offers Resume and Abort while a review is paused", () => {
    const events = handlers();
    render(
      <ReviewBar phase="paused" text={REVIEW_PAUSED_LINE} canOpenReview={false} {...events} />,
    );

    expect(screen.getByTestId("review-bar")).toHaveAttribute("data-phase", "paused");
    expect(screen.getByTestId("review-bar")).toHaveTextContent(REVIEW_PAUSED_LINE);
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    fireEvent.click(screen.getByRole("button", { name: "Abort" }));
    expect(events.onResume).toHaveBeenCalledTimes(1);
    expect(events.onAbort).toHaveBeenCalledTimes(1);
  });

  it("opens the linked review tab during the handoff and has nothing to abort", () => {
    const events = handlers();
    render(<ReviewBar phase="handoff" text={REVIEW_HANDOFF_LINE} canOpenReview {...events} />);

    expect(screen.getByTestId("review-bar")).toHaveAttribute("data-phase", "handoff");
    expect(screen.getByTestId("review-bar")).toHaveTextContent(REVIEW_HANDOFF_LINE);
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Abort" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open review tab" }));
    expect(events.onOpenReview).toHaveBeenCalledTimes(1);
  });

  it("stays command-only in the handoff when no review tab is linked", () => {
    const events = handlers();
    render(
      <ReviewBar phase="handoff" text={REVIEW_HANDOFF_LINE} canOpenReview={false} {...events} />,
    );

    expect(screen.queryByRole("button", { name: "Open review tab" })).toBeNull();
    expect(screen.getByTestId("review-bar")).toHaveTextContent(REVIEW_HANDOFF_LINE);
  });

  it("falls back to the canonical line when the extension text is empty", () => {
    const events = handlers();
    const { rerender } = render(
      <ReviewBar phase="running" text="" canOpenReview={false} {...events} />,
    );
    expect(screen.getByTestId("review-bar")).toHaveTextContent(REVIEW_RUNNING_LINE);

    rerender(<ReviewBar phase="paused" text="   " canOpenReview={false} {...events} />);
    expect(screen.getByTestId("review-bar")).toHaveTextContent(REVIEW_PAUSED_LINE);
  });

  it("keeps the line flexible and the controls fixed", () => {
    const events = handlers();
    render(<ReviewBar phase="running" text={RUNNING_TEXT} canOpenReview={false} {...events} />);

    const line = screen.getByTitle(RUNNING_TEXT);
    expect(line.className).toContain("min-w-0");
    expect(line.className).toContain("flex-1");
    expect(line.className).toContain("overflow-hidden");
    expect(screen.getByRole("button", { name: "Pause" }).parentElement?.className).toContain(
      "shrink-0",
    );
  });
});
