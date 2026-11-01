import { useState } from "react";
import { Globe, PanelLeftOpen, Plus, X } from "lucide-react";
import { Button } from "../ui/button";
import { InlineRename } from "../ui/inline-rename";
import { newSessionAction } from "../menu-actions";
import { useAppStore } from "../state/app-store";
import { TabMenu } from "./TabMenu";
import { SESSION_STATUS_LABEL, type TabStatus } from "../../../shared/session-ipc";

/**
 * Session tab strip (plan step 1 shell, real tabs since step 3, full lifecycle
 * since step 11).
 *
 * A tab is the renderer's handle on a supervised Pi host: clicking it activates
 * (and, if needed, re-spawns) the host, the `X` closes the tab and stops it, and
 * the dot shows the host's lifecycle at a glance. The per-tab menu carries the
 * rest of a session's lifecycle — rename, duplicate, clone, fork, export,
 * reveal, close others — and tabs can be dragged to reorder the strip (the
 * session service persists the order).
 */

const STATUS_DOT: Record<TabStatus, string> = {
  starting: "bg-warn",
  idle: "bg-ok",
  running: "bg-accent",
  crashed: "bg-danger",
  failed: "bg-danger",
  stopped: "bg-ink-faint",
};

export function TabStrip() {
  const tabs = useAppStore((state) => state.tabs);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const activateTab = useAppStore((state) => state.activateTab);
  const closeTab = useAppStore((state) => state.closeTab);
  const project = useAppStore((state) => state.project);
  const collapsed = useAppStore((state) => state.prefs.sidebarCollapsed);
  const toggleSidebar = useAppStore((state) => state.toggleSidebar);
  const renameSession = useAppStore((state) => state.renameSession);
  const [dragId, setDragId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line bg-sunken px-1">
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
      <div
        role="tablist"
        aria-label="Session tabs"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {tabs.map((tab, index) => {
          const active = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              draggable={renamingId !== tab.id}
              onDragStart={() => setDragId(tab.id)}
              onDragEnd={() => setDragId(null)}
              onDragOver={(event) => {
                if (dragId && dragId !== tab.id) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragId && dragId !== tab.id) {
                  void useAppStore.getState().moveTab(dragId, index);
                }
                setDragId(null);
              }}
              className={`flex h-7 items-center gap-1 rounded-sm border px-2 text-xs ${
                active ? "border-line-strong bg-surface" : "border-transparent bg-transparent"
              } ${dragId === tab.id ? "opacity-60" : ""}`}
              data-testid={`tab-${tab.id}`}
            >
              {renamingId === tab.id ? (
                <InlineRename
                  value={tab.title}
                  ariaLabel={`Rename ${tab.title}`}
                  className="w-36"
                  onCommit={(name) => {
                    setRenamingId(null);
                    void renameSession(tab.id, name);
                  }}
                  onCancel={() => setRenamingId(null)}
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => void activateTab(tab.id)}
                  onDoubleClick={() => setRenamingId(tab.id)}
                  title={tab.error ?? `${tab.cwd} · ${SESSION_STATUS_LABEL[tab.status]}`}
                  className="flex items-center gap-2"
                >
                  {tab.kind === "web" ? (
                    <Globe className="size-3 shrink-0 text-ink-faint" aria-hidden />
                  ) : (
                    <span
                      className={`size-1.5 rounded-full ${STATUS_DOT[tab.status]}`}
                      aria-hidden
                      data-status={tab.status}
                    />
                  )}
                  <span className="max-w-48 truncate">{tab.title}</span>
                </button>
              )}

              <TabMenu tab={tab} onRename={() => setRenamingId(tab.id)} />

              <button
                type="button"
                aria-label={`Close ${tab.title}`}
                onClick={() => void closeTab(tab.id)}
                className="text-ink-faint hover:text-ink"
              >
                <X className="size-3" aria-hidden />
              </button>
            </div>
          );
        })}

        {tabs.length === 0 ? (
          <span className="px-2 text-[11px] text-ink-faint">
            {project ? "No session open" : "No project open"}
          </span>
        ) : null}
      </div>

      <Button
        size="icon-sm"
        variant="ghost"
        className="ml-auto"
        onClick={newSessionAction}
        aria-label="New session"
        title="New session (Ctrl+N)"
      >
        <Plus className="size-3.5" aria-hidden />
      </Button>
    </div>
  );
}
