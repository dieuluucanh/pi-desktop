import type { TuiBounds } from "../../../shared/tui-surface";

/**
 * TUI grid geometry (2026-10-26 plan, step 1).
 *
 * The emulated terminal grid belongs to the **session column** — the box a
 * terminal would occupy in Pi — never to the TUI surface itself. Measuring the
 * surface made the reported `rows` depend on the frame the extension rendered,
 * so the workflow questionnaire (which sizes itself from `terminal.rows`)
 * collapsed to a single row. These helpers are pure so the critical maths is
 * testable without a DOM; `use-tui-viewport.ts` feeds them measured rects.
 */

export interface CellSize {
  width: number;
  height: number;
}

export interface TuiGrid {
  rows: number;
  cols: number;
}

/** jsdom has no layout; keep the historical defaults for deterministic tests. */
export const FALLBACK_CELL: CellSize = { width: 8, height: 16 };
export const FALLBACK_GRID: TuiGrid = { rows: 24, cols: 80 };

function positive(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * The cell grid for a laid-out box, or `null` when the box has no layout yet
 * (jsdom, a hidden tab). A `null` result tells the caller to keep its last grid
 * instead of reporting a bogus 1×1 terminal.
 */
export function gridFromRect(
  rect: { width: number; height: number },
  cell: CellSize,
): TuiGrid | null {
  const width = positive(rect.width);
  const height = positive(rect.height);
  const cellWidth = positive(cell.width);
  const cellHeight = positive(cell.height);
  if (width === null || height === null || cellWidth === null || cellHeight === null) {
    return null;
  }
  return {
    rows: Math.max(1, Math.floor(height / cellHeight)),
    cols: Math.max(1, Math.floor(width / cellWidth)),
  };
}

/**
 * True for the shape of a bottom sheet: full width and touching the bottom of
 * the viewport. The workflow questionnaire resolves to exactly this (anchor
 * `bottom-center`, width `100%`, margin `0`). A bottom-anchored, full-width
 * overlay is rendered in flow (a dock) so the transcript shrinks instead of
 * being covered; every other overlay floats inside the column.
 */
export function isDockedOverlay(bounds: TuiBounds | null, grid: TuiGrid): boolean {
  if (!bounds) return false;
  return bounds.col === 0 && bounds.width >= grid.cols && bounds.row + bounds.height >= grid.rows;
}

export interface OverlayPixelRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * The pixel rectangle of a floating overlay, clamped to the column. The host
 * reports bounds in terminal cells; the renderer is the only side that knows
 * the cell size.
 */
export function overlayPixelRect(
  bounds: TuiBounds,
  cell: CellSize,
  column: { width: number; height: number },
): OverlayPixelRect {
  const columnWidth = Math.max(1, Math.round(column.width));
  const columnHeight = Math.max(1, Math.round(column.height));
  const width = Math.min(columnWidth, Math.max(1, Math.round(bounds.width * cell.width)));
  const height = Math.min(columnHeight, Math.max(1, Math.round(bounds.height * cell.height)));
  return {
    top: clamp(Math.round(bounds.row * cell.height), 0, Math.max(0, columnHeight - height)),
    left: clamp(Math.round(bounds.col * cell.width), 0, Math.max(0, columnWidth - width)),
    width,
    height,
  };
}

/** A frame's rendered height in pixels, never below one cell. */
export function framePixelHeight(lines: number, cell: CellSize): number {
  return Math.max(1, Math.floor(lines)) * cell.height;
}
