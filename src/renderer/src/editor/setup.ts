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
  type KeyBinding,
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

import { editorHighlightStyle, editorMeasureTheme, editorTheme } from "./theme";

/** The two content measures: the pane width, or a centred reading column. */
export type EditorMeasure = "full" | "compact";

export interface EditorCompartments {
  language: Compartment;
  wrap: Compartment;
  measure: Compartment;
  font: Compartment;
  tabSize: Compartment;
}

export interface EditorStateInput {
  doc: string;
  readOnly: boolean;
  fontSize: number;
  wordWrap: boolean;
  measure: EditorMeasure;
  widthColumns: number;
  tabSize: number;
  onUpdate?: (update: ViewUpdate) => void;
  /** `Mod-s` inside the editor surface (the editor view owns this chord). */
  onSave?: () => void;
  /** `Shift-Alt-f` inside the editor surface. */
  onFormat?: () => void;
}

/**
 * The extension pair for one measure.
 *
 * Compact carries both the class/attribute hook (which the tests and the CSS
 * target) and the theme, so the mode is assertable without computed styles.
 * Full is empty: the editor is simply the pane width.
 */
export function measureExtension(measure: EditorMeasure, widthColumns: number): Extension {
  if (measure !== "compact") return [];
  return [
    EditorView.editorAttributes.of({ class: "cm-measure-compact", "data-measure": "compact" }),
    editorMeasureTheme(widthColumns),
  ];
}

export function createEditorState(input: EditorStateInput): {
  state: EditorState;
  compartments: EditorCompartments;
} {
  const compartments: EditorCompartments = {
    language: new Compartment(),
    wrap: new Compartment(),
    measure: new Compartment(),
    font: new Compartment(),
    tabSize: new Compartment(),
  };

  // Editor-local keys come before CodeMirror's defaults, so `Mod-s` cannot be
  // shadowed by a future default binding. They are only installed when the host
  // component supplies a callback (an embedded state stays inert otherwise).
  const editorKeys: KeyBinding[] = [];
  const save = input.onSave;
  if (save) {
    editorKeys.push({
      key: "Mod-s",
      run: () => {
        save();
        return true;
      },
    });
  }
  const format = input.onFormat;
  if (format) {
    editorKeys.push({
      key: "Shift-Alt-f",
      run: () => {
        format();
        return true;
      },
    });
  }

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
    keymap.of([
      ...editorKeys,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      indentWithTab,
    ]),
    EditorState.allowMultipleSelections.of(true),
    EditorState.readOnly.of(input.readOnly),
    EditorView.editable.of(!input.readOnly),
    compartments.language.of([]),
    compartments.wrap.of(input.wordWrap ? EditorView.lineWrapping : []),
    compartments.measure.of(measureExtension(input.measure, input.widthColumns)),
    compartments.font.of(editorTheme(input.fontSize)),
    compartments.tabSize.of(EditorState.tabSize.of(input.tabSize)),
    ...(input.onUpdate ? [EditorView.updateListener.of(input.onUpdate)] : []),
  ];

  return {
    state: EditorState.create({ doc: input.doc, extensions }),
    compartments,
  };
}
