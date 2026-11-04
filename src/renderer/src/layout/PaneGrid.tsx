import { useMemo } from "react";

import { gridPaneCount, gridRowCount, type GridLayout } from "../../../shared/session-grid";
import { useAppStore } from "../state/app-store";
import { GridPane } from "./GridPane";

/**
 * The session view grid (2026-11-03 plan).
 *
 * A preset layout of 1/2/3/3/4 panes, laid out with two CSS-grid columns. The
 * pane count/row count come from `shared/session-grid.ts`; the complete Tailwind
 * placement literals live in `pane-areas.ts` under the renderer scan root. The
 * pane indices here match the ones `prefs.grid.panes` stores.
 *
 * The grid only renders the content area: the tab strips, the sidebar and the
 * panel rail stay global chrome, exactly as in the single-tab view.
 */
export function PaneGrid({ layout: override }: { layout?: GridLayout } = {}): React.JSX.Element {
  const storedLayout = useAppStore((state) => state.prefs.grid.layout);
  const layout = override ?? storedLayout;
  const count = gridPaneCount(layout);
  // A preset change must not remount a pane that keeps its tab: the index is the
  // React key, and panes are addressed by index everywhere else too.
  const indices = useMemo(() => Array.from({ length: count }, (_, index) => index), [count]);

  return (
    <div
      className={`grid h-full min-h-0 grid-cols-2 gap-1 p-1 ${
        gridRowCount(layout) === 1 ? "grid-rows-1" : "grid-rows-2"
      }`}
      data-testid="pane-grid"
      data-layout={layout}
      role="group"
      aria-label="Session grid"
    >
      {indices.map((index) => (
        <GridPane key={index} index={index} layout={layout} />
      ))}
    </div>
  );
}
