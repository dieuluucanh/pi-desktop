/**
 * Applies a document produced outside the editor (a reload, a disk change, a
 * formatter result) to a live CodeMirror view.
 *
 * The alternative — remounting the component with a new `EditorState` — is what
 * made a background refresh flash the screen, steal focus and drop undo
 * history. A transaction keeps the same view, scroll position and history.
 *
 * The view shape is structural so this stays a pure, testable function: the
 * real caller passes a `@codemirror/view` `EditorView`.
 */

export interface DocSyncView {
  state: {
    doc: {
      toString(): string;
      length: number;
    };
  };
  dispatch(spec: {
    changes: {
      from: number;
      to: number;
      insert: string;
    };
  }): void;
}

/** Replaces the whole document when it differs. Returns whether it dispatched. */
export function syncDocToView(view: DocSyncView, next: string): boolean {
  if (view.state.doc.toString() === next) return false;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: next },
  });
  return true;
}
