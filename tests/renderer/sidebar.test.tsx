import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { Sidebar } from "../../src/renderer/src/layout/Sidebar";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "../../src/shared/prefs";
import { initialUpdateState } from "../../src/shared/updates";
import { installBridge } from "./fixtures";

function reset(collapsed = false): void {
  installBridge();
  useAppStore.setState({
    view: "session",
    projects: [],
    projectsLoaded: true,
    project: null,
    tabs: [],
    activeTabId: null,
    update: null,
    prefs: { ...DEFAULT_PREFS, sidebarCollapsed: collapsed, sidebarWidth: 268 },
  });
}

function stubCapture(handle: HTMLElement): void {
  (handle as HTMLElement & { setPointerCapture?: unknown }).setPointerCapture = () => {};
  (handle as HTMLElement & { releasePointerCapture?: unknown }).releasePointerCapture = () => {};
}

beforeEach(() => reset());

describe("Sidebar update sign", () => {
  it("marks About & updates while a version is offered", () => {
    useAppStore.setState({
      update: { ...initialUpdateState(true), phase: "available", version: "0.4.0" },
    });
    render(<Sidebar />);

    expect(screen.getByRole("button", { name: /about & updates/i })).toBeInTheDocument();
    expect(screen.getByTestId("nav-update-badge")).toBeInTheDocument();
    expect(screen.getByTitle(/0.4.0 is available/)).toBeInTheDocument();
  });

  it("uses the ready sign for a downloaded build and no sign when settled", () => {
    useAppStore.setState({
      update: { ...initialUpdateState(true), phase: "downloaded", version: "0.4.0" },
    });
    const { rerender } = render(<Sidebar />);
    expect(screen.getByTitle(/0.4.0 is ready to install/)).toBeInTheDocument();

    useAppStore.setState({ update: { ...initialUpdateState(true), phase: "up-to-date" } });
    rerender(<Sidebar />);
    expect(screen.queryByTestId("nav-update-badge")).toBeNull();
  });
});

describe("Sidebar resize", () => {
  it("follows the pointer and writes once on release", () => {
    render(<Sidebar />);
    const aside = screen.getByTestId("sidebar");
    const handle = screen.getByTestId("sidebar-resize");
    stubCapture(handle);

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 160 });
    // Live preview, no store write.
    expect(aside).toHaveStyle({ width: "328px" });
    expect(useAppStore.getState().prefs.sidebarWidth).toBe(268);

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 160 });
    expect(useAppStore.getState().prefs.sidebarWidth).toBe(328);
  });

  it("narrows, clamps and supports the keyboard", async () => {
    render(<Sidebar />);
    const handle = screen.getByRole("separator", { name: "Resize sidebar" });
    handle.focus();

    await userEvent.keyboard("{ArrowRight}");
    expect(useAppStore.getState().prefs.sidebarWidth).toBe(288);
    await userEvent.keyboard("{ArrowLeft}");
    expect(useAppStore.getState().prefs.sidebarWidth).toBe(268);

    useAppStore.setState({ prefs: { ...DEFAULT_PREFS, sidebarWidth: MIN_SIDEBAR_WIDTH } });
    await userEvent.keyboard("{ArrowLeft}");
    expect(useAppStore.getState().prefs.sidebarWidth).toBe(MIN_SIDEBAR_WIDTH);

    useAppStore.setState({ prefs: { ...DEFAULT_PREFS, sidebarWidth: MAX_SIDEBAR_WIDTH } });
    await userEvent.keyboard("{ArrowRight}");
    expect(useAppStore.getState().prefs.sidebarWidth).toBe(MAX_SIDEBAR_WIDTH);
  });

  it("has no handle while collapsed", () => {
    reset(true);
    render(<Sidebar />);
    expect(screen.queryByTestId("sidebar")).toBeNull();
    expect(screen.queryByTestId("sidebar-resize")).toBeNull();
  });
});
