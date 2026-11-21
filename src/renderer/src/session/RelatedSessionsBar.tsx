import { ArrowLeft, ChevronRight, Link2 } from "lucide-react";

import type { ArchivedRelatedSession } from "../../../shared/related-session-archive";
import type { TabRecord } from "../../../shared/session-ipc";
import { Button } from "../ui/button";

/**
 * Generic related-session navigation (orchestrator plan step 13).
 *
 * Related tabs are normal tabs. This bar only surfaces the link the main
 * process persisted (`relatedParentTabId`) and the bounded archive of closed
 * children. It knows no extension and no mode:
 *
 *   - a child offers "Parent: …";
 *   - a parent lists its live children and archived children;
 *   - opening an archived child goes through the normal tab path, which focuses
 *     an existing writer instead of creating a second one.
 */
export interface RelatedSessionsBarProps {
  active: TabRecord | null;
  tabs: readonly TabRecord[];
  archive: readonly ArchivedRelatedSession[];
  onActivate: (tabId: string) => void;
  onOpenArchived: (entry: ArchivedRelatedSession) => void;
  className?: string;
}

export function RelatedSessionsBar({
  active,
  tabs,
  archive,
  onActivate,
  onOpenArchived,
  className,
}: RelatedSessionsBarProps) {
  if (!active) return null;
  const parent = active.relatedParentTabId
    ? (tabs.find((tab) => tab.id === active.relatedParentTabId) ?? null)
    : null;
  const children = tabs.filter((tab) => tab.relatedParentTabId === active.id);
  const archived = archive.filter(
    (entry) =>
      entry.parentTabId === active.id &&
      !children.some((child) => child.sessionFile === entry.sessionFile),
  );
  if (!active.relatedParentTabId && children.length === 0 && archived.length === 0) return null;

  return (
    <div
      data-testid="related-sessions-bar"
      role="region"
      aria-label="Related sessions"
      className={
        className ??
        "flex shrink-0 flex-wrap items-center gap-2 border-t border-line bg-surface px-3 py-1 text-[11px]"
      }
    >
      <span className="flex items-center gap-1 text-ink-faint">
        <Link2 className="size-3.5" aria-hidden />
        Related
      </span>
      {active.relatedParentTabId ? (
        parent ? (
          <Button
            size="sm"
            variant="ghost"
            data-testid="related-parent"
            title={`Open the parent session: ${parent.title}`}
            onClick={() => onActivate(parent.id)}
          >
            <ArrowLeft className="size-3" aria-hidden />
            {parent.title}
          </Button>
        ) : (
          <span data-testid="related-parent-missing" className="text-ink-faint">
            Parent closed
          </span>
        )
      ) : null}
      {children.map((child) => (
        <Button
          key={child.id}
          size="sm"
          variant="ghost"
          data-testid="related-child"
          data-status={child.status}
          title={`Open ${child.title}`}
          onClick={() => onActivate(child.id)}
        >
          <ChevronRight className="size-3" aria-hidden />
          {child.title}
        </Button>
      ))}
      {archived.map((entry) => (
        <Button
          key={`${entry.parentTabId}:${entry.sessionRef}`}
          size="sm"
          variant="ghost"
          data-testid="related-archived"
          title={`Reopen the archived transcript: ${entry.title}`}
          onClick={() => onOpenArchived(entry)}
        >
          {entry.title}
          <span className="ml-1 text-ink-faint">archived</span>
        </Button>
      ))}
    </div>
  );
}
