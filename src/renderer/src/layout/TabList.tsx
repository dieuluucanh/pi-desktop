import { useState } from "react";

import type { TabRecord } from "../../../shared/session-ipc";
import { useEditorStore } from "../editor/editor-store";
import { useAppStore } from "../state/app-store";
import { beginTabDrag, endTabDrag } from "../state/tab-drag-session";
import { TabChip } from "./TabChip";
import { writeTabDrag } from "./tab-drag";
import { useTabStripScroll } from "./use-tab-scroll";

/**
 * The scrollable, reorderable list inside one tab bar.
 *
 * The caller decides which tabs belong to the strip (`SessionTabStrip` filters
 * out editor tabs; `EditorTabStrip` keeps only them). Reordering is translated
 * back to the **global** `tabs` index, because the app and the main process
 * persist one ordering for every kind — a filtered index would move the tab
 * relative to the wrong neighbours.
 */

export interface TabListProps {
  tabs: readonly TabRecord[];
  label: string;
  /** Shown when the list is empty (the session strip's "No session open"). */
  empty?: string;
}

export function TabList({ tabs, label, empty }: TabListProps): React.JSX.Element {
  const activeTabId = useAppStore((state) => state.activeTabId);
  const renameSession = useAppStore((state) => state.renameSession);
  const ref = useTabStripScroll(activeTabId);
  const [dragId, setDragId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  return (
    <div
      ref={ref}
      role="tablist"
      aria-label={label}
      className="relative tab-strip-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain"
    >
      {tabs.map((tab) => (
        <TabChip
          key={tab.id}
          tab={tab}
          active={tab.id === activeTabId}
          dragging={dragId === tab.id}
          renaming={renamingId === tab.id}
          onActivate={() => void useAppStore.getState().activateTab(tab.id)}
          onStartRename={() => setRenamingId(tab.id)}
          onCancelRename={() => setRenamingId(null)}
          onCommitRename={(name) => {
            setRenamingId(null);
            void renameSession(tab.id, name);
          }}
          onDragStart={(event) => {
            // Two consumers, one gesture: the strip reorders from `dragId`, and a
            // grid pane accepts the typed payload (2026-11-03 plan).
            writeTabDrag(event.dataTransfer, tab.id);
            beginTabDrag();
            setDragId(tab.id);
          }}
          onDragEnd={() => {
            setDragId(null);
            endTabDrag();
          }}
          onDragOver={(event) => {
            if (dragId && dragId !== tab.id) event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            if (dragId && dragId !== tab.id) {
              const all = useAppStore.getState().tabs;
              const target = all.findIndex((entry) => entry.id === tab.id);
              if (target >= 0) void useAppStore.getState().moveTab(dragId, target);
            }
            setDragId(null);
          }}
          onClose={() => void useEditorStore.getState().requestClose(tab.id)}
        />
      ))}
      {tabs.length === 0 && empty ? (
        <span className="px-2 text-[11px] text-ink-faint">{empty}</span>
      ) : null}
    </div>
  );
}
