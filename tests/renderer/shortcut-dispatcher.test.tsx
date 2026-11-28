import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NotificationCenter } from "../../src/renderer/src/notifications/NotificationCenter";
import { ShortcutDispatcher } from "../../src/renderer/src/shortcuts/ShortcutDispatcher";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { KeybindingsSnapshot } from "../../src/shared/keybindings";
import type { ExtensionDialogRequest } from "../../src/shared/extension-ui";
import { installBridge } from "./fixtures";

/**
 * The app's own key bindings (plan step 18).
 *
 * `app.tools.expand` is an editor action in Pi, so it must fire even while the
 * composer owns the keyboard, and it must follow `keybindings.json` exactly as
 * an extension shortcut does.
 */

const TAB = "tab-1";

function dialogFixture(overrides: Partial<ExtensionDialogRequest> = {}): ExtensionDialogRequest {
  return {
    id: "ui-1",
    method: "select",
    title: "Read policy: allow this read?",
    options: ["Allow once (this turn)", "Deny"],
    message: "",
    placeholder: null,
    prefill: null,
    timeout: null,
    tabId: TAB,
    at: 1,
    ...overrides,
  };
}

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
    view: "session",
    toolsExpanded: {},
    keybindings: null,
    extensionDialogs: [],
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

  it("leaves Escape to an open dialog even when focus is on the page", () => {
    // The reported case: the permission prompt is mounted but focus stayed on
    // `body`. Escape must cancel the prompt, not stop the run.
    const interrupt = vi.fn(async () => {});
    useAppStore.setState({ interruptRun: interrupt, extensionDialogs: [dialogFixture()] });
    render(<ShortcutDispatcher />);

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(interrupt).not.toHaveBeenCalled();
  });

  it("keeps Ctrl+O available while a dialog owns the keyboard", () => {
    // Terminal Pi's selector still handles app.tools.expand.
    useAppStore.setState({ extensionDialogs: [dialogFixture()] });
    render(<ShortcutDispatcher />);

    fireEvent.keyDown(document.body, { key: "o", ctrlKey: true });

    expect(useAppStore.getState().toolsExpanded[TAB]).toBe(true);
  });

  it("keeps Ctrl+G out of a dialog", () => {
    const openEditor = vi.fn(async () => {});
    useAppStore.setState({
      openExternalEditor: openEditor,
      extensionDialogs: [dialogFixture()],
    });
    render(<ShortcutDispatcher />);

    fireEvent.keyDown(document.body, { key: "g", ctrlKey: true });
    expect(openEditor).not.toHaveBeenCalled();
  });

  it("does not block the active tab for a dialog in another tab", () => {
    const interrupt = vi.fn(async () => {});
    useAppStore.setState({
      interruptRun: interrupt,
      extensionDialogs: [dialogFixture({ tabId: "tab-2" })],
    });
    render(<ShortcutDispatcher />);

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it("does not block shortcuts outside the session view", () => {
    const interrupt = vi.fn(async () => {});
    useAppStore.setState({
      interruptRun: interrupt,
      view: "settings",
      extensionDialogs: [dialogFixture()],
    });
    render(<ShortcutDispatcher />);

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(interrupt).toHaveBeenCalledTimes(1);
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

  it("closes the notification panel on Escape without interrupting the run", async () => {
    const interrupt = vi.fn(async () => {});
    useAppStore.setState({ interruptRun: interrupt });
    render(
      <>
        <ShortcutDispatcher />
        <NotificationCenter />
      </>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(await screen.findByTestId("notification-center")).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });

    await waitFor(() => expect(screen.queryByTestId("notification-center")).toBeNull());
    expect(interrupt).not.toHaveBeenCalled();
  });
});

describe("ShortcutDispatcher plain Tab on an interactive control", () => {
  const tabShortcut = { key: "tab", extensionPath: "C:/x/ext", source: "ext" };

  function button(): HTMLButtonElement {
    const element = document.createElement("button");
    element.textContent = "Mode";
    document.body.appendChild(element);
    return element;
  }

  it("does not swallow focus navigation when a button has focus", () => {
    const invoke = vi.fn(async () => true);
    useAppStore.setState({
      invokeShortcut: invoke,
      shortcuts: { shortcuts: [tabShortcut] } as never,
    });
    render(<ShortcutDispatcher />);
    const element = button();
    element.focus();
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(event);
    // Native Tab must move focus; the extension's `tab` action must not run.
    expect(event.defaultPrevented).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    element.remove();
  });

  it("still dispatches Tab from the page/composer (where the cycle applies)", () => {
    const invoke = vi.fn(async () => true);
    useAppStore.setState({
      invokeShortcut: invoke,
      shortcuts: { shortcuts: [tabShortcut] } as never,
    });
    render(<ShortcutDispatcher />);
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(invoke).toHaveBeenCalledWith("tab");
  });
});
