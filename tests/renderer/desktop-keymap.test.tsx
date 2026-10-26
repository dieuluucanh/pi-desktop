import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { DesktopKeymapSection } from "../../src/renderer/src/keybindings/DesktopKeymapSection";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * The desktop keymap editor (session-parity plan step 24).
 *
 * Capture a chord, remove one, reset a row, and see a real conflict — without
 * ever writing a Pi action into `desktopKeybindings`.
 */

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, desktopKeybindings: {} },
    keybindings: null,
    shortcuts: { shortcuts: [] } as never,
  });
});

describe("DesktopKeymapSection", () => {
  it("shows the defaults and the menu accelerator for a menu action", () => {
    render(<DesktopKeymapSection />);
    const rows = screen.getAllByTestId("desktop-keymap-row");
    expect(rows.length).toBeGreaterThan(5);
    expect(screen.getByText("menu: CmdOrCtrl+N")).toBeInTheDocument();
    expect(screen.getByText("ctrl+shift+tab")).toBeInTheDocument();
  });

  it("captures a new chord and persists only the override", () => {
    render(<DesktopKeymapSection />);
    const change = screen.getAllByRole("button", { name: "Change" })[0]!;
    fireEvent.click(change);
    const capture = screen.getAllByLabelText(/Capture a shortcut for/)[0]!;
    fireEvent.keyDown(capture, { key: "J", ctrlKey: true, shiftKey: true });

    expect(useAppStore.getState().prefs.desktopKeybindings["session.new"]).toEqual([
      "ctrl+n",
      "ctrl+shift+j",
    ]);
  });

  it("ignores a meta chord (the menu grammar owns cmd)", () => {
    render(<DesktopKeymapSection />);
    fireEvent.click(screen.getAllByRole("button", { name: "Change" })[0]!);
    const capture = screen.getAllByLabelText(/Capture a shortcut for/)[0]!;
    fireEvent.keyDown(capture, { key: "n", metaKey: true });
    expect(useAppStore.getState().prefs.desktopKeybindings["session.new"]).toBeUndefined();
  });

  it("removes a chord and resets the row", () => {
    useAppStore.setState({
      prefs: {
        ...DEFAULT_PREFS,
        desktopKeybindings: { "session.new": ["ctrl+n", "alt+n"] },
      },
    });
    render(<DesktopKeymapSection />);

    // Clicking a chord chip removes it.
    fireEvent.click(screen.getByText("alt+n"));
    // Back to the default chord, so the override row disappears entirely.
    expect(useAppStore.getState().prefs.desktopKeybindings["session.new"]).toBeUndefined();

    fireEvent.click(screen.getAllByRole("button", { name: "Reset" })[0]!);
    expect(useAppStore.getState().prefs.desktopKeybindings["session.new"]).toBeUndefined();
  });

  it("flags a real conflict against a Pi binding", () => {
    useAppStore.setState({
      prefs: { ...DEFAULT_PREFS, desktopKeybindings: { "palette.open": ["ctrl+x"] } },
      keybindings: {
        path: "/k.json",
        user: {},
        exists: true,
        effective: { "app.message.copy": ["ctrl+x"] },
        definitions: [],
        unknownIds: [],
        issues: [],
        conflicts: [],
      },
    });
    render(<DesktopKeymapSection />);
    expect(screen.getByText(/ctrl\+x: app\.message\.copy/)).toBeInTheDocument();
    expect(screen.getAllByText("conflict").length).toBeGreaterThan(0);
  });
});
