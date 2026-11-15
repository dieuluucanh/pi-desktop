import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewBar } from "../../src/renderer/src/session/ReviewBar";

/**
 * The Review bar (2026-11-14 review-mode-isolation plan step 12).
 *
 * Review owns the turn, so Pause/Resume/Abort must be reachable without typing
 * a slash command. The handoff phase is the exception: the reviewer has already
 * finished, so the only primary action is opening the review tab.
 */

const handlers = () => ({
  onPause: vi.fn(),
  onResume: vi.fn(),
  onAbort: vi.fn(),
  onOpenReview: vi.fn(),
});

describe("ReviewBar", () => {
  it("offers Pause and Abort while the reviewer runs", () => {
    const events = handlers();
    render(<ReviewBar phase="running" canOpenReview={false} {...events} />);

    expect(screen.getByTestId("review-bar")).toHaveAttribute("data-phase", "running");
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Abort" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open review tab" })).toBeNull();
    expect(screen.getByTestId("review-bar")).toHaveTextContent("modes locked");

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.click(screen.getByRole("button", { name: "Abort" }));
    expect(events.onPause).toHaveBeenCalledTimes(1);
    expect(events.onAbort).toHaveBeenCalledTimes(1);
  });

  it("offers Resume and Abort while a review is paused", () => {
    const events = handlers();
    render(<ReviewBar phase="paused" canOpenReview={false} {...events} />);

    expect(screen.getByTestId("review-bar")).toHaveAttribute("data-phase", "paused");
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    fireEvent.click(screen.getByRole("button", { name: "Abort" }));
    expect(events.onResume).toHaveBeenCalledTimes(1);
    expect(events.onAbort).toHaveBeenCalledTimes(1);
  });

  it("opens the linked review tab during the handoff and has nothing to abort", () => {
    const events = handlers();
    render(<ReviewBar phase="handoff" canOpenReview {...events} />);

    expect(screen.getByTestId("review-bar")).toHaveAttribute("data-phase", "handoff");
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Abort" })).toBeNull();
    expect(screen.getByTestId("review-bar")).toHaveTextContent(
      "Awaiting your decision in the review tab",
    );

    fireEvent.click(screen.getByRole("button", { name: "Open review tab" }));
    expect(events.onOpenReview).toHaveBeenCalledTimes(1);
  });

  it("stays command-only in the handoff when no review tab is linked", () => {
    const events = handlers();
    render(<ReviewBar phase="handoff" canOpenReview={false} {...events} />);

    expect(screen.queryByRole("button", { name: "Open review tab" })).toBeNull();
    expect(screen.getByTestId("review-bar")).toHaveTextContent(
      "Awaiting your decision in the review tab",
    );
  });
});
