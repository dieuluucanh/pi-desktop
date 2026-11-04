import { describe, expect, it } from "vitest";

import { paneAreaClass } from "../../src/renderer/src/layout/pane-areas";

/**
 * The grid's explicit CSS placement (2026-11-03 polish plan step 2).
 *
 * Spans alone are not enough: with `grid-rows-2`, an item that only says
 * `row-span-2` can be auto-placed into an implicit third row. Every test below
 * pins the complete placement (`col-start`, `row-start`, span) for the layout.
 */

describe("paneAreaClass", () => {
  it("gives the single pane both columns in the one declared row", () => {
    expect(paneAreaClass("single", 0)).toBe("col-span-2");
  });

  it("puts two panes in two full-height columns", () => {
    expect([0, 1].map((index) => paneAreaClass("two", index))).toEqual([
      "col-start-1 row-start-1 row-span-2",
      "col-start-2 row-start-1 row-span-2",
    ]);
  });

  it("puts the tall pane on the left for three-left", () => {
    expect([0, 1, 2].map((index) => paneAreaClass("three-left", index))).toEqual([
      "col-start-1 row-start-1 row-span-2",
      "col-start-2 row-start-1",
      "col-start-2 row-start-2",
    ]);
  });

  it("puts the tall pane on the right for three-right", () => {
    expect([0, 1, 2].map((index) => paneAreaClass("three-right", index))).toEqual([
      "col-start-1 row-start-1",
      "col-start-2 row-start-1 row-span-2",
      "col-start-1 row-start-2",
    ]);
  });

  it("lays four panes out as an explicit 2x2", () => {
    expect([0, 1, 2, 3].map((index) => paneAreaClass("four", index))).toEqual([
      "col-start-1 row-start-1",
      "col-start-2 row-start-1",
      "col-start-1 row-start-2",
      "col-start-2 row-start-2",
    ]);
  });

  it("hides a pane index the layout does not show", () => {
    expect(paneAreaClass("two", 2)).toBe("hidden");
    expect(paneAreaClass("single", 1)).toBe("hidden");
    expect(paneAreaClass("four", -1)).toBe("hidden");
  });
});
