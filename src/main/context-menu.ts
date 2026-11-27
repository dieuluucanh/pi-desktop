/**
 * The renderer's right-click menu (2026-10-30 copy plan).
 *
 * Electron has no default context menu, so before this module a right-click did
 * nothing. That mattered most for the extension TUI surface, where Ctrl+C is a
 * terminal chord: a selection needed a second, discoverable way to be copied.
 *
 * The template is pure (type-only Electron import) so the labels, order and
 * enabled flags are unit-tested in the node project; `src/main/index.ts` owns the
 * `Menu.popup` call and the `webContents` edit actions.
 */

import type { MenuItemConstructorOptions } from "electron";

/** The subset of Electron's `ContextMenuParams` this template needs. */
export interface ContextMenuState {
  selectionText: string;
  isEditable: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canCut: boolean;
  canCopy: boolean;
  canPaste: boolean;
  canSelectAll: boolean;
  /**
   * The extension TUI tab that owns the keyboard, when one does. Its frame is a
   * non-editable `div`, so `webContents.paste()` cannot reach it: the menu then
   * offers Paste and the click sends a paste request to the renderer instead.
   */
  tuiTabId?: string | null;
}

export interface ContextMenuActions {
  undo: () => void;
  redo: () => void;
  cut: () => void;
  copy: () => void;
  paste: () => void;
  selectAll: () => void;
}

/**
 * Builds the menu for one right-click. A non-editable target with no selection
 * and no extension frame returns an empty template, so the caller can skip
 * `popup` rather than showing an empty menu.
 */
export function contextMenuTemplate(
  state: ContextMenuState,
  actions: ContextMenuActions,
): MenuItemConstructorOptions[] {
  const hasSelection = state.selectionText.length > 0;
  const tui = Boolean(state.tuiTabId);
  if (!state.isEditable && !hasSelection && !tui) return [];

  const items: MenuItemConstructorOptions[] = [];
  if (state.isEditable) {
    items.push(
      { id: "undo", label: "Undo", enabled: state.canUndo, click: actions.undo },
      { id: "redo", label: "Redo", enabled: state.canRedo, click: actions.redo },
      { type: "separator" },
      { id: "cut", label: "Cut", enabled: state.canCut, click: actions.cut },
    );
  }
  items.push({
    id: "copy",
    label: "Copy",
    // A TUI selection reports `selectionText` even though the frame is not an
    // editable field, so either signal is enough to enable Copy.
    enabled: state.canCopy || hasSelection,
    click: actions.copy,
  });
  if (state.isEditable) {
    items.push(
      { id: "paste", label: "Paste", enabled: state.canPaste, click: actions.paste },
      { type: "separator" },
      {
        id: "select-all",
        label: "Select All",
        enabled: state.canSelectAll,
        click: actions.selectAll,
      },
    );
  } else if (tui) {
    // The frame is not editable, so the native paste command is a no-op; the
    // click sends a paste request to the renderer that owns the frame.
    items.push({ id: "paste", label: "Paste", enabled: true, click: actions.paste });
  }
  return items;
}
