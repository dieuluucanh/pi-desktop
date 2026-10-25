import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/src/App";
import {
  HOST_STALE_MESSAGE,
  MAIN_OUTDATED_MESSAGE,
  useAppStore,
} from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * The reliability banners (plan step 22): safe mode must be visible whenever
 * third-party code is disabled, and `PI_OFFLINE` must be visible whenever Pi's
 * startup network calls are off — neither may be a hidden state.
 */

beforeEach(() => {
  useAppStore.setState({
    view: "welcome",
    project: null,
    prefs: { ...DEFAULT_PREFS },
    paletteOpen: false,
    info: null,
    hint: null,
    offlineNotice: null,
    staleHosts: {},
    activeTabId: null,
  });
});

describe("reliability banners", () => {
  it("shows the safe-mode banner when --safe-mode is on", async () => {
    installBridge({ appInfo: { safeMode: true } });
    render(<App />);
    expect(await screen.findByTestId("safe-mode-banner")).toBeInTheDocument();
    expect(screen.queryByTestId("offline-banner")).toBeNull();
  });

  it("shows the PI_OFFLINE banner when the env disables network calls", async () => {
    installBridge({ appInfo: { piOffline: true } });
    render(<App />);
    expect(await screen.findByTestId("offline-banner")).toBeInTheDocument();
    expect(screen.getByText(/PI_OFFLINE is set/i)).toBeInTheDocument();
  });

  it("shows nothing extra in a normal run", async () => {
    installBridge();
    render(<App />);
    await screen.findByText(/the desktop ui for the pi coding agent/i);
    expect(screen.queryByTestId("safe-mode-banner")).toBeNull();
    expect(screen.queryByTestId("offline-banner")).toBeNull();
    expect(screen.queryByTestId("stale-host-banner")).toBeNull();
  });

  it("shows the outdated-main banner and restarts the app", async () => {
    const handles = installBridge({ appInfo: { hostMethods: [] } });
    const relaunch = vi.spyOn(handles.bridge, "relaunch");

    render(<App />);

    expect(await screen.findByTestId("main-outdated-banner")).toHaveTextContent(
      MAIN_OUTDATED_MESSAGE,
    );
    fireEvent.click(screen.getByText(/restart app/i));
    await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
  });

  it("shows the stale-host banner and restarts the session", async () => {
    const handles = installBridge();
    const restart = vi.spyOn(handles.bridge.sessions, "restart");
    useAppStore.setState({
      activeTabId: "tab-1",
      staleHosts: { "tab-1": HOST_STALE_MESSAGE },
    });

    render(<App />);

    expect(screen.getByTestId("stale-host-banner")).toHaveTextContent(HOST_STALE_MESSAGE);
    fireEvent.click(screen.getByText(/restart session/i));
    await waitFor(() => expect(restart).toHaveBeenCalledWith("tab-1"));
  });
});
