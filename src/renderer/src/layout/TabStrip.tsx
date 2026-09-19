import { Plus, X } from "lucide-react";
import { Button } from "../ui/button";
import { newSessionAction } from "../menu-actions";
import { useAppStore } from "../state/app-store";
import type { TabStatus } from "../../../shared/session-ipc";

/**
 * Session tab strip (plan step 1 shell, real tabs since step 3).
 *
 * A tab is the renderer's handle on a supervised Pi host: clicking it activates
 * (and, if needed, re-spawns) the host, the `X` closes the tab and stops it, and
 * the dot shows the host's lifecycle at a glance.
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

  return (
    <div
      className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-sunken px-1"
      role="tablist"
      aria-label="Session tabs"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            className={`flex h-7 items-center gap-1 rounded-sm border px-2 text-xs ${
              active ? "border-line-strong bg-surface" : "border-transparent bg-transparent"
            }`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => void activateTab(tab.id)}
              title={tab.error ?? `${tab.cwd} · ${tab.status}`}
              className="flex items-center gap-2"
            >
              <span
                className={`size-1.5 rounded-full ${STATUS_DOT[tab.status]}`}
                aria-hidden
                data-status={tab.status}
              />
              <span className="max-w-48 truncate">{tab.title}</span>
            </button>
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
