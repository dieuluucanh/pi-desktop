import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

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
