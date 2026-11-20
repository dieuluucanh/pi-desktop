import { afterEach, describe, expect, it, vi } from "vitest";

import { textareaVisualLines } from "../../src/renderer/src/session/textarea-visual-lines";

/**
 * The composer's displayed-row measurement (2026-11-15 plan).
 *
 * jsdom has no layout engine (and no `Range.getBoundingClientRect`), so the
 * happy path stubs the geometry the module reads. The real wrapping is covered
 * by the Electron E2E test; here the contract is: never guess when layout is
 * missing, and turn the stub geometry into the right rows.
 */

function makeTextarea(value: string): HTMLTextAreaElement {
  const node = document.createElement("textarea");
  node.value = value;
  document.body.appendChild(node);
  return node;
}

/** The only computed-style member the module reads. */
function fakeStyles(lineHeight: string): CSSStyleDeclaration {
  return {
    getPropertyValue: (property: string) => (property === "line-height" ? lineHeight : ""),
  } as unknown as CSSStyleDeclaration;
}

/** jsdom does not implement Range geometry; remember whether we replaced one. */
const rangePrototype = window.Range.prototype as unknown as {
  getBoundingClientRect?: () => DOMRect;
};
const originalRangeRect = rangePrototype.getBoundingClientRect;

function stubRangeGeometry(resolve: (range: Range) => number): void {
  Object.defineProperty(rangePrototype, "getBoundingClientRect", {
    configurable: true,
    value(this: Range) {
      return new DOMRect(0, resolve(this), 1, 20);
    },
  });
}

function stubRangeTop(top: number): void {
  stubRangeGeometry(() => top);
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalRangeRect) {
    Object.defineProperty(rangePrototype, "getBoundingClientRect", {
      configurable: true,
      value: originalRangeRect,
    });
  } else {
    delete rangePrototype.getBoundingClientRect;
  }
  document.body.replaceChildren();
});

describe("textareaVisualLines", () => {
  it("returns null when the environment cannot lay the mirror out", () => {
    const node = makeTextarea("a long value");
    expect(textareaVisualLines(node, 3)).toBeNull();
  });

  it("treats an empty buffer as a single row", () => {
    expect(textareaVisualLines(makeTextarea(""), 0)).toEqual({ row: 0, lastRow: 0 });
  });

  it("returns null for a non-numeric line-height", () => {
    const node = makeTextarea("wrapped");
    Object.defineProperty(node, "clientWidth", { configurable: true, value: 300 });
    vi.spyOn(window, "getComputedStyle").mockReturnValue(fakeStyles("normal"));
    expect(textareaVisualLines(node, 0)).toBeNull();
  });

  it("returns null for a zero-width (hidden) textarea", () => {
    const node = makeTextarea("wrapped");
    Object.defineProperty(node, "clientWidth", { configurable: true, value: 0 });
    vi.spyOn(window, "getComputedStyle").mockReturnValue(fakeStyles("20px"));
    expect(textareaVisualLines(node, 0)).toBeNull();
  });

  it("returns null when the textarea does not soft-wrap", () => {
    const node = makeTextarea("wrapped");
    node.wrap = "off";
    expect(textareaVisualLines(node, 0)).toBeNull();
  });

  it("measures the character's row at the caret", () => {
    const node = makeTextarea("a value that wraps");
    Object.defineProperty(node, "clientWidth", { configurable: true, value: 300 });
    vi.spyOn(window, "getComputedStyle").mockReturnValue(fakeStyles("20px"));
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 300, 100),
    );
    stubRangeTop(40);

    expect(textareaVisualLines(node, 4)).toEqual({ row: 2, lastRow: 4 });
  });

  it("probes the line's last character when the caret is before a newline", () => {
    const node = makeTextarea("first\nsecond");
    Object.defineProperty(node, "clientWidth", { configurable: true, value: 300 });
    vi.spyOn(window, "getComputedStyle").mockReturnValue(fakeStyles("20px"));
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 300, 100),
    );
    // Offset 5 is the newline after "first": the character probe is 't' (row 0).
    stubRangeGeometry((range) => (range.collapsed ? 60 : 0));

    expect(textareaVisualLines(node, 5)).toEqual({ row: 0, lastRow: 4 });
  });

  it("uses the collapsed caret on an empty line", () => {
    const node = makeTextarea("a\n\nb");
    Object.defineProperty(node, "clientWidth", { configurable: true, value: 300 });
    vi.spyOn(window, "getComputedStyle").mockReturnValue(fakeStyles("20px"));
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 300, 100),
    );
    // Offset 2 is the empty second line: there is no character of its own.
    stubRangeGeometry((range) => (range.collapsed ? 20 : 0));

    expect(textareaVisualLines(node, 2)).toEqual({ row: 1, lastRow: 4 });
  });

  it("reports the last displayed row for the end of the buffer", () => {
    const node = makeTextarea("a\nb");
    Object.defineProperty(node, "clientWidth", { configurable: true, value: 300 });
    vi.spyOn(window, "getComputedStyle").mockReturnValue(fakeStyles("20px"));
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 300, 100),
    );
    stubRangeTop(0);

    expect(textareaVisualLines(node, 3)).toEqual({ row: 4, lastRow: 4 });
  });

  it("clamps a row above or below the mirror", () => {
    const node = makeTextarea("a value that wraps");
    Object.defineProperty(node, "clientWidth", { configurable: true, value: 300 });
    vi.spyOn(window, "getComputedStyle").mockReturnValue(fakeStyles("20px"));
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 300, 100),
    );

    stubRangeTop(-100);
    expect(textareaVisualLines(node, 0)).toEqual({ row: 0, lastRow: 4 });

    stubRangeTop(400);
    expect(textareaVisualLines(node, 0)).toEqual({ row: 4, lastRow: 4 });
  });

  it("always removes the mirror, even on the no-geometry path", () => {
    const node = makeTextarea("a value that wraps");
    Object.defineProperty(node, "clientWidth", { configurable: true, value: 300 });
    vi.spyOn(window, "getComputedStyle").mockReturnValue(fakeStyles("20px"));
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 300, 100),
    );
    const before = document.body.childElementCount;

    expect(textareaVisualLines(node, 0)).toBeNull();
    expect(document.body.childElementCount).toBe(before);
  });
});
