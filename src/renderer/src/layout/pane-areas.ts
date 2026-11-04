import { gridPaneCount, type GridLayout } from "../../../shared/session-grid";

/**
 * Tailwind grid-area classes for one pane slot.
 *
 * These literals live under the renderer scan root on purpose: `styles.css`
 * declares `@source "../../../shared"`, which resolves to a non-existent
 * `<repo>/shared`, so classes returned from `src/shared` compile to nothing. Every
 * class below is a complete literal and is unit tested without a DOM.
 *
 * The container is `grid-cols-2` and, for every multi-pane preset, two rows. The
 * explicit `row-start`/`col-start`/`row-span` values are load-bearing: spans alone
 * let CSS auto-placement push a pane into an implicit third row, which produced
 * the half-height two-pane column and the wrong three-pane shapes.
 */
const PANE_AREAS: Record<GridLayout, readonly string[]> = {
  // The container uses one row for single, so spanning a second row would create
  // an implicit row and halve the pane's height.
  single: ["col-span-2"],
  two: ["col-start-1 row-start-1 row-span-2", "col-start-2 row-start-1 row-span-2"],
  "three-left": [
    "col-start-1 row-start-1 row-span-2",
    "col-start-2 row-start-1",
    "col-start-2 row-start-2",
  ],
  // Current slot order is preserved: pane 2 is the tall right pane.
  "three-right": [
    "col-start-1 row-start-1",
    "col-start-2 row-start-1 row-span-2",
    "col-start-1 row-start-2",
  ],
  four: [
    "col-start-1 row-start-1",
    "col-start-2 row-start-1",
    "col-start-1 row-start-2",
    "col-start-2 row-start-2",
  ],
};

/** The classes placing pane `index` in `layout`; hidden when the layout lacks it. */
export function paneAreaClass(layout: GridLayout, index: number): string {
  if (index < 0 || index >= gridPaneCount(layout)) return "hidden";
  return PANE_AREAS[layout][index] ?? "hidden";
}
