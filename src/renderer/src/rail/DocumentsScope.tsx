/**
 * The Documents menu's scope: **which session owns the Office bridge**, and how
 * to change that.
 *
 * The Documents menu is the one app-wide menu (one bridge on port 38617, owned by
 * the single `office`-kind tab). Since the rail is project-scoped and the bridge
 * is not, this row is where the two meet — and it is deliberately small:
 *
 * ```text
 *  ▸ Documents
 *  Office host: Office session · danone-hcm
 *  Open host session   Use this session instead
 * ```
 *
 * The host's title and project used to be a two-line header with a status badge.
 * That header named the *host*, not the rail, so switching between sessions in
 * different projects left a project name on screen that had nothing to do with
 * the panel (2026-10-30 project-scoped rail plan). It is now one line that says
 * only what is *not* obvious — and says nothing at all when there is no host.
 *
 * Three actions, and they are genuinely different (plan D9):
 *
 *  - **Open host session** — meaningful in a non-host session, where it simply
 *    focuses the tab that already holds the port.
 *  - **Use this session instead** — the supported way to move the bridge. It
 *    *promotes this tab*, which demotes and restarts the current host, so it asks
 *    first (a click that silently interrupts someone's Office work would be a
 *    trap). A web tab cannot host the bridge and says so through the disabled
 *    button's title.
 *  - **Start an Office session** — the only useful action when no tab holds the
 *    port at all.
 *
 * Host facts come from `officeDocumentScope` so the renderer applies the same
 * predicate main does (`kind === "office" && status !== "stopped"`).
 */

import { useState } from "react";
import { Plug } from "lucide-react";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { useAppStore } from "../state/app-store";
import { officeDocumentScope, type OfficeDocumentPane } from "../../../shared/office-documents";
import { documentScopeNote } from "../../../shared/rail-scope";

export interface DocumentsScopeProps {
  /** The panes from the last `/health` probe (identifies the menu's contents). */
  panes: readonly OfficeDocumentPane[];
  /** The folder the rail is scoped to, so the note can omit a redundant path. */
  railFolder?: string | null;
  /** The active tab's kind: a `web` tab can never hold the bridge. */
  activeKind?: string | null;
  /**
   * True when the bridge is known not to be answering. That is the one moment a
   * host restart is the useful action, so the escape hatch appears only then
   * (2026-10-30 rail-headers plan).
   */
  bridgeDown?: boolean;
}

export function DocumentsScope({
  panes,
  railFolder = null,
  activeKind = null,
  bridgeDown = false,
}: DocumentsScopeProps): React.JSX.Element {
  const tabs = useAppStore((state) => state.tabs);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const activateTab = useAppStore((state) => state.activateTab);
  const promoteToOfficeHost = useAppStore((state) => state.promoteToOfficeHost);
  const openOfficeSession = useAppStore((state) => state.openOfficeSession);
  const restartTab = useAppStore((state) => state.restartTab);

  const [confirming, setConfirming] = useState(false);
  const { host, isHost } = officeDocumentScope(panes, tabs, activeTabId, railFolder);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const note = documentScopeNote({ host, isHost, railFolder });
  const canPromote = activeKind !== "web";

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
          {note ? (
            <p
              className="flex items-start gap-1.5 text-ink-faint"
              data-testid={
                note.tone === "host" ? "documents-scope-this-is-host" : "documents-scope-host"
              }
              title={host.projectPath}
            >
              <Plug className="mt-0.5 size-3 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">{note.text}</span>
            </p>
          ) : null}

          {isHost ? (
            bridgeDown ? (
              <div className="flex flex-wrap items-center gap-1">
                <RestartHostButton onRestart={() => void restartTab(host.id)} />
              </div>
            ) : null
          ) : (
            <div className="flex flex-wrap items-center gap-1">
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
                disabled={!canPromote}
                title={canPromote ? undefined : "A web tab cannot host the Office bridge."}
                onClick={() => setConfirming(true)}
              >
                Use this session instead
              </Button>
              {/* The bridge never came back after a takeover: restart the host
                  instead of making the user close and reopen a tab. */}
              {bridgeDown ? <RestartHostButton onRestart={() => void restartTab(host.id)} /> : null}
            </div>
          )}
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
              its session will restart. Whatever process currently holds the bridge port will be
              terminated (if that process is a terminal session, reopening that terminal is up to
              you), and the pane registry reconnects to this session.
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

/**
 * The escape hatch for a bridge that did not come back (2026-10-30 rail-headers
 * plan). It re-spawns the host session, which re-binds port 38617, so the user
 * does not have to close and reopen a tab — or a terminal — to recover.
 *
 * Restarting ends a running turn, so the consequence is in the title rather than
 * behind a second confirmation: the button only appears while the bridge is
 * already down, where there is no run in progress to lose.
 */
function RestartHostButton({ onRestart }: { onRestart: () => void }): React.JSX.Element {
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-5 px-1 text-[11px]"
      aria-label="Restart host session"
      title="Restart this session so it re-binds the Office bridge port."
      onClick={onRestart}
    >
      Restart host session
    </Button>
  );
}
