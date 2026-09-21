import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UpdateBanner } from "../../src/renderer/src/updates/UpdateBanner";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { initialUpdateState, type UpdateState } from "../../src/shared/updates";
import { installBridge } from "./fixtures";

/**
 * The update banner (plan step 26) only renders the actionable phases: an offer,
 * progress, a ready build, a failure. Nothing to do means no banner — a
 * permanent "you are up to date" pill would be noise, and the status bar already
 * reports a manual check.
 */

beforeEach(() => {
  installBridge({ update: initialUpdateState(true) });
  useAppStore.setState({ update: null });
});

function set(state: Partial<UpdateState>): void {
  useAppStore.setState({ update: { ...initialUpdateState(true), ...state } });
}

describe("UpdateBanner (plan step 26)", () => {
  it("renders nothing for the non-actionable phases", () => {
    const { container } = render(<UpdateBanner />);
    expect(container).toBeEmptyDOMElement();

    for (const phase of ["idle", "checking", "up-to-date", "unsupported"] as const) {
      set({ phase });
      expect(render(<UpdateBanner />).container).toBeEmptyDOMElement();
    }
  });

  it("offers a download when an update is available", async () => {
    set({ phase: "available", version: "0.2.0" });
    const user = userEvent.setup();
    render(<UpdateBanner />);

    expect(screen.getByText("v0.2.0 available")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /download/i }));
    expect(
      (window.pi as unknown as { updates: { download: () => Promise<unknown> } }).updates,
    ).toBeDefined();
  });

  it("shows progress while downloading", () => {
    set({ phase: "downloading", version: "0.2.0", percent: 42 });
    render(<UpdateBanner />);
    expect(screen.getByText("Downloading 42%")).toBeInTheDocument();
    expect(screen.getByTestId("update-progress").firstElementChild).toHaveStyle({ width: "42%" });
  });

  it("offers a restart once the download finished", async () => {
    set({ phase: "downloaded", version: "0.2.0" });
    const user = userEvent.setup();
    render(<UpdateBanner />);
    expect(screen.getByText("v0.2.0 ready")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /restart/i }));
  });

  it("allows a retry after a failure", async () => {
    set({ phase: "error", error: "feed down" });
    const user = userEvent.setup();
    render(<UpdateBanner />);
    expect(screen.getByText("Update failed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /retry/i }));
  });
});
