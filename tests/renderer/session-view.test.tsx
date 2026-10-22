import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "../../src/renderer/src/state/app-store";
import { SessionView } from "../../src/renderer/src/views/SessionView";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * The session view's chrome (plan step 6).
 *
 * The header used to pack eight differently-styled controls, including a
 * native `<select>` that matched nothing beside it. The cluster is now one row
 * of equally-weighted buttons, and the view mode is a menu in the app's own
 * vocabulary.
 */

const TAB = "tab-1";

function resetStore(): void {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {}, viewMode: "normal" },
    tabs: [
      {
        id: TAB,
        kind: "session",
        cwd: "C:/work/app",
        title: "Fix the bug",
        sessionFile: null,
        status: "idle",
        createdAt: 1,
        lastActiveAt: 1,
        model: "anthropic/claude",
      },
    ],
    activeTabId: TAB,
    transcripts: {},
    sessionStates: {},
    extensionUi: {},
    tuiSurfaces: {},
  });
}

beforeEach(() => {
  resetStore();
});

describe("session header", () => {
  it("shows the view mode as one of the header's buttons, not a native select", () => {
    render(<SessionView />);
    // A native select was the only unstyled control in the header.
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("button", { name: "View mode" })).toHaveTextContent("Normal");
  });

  it("switches the view mode from the menu", async () => {
    const user = userEvent.setup();
    render(<SessionView />);

    await user.click(screen.getByRole("button", { name: "View mode" }));
    await user.click(await screen.findByRole("menuitem", { name: /Verbose/ }));
    expect(useAppStore.getState().prefs.viewMode).toBe("verbose");
  });

  it("keeps the facts and the actions in one cluster, split by a rule", () => {
    render(<SessionView />);
    // The vertical rule says which way it runs, so assistive tech reads it as
    // a separator between the two groups (plan step 6).
    const rule = document.querySelector('[aria-orientation="vertical"]');
    expect(rule).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change model" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change thinking level" })).toBeInTheDocument();
  });
});

describe("composer rows", () => {
  it("puts the shortcut hints and the caret readout on one row", () => {
    render(<SessionView />);
    const row = screen.getByTestId("composer-caret").parentElement;
    expect(row?.textContent).toContain("commands");
    expect(row?.textContent).toContain("Ln 1 · Col 1");
  });
});
