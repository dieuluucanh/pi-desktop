import { useRef, useState } from "react";
import { Globe, Plus, X } from "lucide-react";

import {
  SESSION_STATUS_LABEL,
  isEditorTab,
  type TabRecord,
  type TabStatus,
} from "../../../shared/session-ipc";
import { languageBadge, languageIdForPath } from "../../../shared/languages";
import type { GridLayout } from "../../../shared/session-grid";
import { useAppStore } from "../state/app-store";
import { clearPane } from "../state/grid-actions";
import { isTabDrag, readTabDrop } from "./tab-drag";
import { PanePicker } from "./PanePicker";
import { paneAreaClass } from "./pane-areas";
import { TabSurface } from "../views/TabSurface";

/**
 * One cell of the session view grid (2026-11-03 plan).
 *
 * The pane owns three things and nothing else:
 *
 *  - **which tab it shows**, read from `prefs.grid.panes[index]` — never from the
 *    app-wide selection, so a background pane keeps its own session on screen;
 *  - **the drop target**, which accepts a tab dragged out of either strip or the
 *    sidebar and delegates the one-pane-per-tab rule to `assignPaneTab`;
 *  - **focus**, by making its tab the app-wide `activeTabId` on pointer-down.
 *
 * The surface itself is `TabSurface`, the same dispatcher the solo view uses, so a
 * pane behaves exactly like the main view for every tab kind.
 */

const STATUS_DOT: Record<TabStatus, string> = {
  starting: "bg-warn",
  idle: "bg-ok",
  running: "bg-accent",
  crashed: "bg-danger",
  failed: "bg-danger",
  stopped: "bg-ink-faint",
};

export function GridPane({
  index,
  layout,
}: {
  index: number;
  layout: GridLayout;
}): React.JSX.Element {
  const panes = useAppStore((state) => state.prefs.grid.panes);
  const tabs = useAppStore((state) => state.tabs);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const assignPaneTab = useAppStore((state) => state.assignPaneTab);
  const focusPane = useAppStore((state) => state.focusPane);
  const [dropActive, setDropActive] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const dropDepth = useRef(0);

  const tabId = panes[index] ?? null;
  const tab = tabId === null ? undefined : tabs.find((entry) => entry.id === tabId);
  const focused = tabId !== null && tabId === activeTabId;

  const resetDrop = (): void => {
    dropDepth.current = 0;
    setDropActive(false);
  };

  const onDragEnter = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!isTabDrag(event.dataTransfer)) return;
    event.preventDefault();
    dropDepth.current += 1;
    setDropActive(true);
  };

  const onDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!isTabDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const onDragLeave = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!isTabDrag(event.dataTransfer)) return;
    dropDepth.current = Math.max(0, dropDepth.current - 1);
    if (dropDepth.current === 0) setDropActive(false);
  };

  const onDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    resetDrop();
    const payload = readTabDrop(event.dataTransfer);
    if (!payload) return;
    event.preventDefault();
    void assignPaneTab(index, payload.tabId);
  };

  return (
    <section
      className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-sm border ${
        focused ? "border-accent" : "border-line"
      } ${dropActive ? "bg-accent/5" : "bg-surface"} ${paneAreaClass(layout, index)}`}
      data-testid={`pane-${index}`}
      data-pane-active={focused ? "true" : undefined}
      data-drop-active={dropActive ? "true" : undefined}
      aria-label={`Pane ${index + 1}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onPointerDownCapture={(event) => {
        // Clicking anywhere in a pane focuses it: its tab becomes the app-wide
        // selection, which is what menus, the palette and the rail follow.
        // Header controls are not content: the clear button must not activate
        // the tab it is about to remove.
        const target = event.target;
        if (target instanceof Element && target.closest("[data-pane-control]")) return;
        if (tabId !== null && !focused) void focusPane(index);
      }}
    >
      <header className="flex h-7 shrink-0 items-center gap-1.5 border-b border-line px-1.5">
        <span className="text-[10px] text-ink-faint" aria-hidden>
          {index + 1}
        </span>
        {tab ? <TabGlyph tab={tab} /> : null}
        <span
          className="min-w-0 flex-1 truncate text-[11px] text-ink-muted"
          title={tab ? `${tab.title}${tab.error ? ` · ${tab.error}` : ""}` : "Empty pane"}
          data-testid={`pane-title-${index}`}
        >
          {tab ? tab.title : "Empty"}
        </span>
        {tabId !== null ? (
          <button
            type="button"
            className="rounded-xs p-0.5 text-ink-faint hover:bg-raised hover:text-ink"
            aria-label={`Clear pane ${index + 1}`}
            title="Clear this pane"
            data-pane-control
            onClick={() => void clearPane(index)}
          >
            <X className="size-3" aria-hidden />
          </button>
        ) : null}
        <PanePicker
          paneIndex={index}
          assignedTabId={tabId}
          layout={layout}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
        />
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {tabId !== null ? (
          <TabSurface tabId={tabId} />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-xs text-ink-muted">
            <button
              type="button"
              aria-label={`Choose a tab for pane ${index + 1}`}
              aria-haspopup="menu"
              aria-expanded={pickerOpen}
              aria-controls={pickerOpen ? `pane-picker-content-${index}` : undefined}
              data-testid={`pane-empty-picker-${index}`}
              data-pane-control
              className="rounded-sm p-1.5 text-ink-muted hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              onClick={() => setPickerOpen(true)}
            >
              <Plus className="size-5" aria-hidden />
            </button>
            <span>Pick a session</span>
            <span className="text-[10px] text-ink-faint">or drop a tab here</span>
          </div>
        )}
      </div>
    </section>
  );
}

/** The tab's identity at a glance: the same glyph rules as the tab chip. */
function TabGlyph({ tab }: { tab: TabRecord }): React.JSX.Element {
  if (isEditorTab(tab)) {
    return (
      <span
        className="shrink-0 rounded-xs border border-line px-1 font-mono text-[9px] uppercase text-ink-muted"
        aria-hidden
      >
        {languageBadge(languageIdForPath(tab.filePath))}
      </span>
    );
  }
  if (tab.kind === "web") {
    return <Globe className="size-3 shrink-0 text-ink-faint" aria-hidden />;
  }
  return (
    <span
      className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[tab.status]}`}
      aria-hidden
      data-status={tab.status}
      title={SESSION_STATUS_LABEL[tab.status]}
    />
  );
}
