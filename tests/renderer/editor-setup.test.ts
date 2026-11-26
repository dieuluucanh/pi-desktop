import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";

import {
  createEditorState,
  measureExtension,
  type EditorMeasure,
} from "../../src/renderer/src/editor/setup";

/**
 * The measure compartment (2026-11-25 plan step 10).
 *
 * jsdom has no layout, so the test asserts the mode itself — the class and the
 * `data-measure` attribute on the content element — rather than a computed
 * `max-width`. Those are exactly what the theme's CSS selector targets, and
 * they make the reconfigure path assertable without recreating the view.
 */

const mounted: EditorView[] = [];

function mount(measure: EditorMeasure, widthColumns = 100): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const created = createEditorState({
    doc: "# hello",
    readOnly: false,
    fontSize: 13,
    wordWrap: true,
    measure,
    widthColumns,
    tabSize: 2,
  });
  const view = new EditorView({ state: created.state, parent });
  mounted.push(view);
  return view;
}

afterEach(() => {
  while (mounted.length > 0) {
    const view = mounted.pop();
    if (view) {
      const parent = view.dom.parentElement;
      view.destroy();
      parent?.remove();
    }
  }
});

describe("editor measure", () => {
  it("marks a compact view with the measure class and attribute", () => {
    const view = mount("compact", 88);

    expect(view.dom.classList.contains("cm-measure-compact")).toBe(true);
    expect(view.dom.dataset.measure).toBe("compact");
  });

  it("leaves a full-width view unmarked", () => {
    const view = mount("full");

    expect(view.dom.classList.contains("cm-measure-compact")).toBe(false);
    expect(view.dom.dataset.measure).toBeUndefined();
  });

  it("toggles the mark when the measure compartment is reconfigured", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const created = createEditorState({
      doc: "# hello",
      readOnly: false,
      fontSize: 13,
      wordWrap: true,
      measure: "full",
      widthColumns: 100,
      tabSize: 2,
    });
    const view = new EditorView({ state: created.state, parent });
    mounted.push(view);

    expect(view.dom.classList.contains("cm-measure-compact")).toBe(false);

    view.dispatch({
      effects: created.compartments.measure.reconfigure(measureExtension("compact", 72)),
    });
    expect(view.dom.classList.contains("cm-measure-compact")).toBe(true);
    expect(view.dom.dataset.measure).toBe("compact");

    view.dispatch({
      effects: created.compartments.measure.reconfigure(measureExtension("full", 72)),
    });
    expect(view.dom.classList.contains("cm-measure-compact")).toBe(false);
    expect(view.dom.dataset.measure).toBeUndefined();
  });

  it("keeps the wrap flag on the same state", () => {
    const view = mount("compact");

    expect(view.dom.querySelector(".cm-lineWrapping")).not.toBeNull();
  });
});
