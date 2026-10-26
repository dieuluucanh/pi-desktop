import { useEffect } from "react";
import { resolveKeybindings } from "../../../shared/keybindings";
import { useAppStore } from "../state/app-store";
import { isEditableTarget, matchShortcut, matchesBinding } from "./dom-keys";

/**
 * Dispatches extension-registered shortcuts (plan step 15) and the app's own
 * `app.tools.expand` (plan step 18).
 *
 * Extension shortcuts run in the session host with the runner's own extension
 * context, so a shortcut fires exactly as it would from terminal Pi. The app's
 * expand toggle is an editor action in Pi, so it fires even while the composer
 * owns the keyboard (Ctrl+O is not a text input); other shortcuts are left alone
 * inside an editable element so typing can never trigger an action. Terminal Pi's
 * shortcuts are TUI-global; on the desktop the help dialog (`Ctrl+/`) lists
 * everything.
 */

/** The default `app.tools.expand` keys, used until `keybindings.json` is read. */
const DEFAULT_EXPAND_KEYS = resolveKeybindings({})["app.tools.expand"] ?? [];

/** The default `app.message.copy` keys (plan step 12). */
const DEFAULT_COPY_KEYS = resolveKeybindings({})["app.message.copy"] ?? ["ctrl+x"];

/** The default `app.editor.external` keys (plan step 21). */
const DEFAULT_EXTERNAL_EDITOR_KEYS = resolveKeybindings({})["app.editor.external"] ?? ["ctrl+g"];

export function ShortcutDispatcher() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const state = useAppStore.getState();
      if (state.shortcutsHelpOpen || state.paletteOpen) return;

      // `Ctrl+G` (Pi's `app.editor.external`) opens the expanded editor even
      // while the composer owns the keyboard — that is where the draft is.
      if (state.activeTabId) {
        const editorKeys =
          state.keybindings?.effective["app.editor.external"] ?? DEFAULT_EXTERNAL_EDITOR_KEYS;
        if (editorKeys.length > 0 && matchesBinding(event, editorKeys)) {
          event.preventDefault();
          void state.openExternalEditor(state.activeTabId);
          return;
        }
      }

      // The app's own binding resolves through the same effective table as an
      // extension shortcut, so a remap in Settings is honoured.
      if (state.activeTabId) {
        const keys = state.keybindings?.effective["app.tools.expand"] ?? DEFAULT_EXPAND_KEYS;
        if (keys.length > 0 && matchesBinding(event, keys)) {
          event.preventDefault();
          state.toggleToolsExpanded(state.activeTabId);
          return;
        }
      }

      if (isEditableTarget(event.target)) return;
      // `Ctrl+X` copies the last assistant answer outside an editor; inside one
      // it stays the browser's native cut (plan step 12, D14).
      if (state.activeTabId) {
        const copyKeys = state.keybindings?.effective["app.message.copy"] ?? DEFAULT_COPY_KEYS;
        if (copyKeys.length > 0 && matchesBinding(event, copyKeys)) {
          event.preventDefault();
          void state.copyLastAssistant(state.activeTabId);
          return;
        }
      }
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
