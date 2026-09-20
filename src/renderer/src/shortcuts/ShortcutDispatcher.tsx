import { useEffect } from "react";
import { useAppStore } from "../state/app-store";
import { isEditableTarget, matchShortcut } from "./dom-keys";

/**
 * Dispatches extension-registered shortcuts from the keyboard (plan step 15).
 *
 * The handler runs in the session host with the runner's own extension
 * context, so a shortcut fires exactly as it would from terminal Pi — with one
 * deliberate scoping rule: while focus is inside an editable element the event
 * is left alone, so typing can never trigger an extension action. Terminal Pi's
 * shortcuts are TUI-global; on the desktop the composer owns the keyboard while
 * editing, and the help dialog (`Ctrl+/`) lists everything.
 */
export function ShortcutDispatcher() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (isEditableTarget(event.target)) return;
      const state = useAppStore.getState();
      if (state.shortcutsHelpOpen || state.paletteOpen) return;
      const shortcuts = state.shortcuts.shortcuts;
      if (shortcuts.length === 0) return;
      const matched = matchShortcut(event, shortcuts);
      if (!matched) return;
      event.preventDefault();
      void state.invokeShortcut(matched);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return null;
}
