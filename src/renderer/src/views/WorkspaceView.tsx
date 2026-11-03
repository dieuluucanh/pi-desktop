import { useEffect } from "react";

import { gridMode } from "../../../shared/session-grid";
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
  const panes = useAppStore((state) => state.prefs.grid.panes);
  const solo = useAppStore((state) => state.gridSolo);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const syncVisibleTabs = useAppStore((state) => state.syncVisibleTabs);

  const mode = gridMode({ layout, panes, solo, activeTabId });

  // Depends on `mode` as well as the inputs: a change that flips grid→solo (or
  // back) changes what is on screen even when the pane array is identical.
  useEffect(() => {
    syncVisibleTabs();
  }, [syncVisibleTabs, layout, panes, solo, activeTabId, mode]);

  return (
    <div className="h-full min-h-0" data-testid="workspace-view" data-grid-mode={mode}>
      {mode === "grid" ? <PaneGrid /> : <TabSurface tabId={activeTabId} />}
    </div>
  );
}
