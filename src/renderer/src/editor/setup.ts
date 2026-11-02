/**
 * Assembles a CodeMirror `EditorState`.
 *
 * Kept free of React so the buffer/pref rules can be tested (and so the view
 * component is a thin mount/unmount wrapper). Compartments let the editor
 * reconfigure the language, soft wrap, font size and tab width without
 * recreating the state — which would lose undo history and the cursor.
 */

import { EditorState, Compartment, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";

import { editorHighlightStyle, editorTheme } from "./theme";

export interface EditorCompartments {
  language: Compartment;
  wrap: Compartment;
  font: Compartment;
  tabSize: Compartment;
}

export interface EditorStateInput {
  doc: string;
  readOnly: boolean;
  fontSize: number;
  wordWrap: boolean;
  tabSize: number;
  onUpdate?: (update: ViewUpdate) => void;
}

export function createEditorState(input: EditorStateInput): {
  state: EditorState;
  compartments: EditorCompartments;
} {
  const compartments: EditorCompartments = {
    language: new Compartment(),
    wrap: new Compartment(),
    font: new Compartment(),
    tabSize: new Compartment(),
  };

  const extensions: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    drawSelection(),
    dropCursor(),
    history(),
    foldGutter(),
    indentOnInput(),
    bracketMatching(),
    syntaxHighlighting(editorHighlightStyle),
    keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
    EditorState.allowMultipleSelections.of(true),
    EditorState.readOnly.of(input.readOnly),
    EditorView.editable.of(!input.readOnly),
    compartments.language.of([]),
    compartments.wrap.of(input.wordWrap ? EditorView.lineWrapping : []),
    compartments.font.of(editorTheme(input.fontSize)),
    compartments.tabSize.of(EditorState.tabSize.of(input.tabSize)),
    ...(input.onUpdate ? [EditorView.updateListener.of(input.onUpdate)] : []),
  ];

  return {
    state: EditorState.create({ doc: input.doc, extensions }),
    compartments,
  };
}
