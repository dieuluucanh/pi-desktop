import { useEffect } from "react";
import { resolveKeybindings } from "../../../shared/keybindings";
import type { TerminalKeyInput } from "../../../shared/terminal-keys";
import { useAppStore } from "../state/app-store";
import { isEditableTarget, isEditorSurfaceTarget, matchShortcut, matchesBinding } from "./dom-keys";

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

/** The default `app.interrupt` keys (plan step 24). */
const DEFAULT_INTERRUPT_KEYS = resolveKeybindings({})["app.interrupt"] ?? ["escape"];

/**
 * True when a key inside this element belongs to something else: an extension
 * dialog owns its keys, and a mounted `TuiSurface` forwards them to the extension
 * component itself (which is where a review's pause handler lives). Escape in
 * either must not also trigger the app-wide interrupt.
 */
function insideBlockingSurface(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    (target.closest('[role="dialog"]') !== null || target.closest("[data-tui-surface]") !== null)
  );
}

/**
 * True when the focused element owns plain Tab navigation (2026-11-22 mode
 * cycle plan). An extension can register `tab`; dispatching it while a button or
 * link has focus would swallow the browser's focus move and trap the user on
 * that control. The composer textarea is unaffected (editable targets return
 * earlier and keep their own Tab handling).
 */
function ownsTabNavigation(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest("button, a[href], select, summary, [tabindex]") !== null;
}

/** The default `app.editor.external` keys (plan step 21). */
const DEFAULT_EXTERNAL_EDITOR_KEYS = resolveKeybindings({})["app.editor.external"] ?? ["ctrl+g"];

export function ShortcutDispatcher() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const state = useAppStore.getState();
      if (state.shortcutsHelpOpen || state.paletteOpen) return;
      // CodeMirror owns its own keys. Pi's editor/composer actions below are
      // meant for the transcript side and must not fire while a file is edited.
      const inCodeEditor = isEditorSurfaceTarget(event.target);
      // A dialog is the active interaction for its tab. Terminal Pi's selector
      // owns every key while shown, even when DOM focus stayed on the page, so
      // app shortcuts and the run interrupt must not fire underneath it.
      const dialogOwnsKeyboard =
        state.view === "session" &&
        state.activeTabId !== null &&
        state.extensionDialogs.some((dialog) => dialog.tabId === state.activeTabId);

      // `Ctrl+G` (Pi's `app.editor.external`) opens the expanded editor even
      // while the composer owns the keyboard — that is where the draft is.
      if (!dialogOwnsKeyboard && !inCodeEditor && state.activeTabId) {
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
      // Terminal Pi's selector explicitly supports `app.tools.expand`, so
      // Ctrl+O stays available while a dialog owns the keyboard.
      if (!inCodeEditor && state.activeTabId) {
        const keys = state.keybindings?.effective["app.tools.expand"] ?? DEFAULT_EXPAND_KEYS;
        if (keys.length > 0 && matchesBinding(event, keys)) {
          event.preventDefault();
          state.toggleToolsExpanded(state.activeTabId);
          return;
        }
      }

      if (dialogOwnsKeyboard) return;

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
      // Extension shortcuts come before the app-wide interrupt, exactly as Pi's
      // editor checks `onExtensionShortcut` before its own key handling. A plain
      // Tab on an interactive control stays native focus navigation: the
      // composer's own textarea handler already covers the mode-cycle case.
      if (event.key === "Tab" && ownsTabNavigation(event.target)) return;
      const shortcuts = state.shortcuts.shortcuts;
      if (shortcuts.length > 0) {
        const matched = matchShortcut(event, shortcuts);
        if (matched) {
          event.preventDefault();
          void state.invokeShortcut(matched);
          return;
        }
      }

      // `app.interrupt` (plan step 24): the extension's `onTerminalInput` gets
      // the key before the run is stopped, so an in-flight review pauses exactly
      // as it does in terminal Pi. Editable/CodeMirror targets returned above and
      // dialog/TUI-surface targets are handled by their owners.
      if (state.activeTabId && !insideBlockingSurface(event.target)) {
        const interruptKeys =
          state.keybindings?.effective["app.interrupt"] ?? DEFAULT_INTERRUPT_KEYS;
        if (interruptKeys.length > 0 && matchesBinding(event, interruptKeys)) {
          event.preventDefault();
          const key: TerminalKeyInput = {
            key: event.key,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            shiftKey: event.shiftKey,
            metaKey: event.metaKey,
          };
          void state.interruptRun(state.activeTabId, key);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return null;
}
