import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ExtensionsView } from "../../src/renderer/src/views/ExtensionsView";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { installBridge } from "./fixtures";
import { DEFAULT_PREFS } from "../../src/shared/prefs";

/**
 * Plan step 1 keeps the shipped Office wizard reachable from day one: it lives
 * under Extensions → Integrations while the navigation is rebuilt, so it must
 * mount there (the wizard itself is covered by the Office suites).
 */

beforeEach(() => {
  installBridge();
  useAppStore.setState({ prefs: { ...DEFAULT_PREFS }, info: null });
});

describe("extensions view", () => {
  it("mounts the Pi for Office wizard under Integrations", async () => {
    const { container } = render(<ExtensionsView />);
    expect(screen.getByRole("heading", { name: "Integrations" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Pi for Office" })).toBeInTheDocument();
    expect(container.querySelector(".panel")).not.toBeNull();
    expect(container.querySelector(".steps")).not.toBeNull();
  });

  it("names the shared profile locations for packages and settings", () => {
    useAppStore.setState({ info: expectAppInfo() });
    render(<ExtensionsView />);
    expect(screen.getByText(/settings\.json$/)).toBeInTheDocument();
  });
});

function expectAppInfo() {
  return {
    name: "Pi Desktop",
    version: "0.0.1",
    electron: "44.4.3",
    chrome: "152.0.0",
    node: "24.21.0",
    platform: "win32",
    arch: "x64",
    isDev: true,
    safeMode: false,
    userDataDir: "C:\\state",
    logsDir: "C:\\state\\logs",
    blobCacheDir: "C:\\state\\blobs",
    profileDir: "C:\\Users\\test\\.pi\\agent",
    settingsFile: "C:\\Users\\test\\.pi\\agent\\settings.json",
    authFile: "C:\\Users\\test\\.pi\\agent\\auth.json",
    modelsFile: "C:\\Users\\test\\.pi\\agent\\models.json",
    appStateFile: "C:\\state\\app-state.json",
    runtimeSource: "bundled",
    runtimeNodeVersion: "24.21.0",
    runtimeProblems: [],
  };
}
