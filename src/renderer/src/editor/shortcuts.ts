/**
 * Editor-surface keyboard resolution.
 *
 * The desktop's global chords belong to the Electron menu, but save and format
 * are editor actions: they must work while CodeMirror (or the editor toolbar)
 * owns the keyboard, and they must not be installed as menu accelerators. An
 * accelerator fires before the renderer, which would swallow Pi's own
 * selector/TUI-local `Ctrl+S` bindings (`app.thinking.save`, `app.models.save`,
 * `app.session.toggleSort`).
 *
 * Kept pure and React-free so the modifier matrix is unit tested without a DOM.
 */

export interface EditorKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** True when CodeMirror's keymap already claimed the event. */
  defaultPrevented?: boolean;
}

export type EditorShortcut = "save" | "format";

/**
 * Save is `Mod-s` (Ctrl on Windows/Linux, Cmd on macOS) with no other
 * modifiers; Format is `Shift+Alt+F`. `Ctrl+Shift+S` is deliberately not save:
 * it is the platform's "Save As" chord and the editor has no such command.
 */
export function editorShortcut(event: EditorKeyEvent): EditorShortcut | null {
  if (event.defaultPrevented) return null;
  const key = event.key.toLowerCase();
  const mod = event.ctrlKey || event.metaKey;
  if (mod && !event.altKey && !event.shiftKey && key === "s") return "save";
  if (!mod && event.shiftKey && event.altKey && key === "f") return "format";
  return null;
}
