import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/src/App";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { appInfoFixture, installBridge } from "./fixtures";
import { DEFAULT_PREFS } from "../../src/shared/prefs";

/**
 * The shell must be a real app shell: navigation, empty states, and *no*
 * placeholder copy. The regression this pins is the one the user hit — a
 * "New session" surface that showed build scaffolding instead of the product.
 */

const PLACEHOLDER_STRINGS = ["Scaffold is running", "Next up", "Step 4 —"];

beforeEach(() => {
  // The shell tests are about navigation and empty states, not first-run
  // privacy or onboarding; those have their own tests (plan steps 23 and 26).
  // A completed flag keeps the onboarding wizard from covering the shell.
  installBridge({ prefs: { privacyAcknowledged: true, onboardingCompletedAt: 1 } });
  useAppStore.setState({
    view: "welcome",
    project: null,
    prefs: { ...DEFAULT_PREFS, privacyAcknowledged: true, onboardingCompletedAt: 1 },
    paletteOpen: false,
    info: null,
    hint: null,
  });
});

describe("app shell", () => {
  it("renders the sidebar navigation instead of placeholder tabs", async () => {
    render(<App />);
    // The welcome view and the tab strip own this action; the old title-bar copy
    // was removed in minimal-session-ui step 1 (the sidebar CTA goes in step 2).
    expect((await screen.findAllByRole("button", { name: /new session/i })).length).toBeGreaterThan(
      0,
    );
    for (const label of [
      "Settings",
      "Extensions",
      "Connections",
      "Diagnostics",
      "About & updates",
    ]) {
      expect(
        screen.getAllByRole("button", { name: new RegExp(label, "i") }).length,
      ).toBeGreaterThan(0);
    }
    expect(screen.queryByText("Office", { selector: ".tabs__badge" })).toBeNull();
    // Pi for Office is an integration, not primary navigation (plan step 19):
    // the only way to it is Extensions → Integrations or the Integrations menu.
    expect(screen.queryByRole("button", { name: /pi for office/i })).toBeNull();
  });

  it("has no sidebar copies of New session or Open project", async () => {
    render(<App />);
    await screen.findByText(/the desktop ui for the pi coding agent/i);

    // The tab strip owns New session and the Projects header owns the project
    // actions (minimal-session-ui step 2).
    const sidebar = screen.getByLabelText("Navigation");
    expect(within(sidebar).queryByRole("button", { name: /new session/i })).toBeNull();
    expect(within(sidebar).queryByRole("button", { name: "Open project…" })).toBeNull();
  });

  it("shows the welcome state with no project open", async () => {
    render(<App />);
    expect(await screen.findByText(/the desktop ui for the pi coding agent/i)).toBeInTheDocument();
    // The welcome view and the Projects header both offer an open-folder action.
    expect(screen.getAllByRole("button", { name: /open project folder/i }).length).toBeGreaterThan(
      0,
    );
  });

  it("never shows the old scaffold placeholder copy", async () => {
    const { container } = render(<App />);
    await screen.findByText(/the desktop ui for the pi coding agent/i);
    for (const text of PLACEHOLDER_STRINGS) {
      expect(container.textContent).not.toContain(text);
    }
  });

  it("reconciles sessions when the window becomes active again", async () => {
    const { bridge } = installBridge({
      prefs: { privacyAcknowledged: true, onboardingCompletedAt: 1 },
    });
    const reconcile = vi.fn(async () => ({ tabs: [], activeTabId: null }));
    (bridge.sessions as unknown as { reconcile: unknown }).reconcile = reconcile;

    render(<App />);
    await screen.findByText(/the desktop ui for the pi coding agent/i);

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
  });

  it("reports the shared Pi profile in the status bar", async () => {
    // The bar is now slim and app-level: the chip shows a compact label and
    // keeps the exact path in `data-profile`/`title`, which is what proves the
    // resolved profile actually reached the renderer.
    render(<App />);
    const chip = await screen.findByTestId("status-profile");
    const { profileDir } = appInfoFixture();
    expect(chip).toHaveAttribute("data-profile", profileDir);
    expect(chip).toHaveAttribute("title", `The profile shared with terminal Pi: ${profileDir}`);
  });
});
