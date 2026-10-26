import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ShortcutDispatcher } from "../../src/renderer/src/shortcuts/ShortcutDispatcher";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { KeybindingsSnapshot } from "../../src/shared/keybindings";
import { installBridge } from "./fixtures";

/**
 * The app's own key bindings (plan step 18).
 *
 * `app.tools.expand` is an editor action in Pi, so it must fire even while the
 * composer owns the keyboard, and it must follow `keybindings.json` exactly as
 * an extension shortcut does.
 */

const TAB = "tab-1";

function keybindings(effective: Record<string, string[]>): KeybindingsSnapshot {
  return {
    path: "C:/state/keybindings.json",
    user: {},
    exists: true,
    effective,
    definitions: [],
    unknownIds: [],
    issues: [],
    conflicts: [],
  };
}

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    activeTabId: TAB,
    toolsExpanded: {},
    keybindings: null,
    shortcutsHelpOpen: false,
    paletteOpen: false,
    shortcuts: { shortcuts: [] } as never,
  });
});

describe("ShortcutDispatcher app.tools.expand", () => {
  it("toggles expand-all on the default Ctrl+O binding", () => {
    render(<ShortcutDispatcher />);
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    expect(useAppStore.getState().toolsExpanded[TAB]).toBe(true);
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    expect(useAppStore.getState().toolsExpanded[TAB]).toBe(false);
  });

  it("fires even when focus is inside the composer", () => {
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    render(<ShortcutDispatcher />);
    fireEvent.keyDown(textarea, { key: "o", ctrlKey: true });
    expect(useAppStore.getState().toolsExpanded[TAB]).toBe(true);
    textarea.remove();
  });

  it("honours a remap from keybindings.json", () => {
    useAppStore.setState({ keybindings: keybindings({ "app.tools.expand": ["ctrl+shift+e"] }) });
    render(<ShortcutDispatcher />);

    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    expect(useAppStore.getState().toolsExpanded[TAB]).toBeUndefined();

    fireEvent.keyDown(window, { key: "E", ctrlKey: true, shiftKey: true });
    expect(useAppStore.getState().toolsExpanded[TAB]).toBe(true);
  });

  it("does nothing without an active session tab", () => {
    useAppStore.setState({ activeTabId: null });
    render(<ShortcutDispatcher />);
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    expect(useAppStore.getState().toolsExpanded[TAB]).toBeUndefined();
  });
});

describe("ShortcutDispatcher app.message.copy (plan step 12)", () => {
  it("copies the last answer on Ctrl+X outside an editor", () => {
    const copy = vi.fn(async () => true);
    useAppStore.setState({ copyLastAssistant: copy });
    render(<ShortcutDispatcher />);
    fireEvent.keyDown(document.body, { key: "x", ctrlKey: true });
    expect(copy).toHaveBeenCalledWith(TAB);
  });

  it("leaves Ctrl+X to the browser inside an editable target", () => {
    render(<ShortcutDispatcher />);
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    const event = new KeyboardEvent("keydown", {
      key: "x",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(event);
    // The dispatcher must not preventDefault the native cut.
    expect(event.defaultPrevented).toBe(false);
    textarea.remove();
  });

  it("follows a keybindings.json remap of app.message.copy", () => {
    const copy = vi.fn(async () => true);
    useAppStore.setState({
      copyLastAssistant: copy,
      keybindings: keybindings({ "app.message.copy": ["ctrl+shift+c"] }),
    });
    render(<ShortcutDispatcher />);
    const remapped = new KeyboardEvent("keydown", {
      key: "C",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(remapped);
    expect(remapped.defaultPrevented).toBe(true);
    expect(copy).toHaveBeenCalledWith(TAB);
  });
});
