import { useEffect, useRef } from "react";
import { EditorView, type ViewUpdate } from "@codemirror/view";

import type { LanguageId } from "../../../shared/languages";
import { useEditorStore } from "./editor-store";
import { syncDocToView } from "./doc-sync";
import { registerEditorView, unregisterEditorView } from "./editor-registry";
import { languageExtension } from "./language-support";
import { createEditorState, type EditorCompartments } from "./setup";
import { editorTheme } from "./theme";

export interface CodeMirrorEditorProps {
  tabId: string;
  doc: string;
  languageId: LanguageId;
  readOnly: boolean;
  fontSize: number;
  wordWrap: boolean;
  tabSize: number;
  /**
   * Focus the editor when it mounts. False for a pane that is not the focused
   * one: with several editor panes mounted (2026-11-03 grid plan) each mount
   * calling `focus()` would steal the caret from the pane the user is typing in.
   */
  autoFocus?: boolean;
}

/**
 * Mounts one CodeMirror view per editor tab.
 *
 * The view is created once per tab (identity is the tab id), so switching tabs
 * does not lose undo history. Preferences are reconfigured through the
 * compartments created by `createEditorState`; the language extension is loaded
 * lazily after the view exists.
 */
export function CodeMirrorEditor(props: CodeMirrorEditorProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const compartmentsRef = useRef<EditorCompartments | null>(null);
  /** Set while a host-driven document replacement dispatches its transaction. */
  const suppressDocChangeRef = useRef(false);

  useEffect(() => {
    if (!hostRef.current) return;
    const onUpdate = (update: ViewUpdate): void => {
      const store = useEditorStore.getState();
      // A document replaced by a reload/format result is already in the buffer;
      // treating its transaction as a user edit would mark the tab dirty and
      // schedule a backup (2026-11-03 plan step 8).
      if (update.docChanged && !suppressDocChangeRef.current) {
        store.setText(props.tabId, update.state.doc.toString());
      }
      if (update.selectionSet || update.docChanged) {
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        store.setPosition(props.tabId, {
          line: line.number,
          column: head - line.from + 1,
          selectionLength: update.state.selection.ranges.reduce(
            (total, range) => total + (range.to - range.from),
            0,
          ),
        });
      }
    };
    const created = createEditorState({
      doc: props.doc,
      readOnly: props.readOnly,
      fontSize: props.fontSize,
      wordWrap: props.wordWrap,
      tabSize: props.tabSize,
      onUpdate,
      onSave: () => void useEditorStore.getState().save(props.tabId),
      onFormat: () => void useEditorStore.getState().format(props.tabId),
    });
    compartmentsRef.current = created.compartments;
    const view = new EditorView({ state: created.state, parent: hostRef.current });
    viewRef.current = view;
    registerEditorView(props.tabId, view);
    // Only the focused pane claims the caret (see `autoFocus`).
    if (props.autoFocus !== false) view.focus();
    return () => {
      unregisterEditorView(props.tabId, view);
      view.destroy();
      viewRef.current = null;
      compartmentsRef.current = null;
    };
    // A new state is created for a new tab only; doc/pref changes are handled
    // below through the compartments.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.tabId]);

  // Replace the document in place when the buffer changes outside the editor
  // (a reload, an external edit, a recovered backup). Remounting the view is
  // what used to flash the screen and lose undo history.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    suppressDocChangeRef.current = true;
    try {
      syncDocToView(view, props.doc);
    } finally {
      suppressDocChangeRef.current = false;
    }
  }, [props.doc]);

  useEffect(() => {
    const view = viewRef.current;
    const compartments = compartmentsRef.current;
    if (!view || !compartments) return;
    void languageExtension(props.languageId).then((extension) => {
      if (viewRef.current === view) {
        view.dispatch({ effects: compartments.language.reconfigure(extension) });
      }
    });
  }, [props.languageId]);

  useEffect(() => {
    const view = viewRef.current;
    const compartments = compartmentsRef.current;
    if (!view || !compartments) return;
    view.dispatch({ effects: compartments.font.reconfigure(editorTheme(props.fontSize)) });
  }, [props.fontSize]);

  useEffect(() => {
    const view = viewRef.current;
    const compartments = compartmentsRef.current;
    if (!view || !compartments) return;
    view.dispatch({
      effects: compartments.wrap.reconfigure(props.wordWrap ? EditorView.lineWrapping : []),
    });
  }, [props.wordWrap]);

  useEffect(() => {
    const view = viewRef.current;
    const compartments = compartmentsRef.current;
    if (!view || !compartments) return;
    view.dispatch({
      effects: compartments.tabSize.reconfigure(view.state.tabSize === props.tabSize ? [] : []),
    });
  }, [props.tabSize]);

  return (
    <div
      ref={hostRef}
      className="h-full min-h-0 overflow-hidden [&_.cm-editor]:h-full"
      data-testid="editor-surface"
    />
  );
}
