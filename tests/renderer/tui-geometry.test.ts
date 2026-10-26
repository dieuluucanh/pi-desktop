import { describe, expect, it } from "vitest";

import {
  FALLBACK_CELL,
  FALLBACK_GRID,
  framePixelHeight,
  gridFromRect,
  isDockedOverlay,
  overlayPixelRect,
} from "../../src/renderer/src/tui/tui-geometry";

/**
 * The TUI grid maths (2026-10-26 plan, step 1).
 *
 * The reported terminal grid is the session column, and the questionnaire's
 * row-aware sizing is only correct if the grid never comes from the extension's
 * own frame. These helpers are the pure half of that contract.
 */

describe("gridFromRect", () => {
  it("floors a laid-out box into terminal cells", () => {
    expect(gridFromRect({ width: 1200, height: 600 }, { width: 8, height: 16 })).toEqual({
      rows: 37,
      cols: 150,
    });
  });

  it("never reports a zero-row or zero-column terminal", () => {
    expect(gridFromRect({ width: 7, height: 15 }, { width: 8, height: 16 })).toEqual({
      rows: 1,
      cols: 1,
    });
  });

  it("returns null when there is no layout yet (jsdom, hidden tab)", () => {
    expect(gridFromRect({ width: 0, height: 600 }, FALLBACK_CELL)).toBeNull();
    expect(gridFromRect({ width: 1200, height: 0 }, FALLBACK_CELL)).toBeNull();
    expect(gridFromRect({ width: 1200, height: 600 }, { width: 0, height: 16 })).toBeNull();
  });

  it("has deterministic fallbacks", () => {
    expect(FALLBACK_GRID).toEqual({ rows: 24, cols: 80 });
    expect(FALLBACK_CELL).toEqual({ width: 8, height: 16 });
  });
});

describe("isDockedOverlay", () => {
  const grid = { rows: 60, cols: 150 };

  it("docks the workflow questionnaire shape (bottom-centre, 100%, margin 0)", () => {
    expect(isDockedOverlay({ row: 28, col: 0, width: 150, height: 32 }, grid)).toBe(true);
  });

  it("floats a centred or partial-width overlay", () => {
    expect(isDockedOverlay({ row: 25, col: 55, width: 40, height: 10 }, grid)).toBe(false);
    expect(isDockedOverlay({ row: 50, col: 0, width: 100, height: 10 }, grid)).toBe(false);
  });

  it("floats a full-width overlay that is not bottom-anchored", () => {
    expect(isDockedOverlay({ row: 4, col: 0, width: 150, height: 10 }, grid)).toBe(false);
  });

  it("treats missing bounds as a float", () => {
    expect(isDockedOverlay(null, grid)).toBe(false);
  });
});

describe("overlayPixelRect", () => {
  const cell = { width: 8, height: 16 };

  it("converts bounds to pixels", () => {
    expect(
      overlayPixelRect({ row: 2, col: 4, width: 20, height: 2 }, cell, {
        width: 1200,
        height: 600,
      }),
    ).toEqual({ top: 32, left: 32, width: 160, height: 32 });
  });

  it("clamps a box to the column", () => {
    expect(
      overlayPixelRect({ row: 30, col: 140, width: 40, height: 10 }, cell, {
        width: 1200,
        height: 600,
      }),
    ).toEqual({ top: 440, left: 880, width: 320, height: 160 });
  });

  it("caps a frame taller than the column", () => {
    const rect = overlayPixelRect({ row: 0, col: 0, width: 100, height: 100 }, cell, {
      width: 800,
      height: 300,
    });
    expect(rect.height).toBe(300);
    expect(rect.top).toBe(0);
  });
});

describe("framePixelHeight", () => {
  it("uses the cell height and keeps at least one row", () => {
    expect(framePixelHeight(32, { width: 8, height: 16 })).toBe(512);
    expect(framePixelHeight(0, { width: 8, height: 16 })).toBe(16);
  });
});
