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

  it("leaves Pi's editor actions alone inside CodeMirror", () => {
    const openExternal = vi.fn(async () => undefined);
    useAppStore.setState({ openExternalEditor: openExternal });
    render(<ShortcutDispatcher />);

    const root = document.createElement("div");
    root.className = "cm-editor";
    const content = document.createElement("div");
    content.contentEditable = "true";
    root.appendChild(content);
    document.body.appendChild(root);

    fireEvent.keyDown(content, { key: "o", ctrlKey: true });
    expect(useAppStore.getState().toolsExpanded[TAB]).toBeUndefined();

    fireEvent.keyDown(content, { key: "g", ctrlKey: true });
    expect(openExternal).not.toHaveBeenCalled();

    root.remove();
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

describe("ShortcutDispatcher app.interrupt (plan step 24)", () => {
  it("routes a default Escape to interruptRun, not stopRun", () => {
    const interrupt = vi.fn(async () => {});
    useAppStore.setState({ interruptRun: interrupt });
    render(<ShortcutDispatcher />);

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(interrupt).toHaveBeenCalledWith(TAB, {
      key: "Escape",
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
    });
  });

  it("honours a remapped app.interrupt chord", () => {
    const interrupt = vi.fn(async () => {});
    useAppStore.setState({
      interruptRun: interrupt,
      keybindings: keybindings({ "app.interrupt": ["ctrl+shift+escape"] }),
    });
    render(<ShortcutDispatcher />);

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(interrupt).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: "Escape", ctrlKey: true, shiftKey: true });
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it("leaves Escape to the composer's editable target", () => {
    const interrupt = vi.fn(async () => {});
    useAppStore.setState({ interruptRun: interrupt });
    render(<ShortcutDispatcher />);

    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(interrupt).not.toHaveBeenCalled();
    textarea.remove();
  });

  it("leaves Escape to a dialog and to a mounted TuiSurface", () => {
    const interrupt = vi.fn(async () => {});
    useAppStore.setState({ interruptRun: interrupt });
    render(<ShortcutDispatcher />);

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    fireEvent.keyDown(dialog, { key: "Escape" });

    const surface = document.createElement("div");
    surface.setAttribute("data-tui-surface", "dock");
    document.body.appendChild(surface);
    fireEvent.keyDown(surface, { key: "Escape" });

    expect(interrupt).not.toHaveBeenCalled();
    dialog.remove();
    surface.remove();
  });

  it("does not fire while the palette or help is open", () => {
    const interrupt = vi.fn(async () => {});
    useAppStore.setState({ interruptRun: interrupt, paletteOpen: true });
    render(<ShortcutDispatcher />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(interrupt).not.toHaveBeenCalled();

    useAppStore.setState({ paletteOpen: false, shortcutsHelpOpen: true });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("respects defaultPrevented", () => {
    const interrupt = vi.fn(async () => {});
    useAppStore.setState({ interruptRun: interrupt });
    render(<ShortcutDispatcher />);

    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();
    window.dispatchEvent(event);

    expect(interrupt).not.toHaveBeenCalled();
  });
});
