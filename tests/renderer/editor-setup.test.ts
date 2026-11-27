import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";

import { createEditorState } from "../../src/renderer/src/editor/setup";

/**
 * The editor always fills the pane (2026-11-27 plan step 1).
 *
 * jsdom has no layout, so these tests assert the removed measure surface
 * directly: there is no compartment to reconfigure, and no class or attribute
 * that a centred reading column would have installed.
 */

const mounted: EditorView[] = [];

function mount(wordWrap = true): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const created = createEditorState({
    doc: "# hello",
    readOnly: false,
    fontSize: 13,
    wordWrap,
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

describe("editor state", () => {
  it("exposes no measure compartment", () => {
    const created = createEditorState({
      doc: "# hello",
      readOnly: false,
      fontSize: 13,
      wordWrap: true,
      tabSize: 2,
    });

    expect(Object.keys(created.compartments)).not.toContain("measure");
  });

  it("keeps soft wrap on the same state", () => {
    const view = mount(true);

    expect(view.dom.querySelector(".cm-lineWrapping")).not.toBeNull();
  });

  it("mounts a view with no compact-measure mark", () => {
    const view = mount(false);

    expect(view.dom.hasAttribute("data-measure")).toBe(false);
    expect(view.dom.classList.contains("cm-measure-compact")).toBe(false);
  });
});
