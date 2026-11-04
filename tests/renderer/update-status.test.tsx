import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { StatusBar } from "../../src/renderer/src/layout/StatusBar";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { initialUpdateState, type UpdateState } from "../../src/shared/updates";
import { appInfoFixture, installBridge } from "./fixtures";

/**
 * The status-bar update chip (2026-11-01 update plan). It is the only update
 * chrome outside Settings: available/downloaded are dismissible links, a manual
 * check/download shows a short label, and every silent phase renders nothing.
 */

beforeEach(() => {
  installBridge({ update: initialUpdateState(true) });
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    info: appInfoFixture(),
    project: null,
    hint: null,
    update: null,
    view: "welcome",
    settingsFocus: null,
  });
});

function set(partial: Partial<UpdateState>): void {
  useAppStore.setState({ update: { ...initialUpdateState(true), ...partial } });
}

describe("status-bar update chip", () => {
  it("renders nothing for the non-actionable phases", () => {
    set({ phase: "idle" });
    const { container, rerender } = render(<StatusBar />);
    expect(container.querySelector('[data-testid="status-update"]')).toBeNull();

    for (const phase of ["idle", "up-to-date", "unsupported", "no-feed", "error"] as const) {
      set({ phase });
      rerender(<StatusBar />);
      expect(container.querySelector('[data-testid="status-update"]')).toBeNull();
    }

    set({ phase: "checking", lastCheckWasAutomatic: true });
    rerender(<StatusBar />);
    expect(container.querySelector('[data-testid="status-update"]')).toBeNull();
  });

  it("offers an available version and opens Settings", async () => {
    const user = userEvent.setup();
    set({ phase: "available", version: "0.4.0" });
    render(<StatusBar />);

    const chip = screen.getByTestId("status-update");
    expect(chip).toHaveTextContent("Update v0.4.0");
    await user.click(screen.getByRole("button", { name: "Update v0.4.0" }));

    expect(useAppStore.getState().view).toBe("settings");
    expect(useAppStore.getState().settingsFocus).toBe("updates");
  });

  it("hides a dismissed version and keeps the preference", async () => {
    const user = userEvent.setup();
    set({ phase: "available", version: "0.4.0" });
    render(<StatusBar />);

    await user.click(screen.getByRole("button", { name: "Dismiss update notification" }));

    expect(useAppStore.getState().prefs.updates.dismissedVersion).toBe("0.4.0");
    expect(screen.queryByTestId("status-update")).not.toBeInTheDocument();
  });

  it("shows a ready build and a download in progress", async () => {
    const user = userEvent.setup();
    set({ phase: "downloaded", version: "0.4.0" });
    const { rerender } = render(<StatusBar />);
    expect(screen.getByTestId("status-update")).toHaveTextContent("Restart to update");
    await user.click(screen.getByRole("button", { name: "Restart to update" }));
    expect(useAppStore.getState().settingsFocus).toBe("updates");

    set({ phase: "downloading", version: "0.4.0", percent: 42 });
    rerender(<StatusBar />);
    expect(screen.getByTestId("status-update")).toHaveTextContent("Updating 42%");
    expect(
      screen.queryByRole("button", { name: "Dismiss update notification" }),
    ).not.toBeInTheDocument();
  });

  it("shows a manual check but not the background one", () => {
    set({ phase: "checking", lastCheckWasAutomatic: false });
    const { rerender } = render(<StatusBar />);
    expect(screen.getByTestId("status-update")).toHaveTextContent("Checking for updates…");

    set({ phase: "checking", lastCheckWasAutomatic: true });
    rerender(<StatusBar />);
    expect(screen.queryByTestId("status-update")).not.toBeInTheDocument();
  });

  it("lets the user close a status message", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ hint: "No published release was found for this build." });
    render(<StatusBar />);

    expect(screen.getByTestId("status-hint")).toHaveTextContent("No published release");
    await user.click(screen.getByRole("button", { name: "Dismiss status message" }));

    expect(useAppStore.getState().hint).toBeNull();
    expect(screen.queryByTestId("status-hint")).not.toBeInTheDocument();
  });
});
