import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunStatusRow } from "../../src/renderer/src/session/RunStatusRow";

/**
 * The retry/compaction status row (2026-10-26 session-parity plan step 8).
 *
 * Terminal Pi's status indicators show a countdown and a way out. The row reads
 * its deadline from the event (`until`), so the countdown keeps moving with the
 * wall clock instead of a local counter.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe("RunStatusRow", () => {
  it("shows the retry attempt and a live countdown", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    render(
      <RunStatusRow
        status={{ kind: "retrying", attempt: 1, maxAttempts: 3, until: Date.now() + 5_000 }}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText("Retrying (1/3) in 5s…")).toBeInTheDocument();
    expect(screen.getByText("Esc to cancel")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByText("Retrying (1/3) in 3s…")).toBeInTheDocument();
  });

  it("never counts below zero", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    render(
      <RunStatusRow
        status={{ kind: "retrying", attempt: 2, maxAttempts: 3, until: Date.now() - 5_000 }}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText("Retrying (2/3) in 0s…")).toBeInTheDocument();
  });

  it("labels compaction and branch summarization", () => {
    const { rerender } = render(
      <RunStatusRow status={{ kind: "compacting" }} onCancel={() => {}} />,
    );
    expect(screen.getByText("Compacting the conversation…")).toBeInTheDocument();

    rerender(
      <RunStatusRow
        status={{ kind: "summarizing", attempt: 1, maxAttempts: 2, until: Date.now() }}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/Summarizing the abandoned branch \(1\/2\)/)).toBeInTheDocument();
  });

  it("cancels through the button", () => {
    const onCancel = vi.fn();
    render(<RunStatusRow status={{ kind: "compacting" }} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
