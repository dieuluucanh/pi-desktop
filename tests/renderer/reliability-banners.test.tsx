import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "../../src/renderer/src/App";
import { useAppStore } from "../../src/renderer/src/state/app-store";
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
  });
});
