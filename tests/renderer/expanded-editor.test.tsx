import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExpandedEditorDialog } from "../../src/renderer/src/sessions/ExpandedEditorDialog";
import { ShortcutDispatcher } from "../../src/renderer/src/shortcuts/ShortcutDispatcher";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * Ctrl+G and the expanded editor (session-parity plan step 21).
 *
 * The dialog is the guaranteed path (terminal editors have no TTY here): it
 * opens with the expanded draft, shows a live count, saves back into the
 * composer and collapses a pasted document again on the way.
 */

const TAB = "tab-1";

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: { [TAB]: "hello" } },
    tabs: [],
    activeTabId: TAB,
    expandedEditorOpen: false,
    expandedEditorError: null,
    expandedEditorBusy: false,
    pasteBodies: {},
    pasteCounter: 1,
    keybindings: null,
    shortcutsHelpOpen: false,
    paletteOpen: false,
    shortcuts: { shortcuts: [] } as never,
  });
});

describe("ExpandedEditorDialog", () => {
  it("seeds the draft, counts it and saves back", async () => {
    useAppStore.setState({ expandedEditorOpen: true });
    render(<ExpandedEditorDialog />);

    const box = screen.getByLabelText("Expanded prompt");
    expect(box).toHaveValue("hello");
    expect(screen.getByTestId("expanded-editor-count")).toHaveTextContent("5 chars · 1 lines");

    await userEvent.clear(box);
    await userEvent.type(box, "a{enter}b");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(useAppStore.getState().prefs.drafts[TAB]).toBe("a\nb");
    expect(useAppStore.getState().expandedEditorOpen).toBe(false);
  });

  it("cancels without touching the draft", async () => {
    useAppStore.setState({ expandedEditorOpen: true });
    render(<ExpandedEditorDialog />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useAppStore.getState().prefs.drafts[TAB]).toBe("hello");
    expect(useAppStore.getState().expandedEditorOpen).toBe(false);
  });

  it("writes an OS-editor result back and collapses a long result", async () => {
    const long = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
    const editor = vi.fn(async () => ({ ok: true, text: long }));
    (window.pi as unknown as { share: { editor: unknown } }).share.editor = editor;

    await useAppStore.getState().openExternalEditor(TAB);

    expect(editor).toHaveBeenCalledWith("hello", null);
    expect(useAppStore.getState().prefs.drafts[TAB]).toBe("[paste #1 +40 lines]");
  });

  it("opens the in-app editor when no OS editor is configured", async () => {
    (window.pi as unknown as { share: { editor: unknown } }).share.editor = async () => ({
      ok: false,
      error: "No external editor is configured.",
    });

    await useAppStore.getState().openExternalEditor(TAB);

    expect(useAppStore.getState().expandedEditorOpen).toBe(true);
    expect(useAppStore.getState().expandedEditorError).toContain("No external editor");
  });
});

describe("ShortcutDispatcher app.editor.external", () => {
  it("opens the expanded editor on Ctrl+G from inside the composer", async () => {
    const open = vi.fn(async () => undefined);
    useAppStore.setState({ openExternalEditor: open });
    render(
      <div>
        <ShortcutDispatcher />
        <textarea aria-label="composer" />
      </div>,
    );
    const box = screen.getByLabelText("composer");
    box.focus();
    const event = new KeyboardEvent("keydown", {
      key: "g",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    box.dispatchEvent(event);
    await waitFor(() => expect(open).toHaveBeenCalledWith(TAB));
    expect(event.defaultPrevented).toBe(true);
  });
});
