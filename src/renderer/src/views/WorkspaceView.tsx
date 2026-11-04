import { useEffect } from "react";

import { gridSurface } from "../../../shared/session-grid";
import { endTabDrag, useTabDragActive } from "../state/tab-drag-session";
import { useAppStore } from "../state/app-store";
import { PaneGrid } from "../layout/PaneGrid";
import { TabSurface } from "./TabSurface";

/**
 * The session view: the grid, or one tab full-size.
 *
 * The rule lives in `gridMode` (shared, unit tested): a `single` layout is
 * inherently solo, a tab that no pane holds is shown full-size, and otherwise the
 * remembered grid is on screen. That is how "grid and single run in parallel" —
 * clicking a strip tab for something a pane already shows returns to the grid,
 * and clicking anything else shows it alone **without forgetting the layout**.
 *
 * This is also the one place that tells main which tabs are visible. Panes are a
 * renderer fact, so the push is driven by the same inputs as the decision and
 * deduped in the store; main pins those hosts against idle parking.
 */
export function WorkspaceView(): React.JSX.Element {
  const layout = useAppStore((state) => state.prefs.grid.layout);
  const lastMultiLayout = useAppStore((state) => state.prefs.grid.lastMultiLayout);
  const panes = useAppStore((state) => state.prefs.grid.panes);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const dragging = useTabDragActive();
  const syncVisibleTabs = useAppStore((state) => state.syncVisibleTabs);

  const surface = gridSurface({ layout, lastMultiLayout, panes, activeTabId, dragging });

  // Depends on `surface.mode`/`surface.layout` as well as the inputs: a change
  // that flips grid→solo (or back) changes what is on screen even when the pane
  // array is identical, and a drag reveal may use `lastMultiLayout`.
  useEffect(() => {
    syncVisibleTabs();
  }, [
    syncVisibleTabs,
    layout,
    lastMultiLayout,
    panes,
    activeTabId,
    dragging,
    surface.mode,
    surface.layout,
  ]);

  // A source that unmounts mid-drag must not leave the grid revealed. HTML5
  // drags always end with `dragend`; `drop` and window blur are belt-and-braces.
  useEffect(() => {
    const end = (): void => endTabDrag();
    window.addEventListener("dragend", end);
    window.addEventListener("drop", end);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("dragend", end);
      window.removeEventListener("drop", end);
      window.removeEventListener("blur", end);
    };
  }, []);

  return (
    <div
      className={`h-full min-h-0${surface.dragReveal ? " opacity-80 transition-opacity" : ""}`}
      data-testid="workspace-view"
      data-grid-mode={surface.mode}
      data-layout={surface.mode === "grid" ? surface.layout : undefined}
      data-drag-reveal={surface.dragReveal ? "true" : undefined}
    >
      {surface.mode === "grid" ? (
        <PaneGrid layout={surface.layout} />
      ) : (
        <TabSurface tabId={activeTabId} />
      )}
    </div>
  );
}
