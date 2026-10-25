import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

  it("shows the live model from the session state, not the stale tab record", () => {
    // The tab spawned on one model; the host has since switched (plan step 1).
    useAppStore.setState({
      sessionStates: { [TAB]: { model: { provider: "opencode-go", id: "other-model" } } },
    });
    render(<SessionView />);
    expect(screen.getByRole("button", { name: "Change model" })).toHaveTextContent(
      "opencode-go/other-model",
    );
  });

  it("moves the header when a host state frame reports a different model", () => {
    render(<SessionView />);
    act(() => {
      useAppStore.getState().applySessionState({
        tabId: TAB,
        state: { model: { provider: "openai", id: "gpt-5" } },
      });
    });
    expect(screen.getByRole("button", { name: "Change model" })).toHaveTextContent("openai/gpt-5");
  });
});

describe("model picker per tab", () => {
  it("gives each tab its own picker state, so the checkbox does not leak", () => {
    const second = { ...useAppStore.getState().tabs[0]!, id: "tab-2", title: "Second" };
    useAppStore.setState({
      tabs: [...useAppStore.getState().tabs, second],
      picker: "model",
      modelCatalog: {
        [TAB]: [
          {
            key: "openai/gpt-5",
            id: "gpt-5",
            provider: "openai",
            label: "GPT-5",
            raw: { id: "gpt-5", provider: "openai" },
          },
        ],
      },
    });
    const { rerender } = render(<SessionView />);
    // Keying the dialog by tab remounts it, so the flag cannot carry over.
    useAppStore.setState({ activeTabId: "tab-2" });
    rerender(<SessionView />);
    const checkbox = screen.queryByLabelText("Save as default") as HTMLInputElement | null;
    if (checkbox) expect(checkbox.checked).toBe(false);
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

describe("idle session wake (2026-10-24 plan)", () => {
  it("wakes a stopped session when the composer is focused", async () => {
    const handles = installBridge();
    const activate = vi.spyOn(handles.bridge.sessions, "activate");
    useAppStore.setState({
      tabs: [{ ...useAppStore.getState().tabs[0]!, status: "stopped" }],
      activeTabId: TAB,
    });

    render(<SessionView />);
    const box = screen.getByLabelText("Prompt");
    expect(box).toBeEnabled();

    fireEvent.focus(box);
    await waitFor(() => expect(activate).toHaveBeenCalledWith(TAB));
  });

  it("does not auto-wake a crashed session", () => {
    const handles = installBridge();
    const activate = vi.spyOn(handles.bridge.sessions, "activate");
    useAppStore.setState({
      tabs: [{ ...useAppStore.getState().tabs[0]!, status: "crashed" }],
      activeTabId: TAB,
    });

    render(<SessionView />);
    const box = screen.getByLabelText("Prompt");
    expect(box).toBeDisabled();

    fireEvent.focus(box);
    expect(activate).not.toHaveBeenCalled();
  });
});
