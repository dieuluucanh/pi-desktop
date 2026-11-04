import { describe, expect, it } from "vitest";
import {
  DEFAULT_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_LEVELS,
  clampZoomFactor,
  formatZoomPercent,
  zoomIn,
  zoomOut,
} from "../../src/shared/zoom";

/**
 * Display zoom arithmetic (2026-10-30 zoom plan). The renderer persists a level
 * and main applies it; these tests pin the range, the steps and the label.
 */

describe("clampZoomFactor", () => {
  it("defaults invalid input to 100 %", () => {
    expect(clampZoomFactor(undefined)).toBe(DEFAULT_ZOOM);
    expect(clampZoomFactor(null)).toBe(DEFAULT_ZOOM);
    expect(clampZoomFactor("big")).toBe(DEFAULT_ZOOM);
    expect(clampZoomFactor(Number.NaN)).toBe(DEFAULT_ZOOM);
  });

  it("clamps to 50 %–300 % and snaps to a supported level", () => {
    expect(clampZoomFactor(0.01)).toBe(MIN_ZOOM);
    expect(clampZoomFactor(99)).toBe(MAX_ZOOM);
    expect(clampZoomFactor(1.25)).toBe(1.25);
    expect(clampZoomFactor(0.85)).toBe(0.8);
    expect(clampZoomFactor(1.04)).toBe(1);
  });
});

describe("zoomIn / zoomOut", () => {
  it("steps through the levels", () => {
    expect(zoomIn(1)).toBe(1.1);
    expect(zoomIn(0.5)).toBe(0.67);
    expect(zoomOut(1)).toBe(0.9);
    expect(zoomOut(3)).toBe(2.5);
  });

  it("stops at the range ends", () => {
    expect(zoomIn(MAX_ZOOM)).toBe(MAX_ZOOM);
    expect(zoomOut(MIN_ZOOM)).toBe(MIN_ZOOM);
  });

  it("reaches every level going up and back down", () => {
    const up: number[] = [MIN_ZOOM];
    while (up[up.length - 1] !== MAX_ZOOM) up.push(zoomIn(up[up.length - 1]));
    expect(up).toEqual([...ZOOM_LEVELS]);

    const down: number[] = [MAX_ZOOM];
    while (down[down.length - 1] !== MIN_ZOOM) down.push(zoomOut(down[down.length - 1]));
    expect(down).toEqual([...ZOOM_LEVELS].reverse());
  });
});

describe("formatZoomPercent", () => {
  it("formats the supported levels", () => {
    expect(formatZoomPercent(1)).toBe("100%");
    expect(formatZoomPercent(1.25)).toBe("125%");
    expect(formatZoomPercent(0.67)).toBe("67%");
    expect(formatZoomPercent(undefined)).toBe("100%");
  });
});
