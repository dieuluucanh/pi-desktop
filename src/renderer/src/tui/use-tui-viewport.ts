import { useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import {
  FALLBACK_CELL,
  FALLBACK_GRID,
  gridFromRect,
  type CellSize,
  type TuiGrid,
} from "./tui-geometry";

/**
 * The stable terminal viewport (2026-10-26 plan, step 1).
 *
 * Terminal Pi's components size themselves from the terminal viewport. The
 * desktop's analog is the session column — transcript, status rows, the
 * composer/dock and the footer — not the TUI surface that the extension draws,
 * because the surface's own height is the extension's output. Measuring it fed
 * `terminal.rows` back into the component and collapsed the workflow
 * questionnaire to one row.
 *
 * The hook measures a hidden monospace probe for the cell size and the column
 * for the grid, reports the grid through `tui.resize`, and re-reports when the
 * tab or the tab's status changes (a host spawned after the first report still
 * receives the grid). It never reads the surface's frame.
 */

export interface TuiViewportState extends TuiGrid {
  cell: CellSize;
}

export interface TuiViewportOptions {
  ref: RefObject<HTMLElement | null>;
  tabId: string;
  /**
   * A value that changes when the session host may have been replaced (the tab
   * status). The grid is re-reported, even when it did not change, so a fresh
   * host starts from the real viewport instead of its 80×24 default.
   */
  revision?: string | null;
  report: (tabId: string, rows: number, cols: number) => void;
}

const PROBE_SELECTOR = "[data-tui-cell-probe]";

function measureCell(node: HTMLElement): CellSize | null {
  const probe = node.querySelector<HTMLElement>(PROBE_SELECTOR);
  if (!probe) return null;
  const rect = probe.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  return { width: rect.width, height: rect.height };
}

function sameCell(a: CellSize, b: CellSize): boolean {
  return a.width === b.width && a.height === b.height;
}

function sameGrid(a: TuiGrid, b: TuiGrid): boolean {
  return a.rows === b.rows && a.cols === b.cols;
}

export function useTuiViewport({
  ref,
  tabId,
  revision = null,
  report,
}: TuiViewportOptions): TuiViewportState {
  const [cell, setCell] = useState<CellSize>(FALLBACK_CELL);
  const [grid, setGrid] = useState<TuiGrid>(FALLBACK_GRID);

  // The measurement runs inside a layout effect and from resize callbacks, so it
  // keeps the latest grid in a ref instead of making state an effect dependency
  // (which would tear down the observer on every frame).
  const current = useRef({ cell, grid });
  const frameRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    let reported: TuiGrid | null = null;

    const measure = (): void => {
      frameRef.current = null;
      const measuredCell = measureCell(node);
      const nextCell = measuredCell ?? current.current.cell;
      const nextGrid = gridFromRect(node.getBoundingClientRect(), nextCell) ?? current.current.grid;

      if (!sameCell(nextCell, current.current.cell)) {
        current.current.cell = nextCell;
        setCell(nextCell);
      }
      if (!sameGrid(nextGrid, current.current.grid)) {
        current.current.grid = nextGrid;
        setGrid(nextGrid);
      }
      // Report on every effect run (tab/revision change) as well as on a grid
      // change, so a host that spawned after the first report is not left at its
      // 80×24 default. `resizeTuiSurface` is fire-and-forget and idempotent.
      if (!reported || !sameGrid(reported, nextGrid)) {
        reported = nextGrid;
        report(tabId, nextGrid.rows, nextGrid.cols);
      }
    };

    const schedule = (): void => {
      if (frameRef.current !== null) return;
      if (typeof requestAnimationFrame === "function") {
        frameRef.current = requestAnimationFrame(measure);
      } else {
        measure();
      }
    };

    measure();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(schedule);
      observer.observe(node);
      const probe = node.querySelector<HTMLElement>(PROBE_SELECTOR);
      if (probe) observer.observe(probe);
    }
    window.addEventListener("resize", schedule);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      if (frameRef.current !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(frameRef.current);
      }
      frameRef.current = null;
    };
  }, [ref, tabId, revision, report]);

  return { rows: grid.rows, cols: grid.cols, cell };
}
