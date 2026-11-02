/**
 * Live CodeMirror views by tab id.
 *
 * Save/format commands need the current view (the buffer registry has the text,
 * but focus/undo/selection live in the view). Keeping the map here avoids
 * threading refs through React and lets a menu command act on the active tab.
 */

import type { EditorView } from "@codemirror/view";

const views = new Map<string, EditorView>();

export function registerEditorView(tabId: string, view: EditorView): void {
  views.set(tabId, view);
}

export function unregisterEditorView(tabId: string, view: EditorView): void {
  if (views.get(tabId) === view) views.delete(tabId);
}

export function editorView(tabId: string | null): EditorView | undefined {
  return tabId === null ? undefined : views.get(tabId);
}

export function focusEditor(tabId: string): void {
  views.get(tabId)?.focus();
}
