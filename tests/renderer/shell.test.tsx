import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "../../src/renderer/src/App";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { installBridge } from "./fixtures";
import { DEFAULT_PREFS } from "../../src/shared/prefs";

/**
 * The shell must be a real app shell: navigation, empty states, and *no*
 * placeholder copy. The regression this pins is the one the user hit — a
 * "New session" surface that showed build scaffolding instead of the product.
 */

const PLACEHOLDER_STRINGS = ["Scaffold is running", "Next up", "Step 4 —"];

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    view: "welcome",
    project: null,
    prefs: { ...DEFAULT_PREFS },
    paletteOpen: false,
    info: null,
    hint: null,
  });
});

describe("app shell", () => {
  it("renders the sidebar navigation instead of placeholder tabs", async () => {
    render(<App />);
    // Two surfaces own this action: the sidebar's primary button and the title
    // bar. Both must exist — the point is that the action is present at all.
    expect((await screen.findAllByRole("button", { name: /new session/i })).length).toBeGreaterThan(
      0,
    );
    for (const label of ["Settings", "Extensions", "Connections", "Diagnostics"]) {
      expect(
        screen.getAllByRole("button", { name: new RegExp(label, "i") }).length,
      ).toBeGreaterThan(0);
    }
    expect(screen.queryByText("Office", { selector: ".tabs__badge" })).toBeNull();
  });

  it("shows the welcome state with no project open", async () => {
    render(<App />);
    expect(await screen.findByText(/the desktop ui for the pi coding agent/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open project folder/i })).toBeInTheDocument();
  });

  it("never shows the old scaffold placeholder copy", async () => {
    const { container } = render(<App />);
    await screen.findByText(/the desktop ui for the pi coding agent/i);
    for (const text of PLACEHOLDER_STRINGS) {
      expect(container.textContent).not.toContain(text);
    }
  });

  it("reports the shared Pi profile in the status bar", async () => {
    render(<App />);
    expect(await screen.findByText(/profile: C:\\Users\\test\\\.pi\\agent/)).toBeInTheDocument();
  });
});
