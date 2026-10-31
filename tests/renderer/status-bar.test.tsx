import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { StatusBar } from "../../src/renderer/src/layout/StatusBar";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { appInfoFixture, installBridge } from "./fixtures";

/**
 * The status bar's display-zoom cluster (2026-10-30 zoom plan). It is the
 * always-visible way to change zoom because the application menu is hidden on
 * Windows/Linux until Alt is pressed.
 */

beforeEach(() => {
  installBridge();
  useAppStore.setState({ prefs: { ...DEFAULT_PREFS }, info: null, project: null, hint: null });
});

describe("status bar project path", () => {
  it("shows the active project with the home folder abbreviated", () => {
    const info = appInfoFixture();
    const path = `${info.homeDir}\\Projects\\pi-desktop`;
    useAppStore.setState({ info, project: { path, name: "pi-desktop" } });

    render(<StatusBar />);
    const chip = screen.getByTestId("status-project");
    expect(chip).toHaveTextContent("~\\Projects\\pi-desktop");
    expect(chip).toHaveAttribute("title", path);
  });

  it("says no project is open when none is selected", () => {
    render(<StatusBar />);
    expect(screen.getByTestId("status-project")).toHaveTextContent("No project open");
  });
});

describe("status bar zoom", () => {
  it("shows the current percentage and steps through the levels", async () => {
    const user = userEvent.setup();
    render(<StatusBar />);

    const cluster = screen.getByTestId("status-zoom");
    expect(cluster).toHaveTextContent("100%");

    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(cluster).toHaveTextContent("110%");

    await user.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(cluster).toHaveTextContent("100%");
  });

  it("resets to 100% from the percentage button", async () => {
    const user = userEvent.setup();
    render(<StatusBar />);
    const reset = screen.getByRole("button", { name: "Reset zoom" });

    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(reset).toHaveTextContent("125%");

    await user.click(reset);
    expect(reset).toHaveTextContent("100%");
  });
});
