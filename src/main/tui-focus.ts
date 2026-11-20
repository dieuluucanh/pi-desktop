/**
 * Which extension TUI surface owns the keyboard in each window (2026-11-18
 * questionnaire paste plan).
 *
 * An extension frame (`ctx.ui.custom()`, e.g. the workflow questionnaire) is a
 * focusable `div`, not an editable element: Electron's `webContents.paste()` is a
 * no-op there and `setIgnoreMenuShortcuts` cannot be scoped to one chord. Main
 * therefore needs to know, at menu-click time, whether a TUI surface has focus so
 * it can send the paste request to the renderer instead of running the native
 * paste command. The renderer reports focus with the same fire-and-forget shape
 * it uses for a terminal (`IPC.tuiFocus`).
 *
 * Pure and window-keyed so the routing decision is testable without Electron.
 */

export interface TuiFocusRegistry {
  /** Records the focused TUI tab for a window; `null` clears it. */
  set(windowId: number, tabId: string | null): void;
  /** The focused TUI tab, or `null` when no extension surface owns the keyboard. */
  tabId(windowId: number): string | null;
  /** Drops a window's state (window closed, renderer reloaded). */
  clear(windowId: number): void;
}

export function createTuiFocusRegistry(): TuiFocusRegistry {
  const focused = new Map<number, string>();

  return {
    set(windowId, tabId) {
      if (tabId === null) {
        focused.delete(windowId);
        return;
      }
      focused.set(windowId, tabId);
    },
    tabId(windowId) {
      return focused.get(windowId) ?? null;
    },
    clear(windowId) {
      focused.delete(windowId);
    },
  };
}
