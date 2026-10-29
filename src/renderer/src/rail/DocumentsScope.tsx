/**
 * The Documents menu's scope: **which session owns the Office bridge**, and how
 * to change that.
 *
 * The Documents menu is the one app-wide menu (one bridge on port 38617, owned by
 * the single `office`-kind tab), which makes it the one that most needs to say so.
 * It appears in **every** session — hiding it would hide the fact that Office is
 * running — so the scope row answers three questions at a glance:
 *
 * ```text
 *  ▸ Documents
 *  [plug] Office session · danone-hcm      [running]
 *  Open host session   Use this session instead
 * ```
 *
 * Three actions, and they are genuinely different (plan D9):
 *
 *  - **Open host session** — meaningful in a non-host session, where it simply
 *    focuses the tab that already holds the port.
 *  - **Use this session instead** — the supported way to move the bridge. It
 *    *promotes this tab*, which demotes and restarts the current host, so it asks
 *    first (a click that silently interrupts someone's Office work would be a
 *    trap).
 *  - **Start an Office session** — the only useful action when no tab holds the
 *    port at all.
 *
 * Host facts come from `officeDocumentScope` so the renderer applies the same
 * predicate main does (`kind === "office" && status !== "stopped"`).
 */

import { useState } from "react";
import { Plug } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { useAppStore } from "../state/app-store";
import { officeDocumentScope, type OfficeDocumentPane } from "../../../shared/office-documents";
import { SESSION_STATUS_LABEL } from "../../../shared/session-ipc";
import { projectFolderName } from "./scope-view";

export interface DocumentsScopeProps {
  /** The panes from the last `/health` probe (identifies the menu's contents). */
  panes: readonly OfficeDocumentPane[];
}

export function DocumentsScope({ panes }: DocumentsScopeProps): React.JSX.Element {
  const tabs = useAppStore((state) => state.tabs);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const activateTab = useAppStore((state) => state.activateTab);
  const promoteToOfficeHost = useAppStore((state) => state.promoteToOfficeHost);
  const openOfficeSession = useAppStore((state) => state.openOfficeSession);

  const [confirming, setConfirming] = useState(false);
  const { host, isHost } = officeDocumentScope(panes, tabs, activeTabId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  const promote = async (): Promise<void> => {
    setConfirming(false);
    if (!activeTabId) return;
    await promoteToOfficeHost(activeTabId);
  };

  return (
    <div
      className="flex shrink-0 flex-col gap-1 border-b border-line px-3 py-1 text-[11px]"
      data-testid="documents-scope"
    >
      {host ? (
        <>
          <div className="flex items-center gap-1.5">
            <Plug className="size-3 shrink-0 text-ink-faint" aria-hidden />
            <span
              className="min-w-0 flex-1 truncate text-ink-muted"
              title={`${host.title} — ${host.projectPath}`}
              data-testid="documents-scope-host"
            >
              {host.title}
              <span className="text-ink-faint"> · {projectFolderName(host.projectPath)}</span>
            </span>
            <Badge tone={host.status === "running" ? "accent" : "neutral"}>
              {SESSION_STATUS_LABEL[host.status]}
            </Badge>
          </div>

          <div className="flex flex-wrap items-center gap-1">
            {isHost ? (
              <span className="text-ink-faint" data-testid="documents-scope-this-is-host">
                This session is the Office host.
              </span>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 px-1 text-[11px]"
                  aria-label="Open host session"
                  onClick={() => void activateTab(host.id)}
                >
                  Open host session
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 px-1 text-[11px]"
                  aria-label="Use this session instead"
                  onClick={() => setConfirming(true)}
                >
                  Use this session instead
                </Button>
              </>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="text-ink-faint" data-testid="documents-scope-no-host">
            No Office session is running the bridge.
          </p>
          <div>
            <Button
              size="sm"
              variant="secondary"
              className="h-5 px-1 text-[11px]"
              aria-label="Start an Office session"
              onClick={() => void openOfficeSession()}
            >
              Start an Office session
            </Button>
          </div>
        </>
      )}

      {confirming && host ? (
        <ConfirmDialog
          open
          title={`Make “${activeTab?.title ?? "this session"}” the Office host?`}
          description={
            <>
              <span className="font-medium">{host.title}</span> will stop being the Office host and
              its session will restart. Documents stay attached to the bridge; the pane registry
              reconnects to this session.
            </>
          }
          confirmLabel="Move the bridge"
          onConfirm={() => void promote()}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </div>
  );
}
