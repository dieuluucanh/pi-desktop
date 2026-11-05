import { useMemo } from "react";
import { PanelLeftOpen, Plus } from "lucide-react";

import { isSessionTab } from "../../../shared/session-ipc";

import { newSessionAction } from "../menu-actions";
import { useAppStore } from "../state/app-store";
import { Button } from "../ui/button";
import { GridLayoutMenu } from "./GridLayoutMenu";
import { TabList } from "./TabList";
import { TerminalSplitButton } from "./TerminalSplitButton";

/**
 * Session tabs (the app's original strip).
 *
 * Host-backed sessions, the Office host and web tabs live here. Editor tabs are
 * deliberately excluded and rendered by `EditorTabStrip` in the row below, so a
 * file never competes with a running session for the same strip. The row keeps
 * the chrome controls that belong to the session workspace: the
 * collapsed-sidebar escape hatch, New Session, a joined New Terminal chip
 * (default shell + one-off profile menu) and the grid switcher.
 */
export function SessionTabStrip(): React.JSX.Element {
  const allTabs = useAppStore((state) => state.tabs);
  const project = useAppStore((state) => state.project);
  const collapsed = useAppStore((state) => state.prefs.sidebarCollapsed);
  const toggleSidebar = useAppStore((state) => state.toggleSidebar);
  const tabs = useMemo(() => allTabs.filter(isSessionTab), [allTabs]);

  return (
    <div
      className="flex h-9 shrink-0 items-center gap-1 border-b border-line bg-sunken px-1"
      data-testid="session-tab-strip"
    >
      {collapsed ? (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Show sidebar"
          title="Show sidebar (Ctrl+B)"
          onClick={toggleSidebar}
        >
          <PanelLeftOpen className="size-3.5" aria-hidden />
        </Button>
      ) : null}
      <TabList
        tabs={tabs}
        label="Session tabs"
        empty={project ? "No session open" : "No project open"}
      />
      <div className="ml-auto flex items-center gap-1">
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={newSessionAction}
          aria-label="New session"
          title="New session (Ctrl+N)"
        >
          <Plus className="size-3.5" aria-hidden />
        </Button>
        <TerminalSplitButton />
        {/* Far right: the layout switcher (2026-11-03 plan). */}
        <GridLayoutMenu />
      </div>
    </div>
  );
}
