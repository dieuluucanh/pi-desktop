import { Plus, X } from "lucide-react";
import { Button } from "../ui/button";
import { newSessionAction } from "../menu-actions";
import { useAppStore } from "../state/app-store";

/**
 * Session tab strip (plan step 1 shell; real tabs arrive in step 11).
 *
 * The strip is present but empty until the session service exists — the point of
 * shipping it now is that the *shape* of the app is fixed and step 11 only has to
 * fill it, instead of re-laying-out the window.
 */

export interface SessionTab {
  id: string;
  title: string;
  state: "idle" | "running" | "error";
}

export function TabStrip({ tabs = [] }: { tabs?: readonly SessionTab[] }) {
  const project = useAppStore((state) => state.project);

  return (
    <div
      className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-sunken px-1"
      role="tablist"
      aria-label="Session tabs"
    >
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tab"
          aria-selected
          className="flex h-7 items-center gap-2 rounded-sm border border-line bg-surface px-2 text-xs"
        >
          <span className="size-1.5 rounded-full bg-ink-faint" data-state={tab.state} aria-hidden />
          <span className="max-w-48 truncate">{tab.title}</span>
          <X className="size-3 text-ink-faint" aria-hidden />
        </div>
      ))}

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
