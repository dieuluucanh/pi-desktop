/**
 * The Documents menu's scope: **which session owns the live bridge**, and how to
 * change that.
 *
 * Ownership is no longer a tab kind; it is `/health.owner.sessionId`, published
 * by the bridge (0.6+). The old office-kind fallback only applies to a legacy
 * auto-start bridge. This row is the one place the user connects, disconnects or
 * moves the bridge:
 *
 * ```text
 *  ▸ Documents
 *  Office host: Office session · danone-hcm
 *  Open host session   Move bridge here
 * ```
 *
 * A bridge that is off offers **Connect this session**; an off bridge in a web
 * tab offers **Start an Office session** instead. A terminal/foreign owner is
 * shown with its PID and requires an explicit confirmation before takeover.
 */

import { useState } from "react";
import { Plug } from "lucide-react";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { useAppStore } from "../state/app-store";
import { documentScopeNote } from "../../../shared/rail-scope";
import {
  emptyOfficeDocumentsView,
  officeDocumentScope,
  type OfficeBridgeOwner,
  type OfficeDocumentPane,
  type OfficeDocumentsView,
} from "../../../shared/office-documents";
export interface DocumentsScopeProps {
  /**
   * The live registry. Optional for callers that only have panes (tests); the
   * store value is used when omitted.
   */
  view?: OfficeDocumentsView | null;
  /** Legacy/test form: a pane list without a full view. */
  panes?: readonly OfficeDocumentPane[];
  /** The folder the rail is scoped to, so the note can omit a redundant path. */
  railFolder?: string | null;
  /** The active tab's kind: a `web` tab can never hold the bridge. */
  activeKind?: string | null;
  /** Legacy/test form: the bridge is known to be down. */
  bridgeDown?: boolean;
}

function ownerSentence(owner: OfficeBridgeOwner | null): string {
  if (!owner) return "The bridge is running outside Pi Desktop.";
  const where = owner.cwd ? ` · ${owner.cwd}` : "";
  const pid = owner.pid ?? "?";
  if (owner.client === "cli") {
    return `Bridge owned by a terminal Pi session (PID ${pid}${where}).`;
  }
  if (owner.client === "desktop") {
    return `Bridge owned by another Pi Desktop session (PID ${pid}${where}).`;
  }
  return `The bridge is running outside Pi Desktop (PID ${pid}${where}).`;
}

