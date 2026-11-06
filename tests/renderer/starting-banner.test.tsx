import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StartingBanner } from "../../src/renderer/src/session/StartingBanner";

/**
 * The "starting" affordance (2026-11-06 hang plan, step 4).
 *
 * A slow open used to be indistinguishable from a hang: blank transcript, a
 * composer that accepted text, and no explanation. The banner names the reason,
 * counts the seconds and offers Cancel.
 */

describe("starting banner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names the work before the first second has passed", () => {
    render(<StartingBanner onCancel={() => undefined} />);

    expect(screen.getByTestId("session-starting")).toHaveTextContent("Starting the session…");
    expect(screen.getByTestId("session-starting")).toHaveTextContent(
      "Loading this session's history and extensions.",
    );
  });

  it("counts the seconds since this tab started opening", () => {
    render(<StartingBanner onCancel={() => undefined} />);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });

    expect(screen.getByTestId("session-starting")).toHaveTextContent("Starting the session — 3s");
  });

  it("offers Cancel as the one action that always works", () => {
    const onCancel = vi.fn();
    render(<StartingBanner onCancel={onCancel} />);

    fireEvent.click(screen.getByTestId("session-starting-cancel"));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