export function DocumentsScope({
  view: suppliedView,
  panes,
  railFolder = null,
  activeKind = null,
  bridgeDown = false,
}: DocumentsScopeProps): React.JSX.Element {
  const storeView = useAppStore((state) => state.officeDocuments);
  const tabs = useAppStore((state) => state.tabs);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const activateTab = useAppStore((state) => state.activateTab);
  const connectOfficeBridge = useAppStore((state) => state.connectOfficeBridge);
  const closeOfficeBridge = useAppStore((state) => state.closeOfficeBridge);
  const restartOfficeBridge = useAppStore((state) => state.restartOfficeBridge);
  const openOfficeSession = useAppStore((state) => state.openOfficeSession);
  const refreshOfficeDocuments = useAppStore((state) => state.refreshOfficeDocuments);
  const installOfficeBridge = useAppStore((state) => state.installOfficeBridge);
  const busy = useAppStore((state) => state.officeBridgeBusy);

  const view: OfficeDocumentsView | null =
    suppliedView ??
    storeView ??
    (panes !== undefined
      ? {
          ...emptyOfficeDocumentsView(),
          available: !bridgeDown,
          status: bridgeDown ? "unreachable" : "ok",
          panes: [...panes],
        }
      : null);

  const { host, isHost } = officeDocumentScope(view ?? [], tabs, activeTabId, railFolder);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const available = view?.available === true;
  const manualLifecycle = view?.manualLifecycle === true;
  const legacy = available && !manualLifecycle;
  const owner = view?.owner ?? null;
  const portConflict = view?.status === "not-our-bridge";
  const canHost = activeKind !== "web" && activeTabId !== null;
  const busyReason = busy ? "An Office bridge action is already running." : undefined;
  const webReason = activeTabId === null ? undefined : "A web tab cannot host the Office bridge.";

  const [confirming, setConfirming] = useState<"move" | "takeover" | null>(null);

  const note = documentScopeNote({ host, isHost, railFolder });
  const close = (): void => {
    if (activeTabId) void closeOfficeBridge(activeTabId);
  };
  const restart = (): void => {
    if (activeTabId) void restartOfficeBridge(activeTabId);
  };
  const connect = (): void => {
    if (activeTabId) void connectOfficeBridge(activeTabId);
  };
  const move = async (): Promise<void> => {
    setConfirming(null);
    if (activeTabId) await connectOfficeBridge(activeTabId);
  };
  const takeover = async (): Promise<void> => {
    setConfirming(null);
    if (activeTabId) await connectOfficeBridge(activeTabId, { takeover: true });
  };

  const update = (): void => installOfficeBridge();

  const actionDisabled = busy || !canHost;
  const actionTitle = busy ? busyReason : webReason;

  return (
    <div
      className="flex shrink-0 flex-col gap-1 border-b border-line px-3 py-1 text-[11px]"
      data-testid="documents-scope"
    >
      {available && host ? (
        <>
          {note ? (
            <p
              className="flex items-start gap-1.5 text-ink-faint"
              data-testid={isHost ? "documents-scope-this-is-host" : "documents-scope-host"}
              title={host.projectPath}
            >
              <Plug className="mt-0.5 size-3 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">{note.text}</span>
            </p>
          ) : null}

          {legacy ? (
            <p className="text-warn" data-testid="documents-legacy-bridge">
              Automatic bridge (legacy). Update to connect and disconnect on demand.
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-1">
            {isHost ? (
              legacy ? (
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-5 px-1 text-[11px]"
                  onClick={update}
                >
                  Update bridge
                </Button>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 px-1 text-[11px]"
                    aria-label="Disconnect Office bridge"
                    onClick={close}
                    disabled={busy}
                    title={busyReason}
                  >
                    Disconnect
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 px-1 text-[11px]"
                    aria-label="Restart Office bridge"
                    onClick={restart}
                    disabled={busy}
                    title={busyReason}
                  >
                    Restart
                  </Button>
                </>
              )
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
                {legacy ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-5 px-1 text-[11px]"
                    onClick={update}
                  >
                    Update bridge
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 px-1 text-[11px]"
                    aria-label="Move bridge here"
                    disabled={actionDisabled}
                    title={actionTitle}
                    onClick={() => setConfirming("move")}
                  >
                    Move bridge here
                  </Button>
                )}
              </>
            )}
          </div>
        </>
      ) : available ? (
        <>
          <p
            className="flex items-start gap-1.5 text-ink-faint"
            data-testid="documents-scope-external"
          >
            <Plug className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">{ownerSentence(owner)}</span>
          </p>
          <div className="flex flex-wrap items-center gap-1">
            {legacy ? (
              <Button
                size="sm"
                variant="secondary"
                className="h-5 px-1 text-[11px]"
                onClick={update}
              >
                Update bridge
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="h-5 px-1 text-[11px]"
                aria-label="Take over Office bridge"
                disabled={actionDisabled}
                title={actionTitle}
                onClick={() => setConfirming("takeover")}
              >
                Take over bridge
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-5 px-1 text-[11px]"
              aria-label="Re-check Office bridge"
              onClick={() => void refreshOfficeDocuments()}
            >
              Re-check
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-ink-faint" data-testid="documents-scope-no-host">
            {portConflict ? "Port 38617 is owned by another program." : "The Office bridge is off."}
          </p>
          <div className="flex flex-wrap items-center gap-1">
            {portConflict ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-5 px-1 text-[11px]"
                aria-label="Take over Office port"
                disabled={actionDisabled}
                title={actionTitle}
                onClick={() => setConfirming("takeover")}
              >
                Take over port
              </Button>
            ) : canHost ? (
              <Button
                size="sm"
                variant="secondary"
                className="h-5 px-1 text-[11px]"
                aria-label="Connect this session"
                disabled={busy}
                title={busyReason}
                onClick={connect}
              >
                Connect this session
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                className="h-5 px-1 text-[11px]"
                aria-label="Start an Office session"
                disabled={busy}
                title={busyReason}
                onClick={() => void openOfficeSession()}
              >
                Start an Office session
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-5 px-1 text-[11px]"
              aria-label="Re-check Office bridge"
              onClick={() => void refreshOfficeDocuments()}
            >
              Re-check
            </Button>
          </div>
        </>
      )}

      {confirming === "move" && host ? (
        <ConfirmDialog
          open
          title={`Make “${activeTab?.title ?? "this session"}” the Office host?`}
          description={
            <>
              <span className="font-medium">{host.title}</span> will stop hosting the bridge. Its
              session stays open; only the bridge closes, and this session connects in its place.
            </>
          }
          confirmLabel="Move the bridge"
          onConfirm={() => void move()}
          onCancel={() => setConfirming(null)}
        />
      ) : null}

      {confirming === "takeover" ? (
        <ConfirmDialog
          open
          title="Take over the Office bridge?"
          description={
            <>
              {ownerSentence(owner)} Taking over terminates the process that owns port 38617. If
              that process is a terminal Pi session, reopening it is up to you.
            </>
          }
          confirmLabel="Take over"
          onConfirm={() => void takeover()}
          onCancel={() => setConfirming(null)}
        />
      ) : null}
    </div>
  );
}
