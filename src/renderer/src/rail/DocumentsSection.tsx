/**
 * The Documents section body.
 *
 * The pane registry the bridge publishes on `/health`, as a list. The section is
 * **always rendered** while the Documents menu is on screen (2026-10-30
 * rail-headers plan): the rail decides presence from the install fact, so a body
 * that vanished would leave a titled, blank panel. When the bridge is not
 * answering it says why — "still starting" and "another program owns the port"
 * need different actions — and the toolbar keeps its re-check.
 *
 * **Host awareness (plan D10).** The bridge is app-wide, but an `office_*` call
 * is served by exactly one session: the tab that owns port 38617. So the two
 * actions that write into the composer — *Chat about this* and *Insert #mention*
 * — are only enabled **in the host session**; everywhere else they are disabled
 * and a line says why and points at the scope row's *Use this session instead*.
 * Offering a button whose prompt can never be served is worse than offering the
 * fix, and this body has no way to move the bridge itself: the scope row above it
 * owns that, which is why `OfficeHostFooter` no longer lives here.
 */

import { useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { copyText } from "../ui/clipboard";
import { useAppStore } from "../state/app-store";
import {
  formatPaneAge,
  shortDocumentId,
  type OfficeDocumentPane,
} from "../../../shared/office-documents";
import { PI_FOR_OFFICE, PI_OFFICE_BRIDGE } from "../../../shared/office";

/** A tiny copy-to-clipboard button that confirms itself, like the transcript's. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="text-[11px] text-ink-faint hover:text-ink"
      onClick={() => {
        void copyText(value).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1_500);
        });
      }}
    >
      {copied ? "copied" : label}
    </button>
  );
}

function PaneRow({ pane, isHost }: { pane: OfficeDocumentPane; isHost: boolean }) {
  const chatAboutDocument = useAppStore((state) => state.chatAboutDocument);
  const setDraft = useAppStore((state) => state.setDraft);
  const activeTabId = useAppStore((state) => state.activeTabId);

  const id = pane.documentId ?? pane.targetId;

  const insertMention = (): void => {
    if (!activeTabId) return;
    const draft = useAppStore.getState().prefs.drafts[activeTabId] ?? "";
    const mention = `#${pane.mention}`;
    if (draft.includes(mention)) return;
    const next =
      draft.length > 0 && !draft.endsWith(" ") ? `${draft} ${mention} ` : `${draft}${mention} `;
    setDraft(activeTabId, next);
  };

  return (
    <li
      className="rounded-sm border border-line bg-raised/60 px-2 py-2 text-xs"
      data-testid={`document-pane-${pane.paneId ?? pane.mention}`}
      data-host={pane.host ?? "unknown"}
    >
      <div className="flex items-center gap-2">
        <Badge tone={pane.focused ? "accent" : "neutral"}>{pane.hostLabel}</Badge>
        <span
          className="min-w-0 flex-1 truncate font-medium"
          title={pane.documentName ?? undefined}
        >
          {pane.documentName ?? "Untitled document"}
        </span>
        {pane.focused ? <Badge tone="ok">focused</Badge> : null}
        {!pane.visible ? <Badge tone="warn">hidden</Badge> : null}
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-faint">
        <span className="font-mono" title={id ?? undefined}>
          {shortDocumentId(id)}
        </span>
        {pane.windows > 1 ? <span>{pane.windows} windows</span> : null}
        <span title={pane.ops.join(", ")}>
          {pane.ops.length > 0 ? `${pane.ops.length} ops` : "legacy v1 ops"}
        </span>
        <span>seen {formatPaneAge(pane.lastSeen)}</span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          aria-label={`Chat about ${pane.documentName ?? "this document"}`}
          // Only the host session can serve the `office_*` call the tag implies.
          disabled={!isHost}
          title={isHost ? undefined : NOT_HOST_REASON}
          onClick={() => chatAboutDocument(pane)}
        >
          Chat about this
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Insert document mention"
          disabled={!isHost}
          title={isHost ? undefined : NOT_HOST_REASON}
          onClick={insertMention}
        >
          Insert #{pane.mention}
        </Button>
        {id ? <CopyButton value={id} label="Copy id" /> : null}
      </div>
    </li>
  );
}

function EmptyState() {
  const refresh = useAppStore((state) => state.refreshOfficeDocuments);
  return (
    <div className="px-3 py-4 text-xs text-ink-muted" data-testid="documents-empty">
      <p>
        The bridge is listening, but no document is attached. Open the Pi for Office add-in in
        Excel, Word or PowerPoint.
      </p>
      <Button
        size="sm"
        variant="secondary"
        className="mt-2"
        onClick={() => void refresh()}
        aria-label="Re-check for documents"
      >
        <RefreshCw className="mr-1 size-3" aria-hidden /> Re-check
      </Button>
    </div>
  );
}

/** Why the two composer actions are unavailable outside the host session. */
const NOT_HOST_REASON =
  'Only the Office host session can serve this. Use "Use this session instead" in the Documents header.';

export interface DocumentsSectionProps {
  /**
   * Whether the **active** session is the Office host (the tab that owns bridge
   * port 38617). Resolved by the caller through `officeDocumentScope` so the
   * renderer applies the same predicate main does.
   */
  isHost: boolean;
  /**
   * Rendered at the right of the section's toolbar. The standalone panel passes
   * its close button here; inside the rail the section header owns collapsing,
   * so nothing is passed.
   */
  trailing?: ReactNode;
}

/** The pane list, with its toolbar, empty state and host footer. */
export function DocumentsSection({ isHost, trailing }: DocumentsSectionProps) {
  const view = useAppStore((state) => state.officeDocuments);
  const refresh = useAppStore((state) => state.refreshOfficeDocuments);

  // A body that returned `null` for a missing probe would leave a titled, blank
  // panel now that the menu no longer depends on `/health` (2026-10-30
  // rail-headers plan). Before the first probe the status is `unknown`, which
  // reads as the same "waiting" sentence.
  const available = view?.available === true;
  const panes = view?.panes ?? [];
  const waiting = unavailableCopy(view?.status ?? "unknown");

  return (
    <div className="flex min-h-0 flex-col" data-testid="documents-section">
      <div className="flex shrink-0 items-center gap-2 px-3 py-1">
        {available ? <Badge tone="neutral">{panes.length}</Badge> : null}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="text-ink-faint hover:text-ink"
            aria-label="Refresh documents"
            onClick={() => void refresh()}
          >
            <RefreshCw className="size-3" aria-hidden />
          </button>
          {trailing}
        </div>
      </div>

      {/*
        No host banner here (2026-10-30 project-scoped rail plan): the Documents
        scope row above already says who owns the bridge and offers the fix, so a
        second copy would only repeat it — and the two could disagree. The two
        actions below stay disabled with the reason in their `title`.
      */}

      {available && view?.compatibility?.shape === "older" ? (
        <p className="border-b border-line px-3 py-1 text-[11px] text-warn">
          {view.compatibility.summary}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!available ? (
          <div className="px-3 py-2 text-[11px] text-ink-muted" data-testid="documents-unavailable">
            <p className="font-medium text-ink">{waiting.title}</p>
            <p className="mt-1">{waiting.body}</p>
            {view?.error ? <p className="mt-1 text-ink-faint">{view.error}</p> : null}
          </div>
        ) : panes.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="flex flex-col gap-2 p-2">
            {panes.map((pane) => (
              <PaneRow key={pane.paneId ?? pane.mention} pane={pane} isHost={isHost} />
            ))}
          </ul>
        )}
      </div>

      <div className="shrink-0">
        <a
          className="block px-3 py-2 text-[11px] text-accent underline"
          href={PI_FOR_OFFICE.officeOnTheWebUrl}
          onClick={(event) => {
            event.preventDefault();
            void window.pi?.openExternal(PI_FOR_OFFICE.officeOnTheWebUrl);
          }}
        >
          Open Office
        </a>
      </div>
    </div>
  );
}

/**
 * What to say when the bridge is not answering. The status is the probe's own
 * verdict (`checkBridgeHealth`), never a guess: a port owned by another program
 * needs the user to close it, while an unreachable port usually means the Office
 * host is still starting.
 */
function unavailableCopy(status: string): { title: string; body: string } {
  switch (status) {
    case "not-our-bridge":
      return {
        title: `Port ${PI_OFFICE_BRIDGE.defaultPort} is used by something else`,
        body: "Another program owns the bridge port. Close it, then re-check.",
      };
    case "invalid-response":
      return {
        title: "The bridge answered with something unexpected",
        body: "The port answered, but the reply was not the Pi Office bridge's health document.",
      };
    default:
      return {
        title: `Waiting for the bridge on port ${PI_OFFICE_BRIDGE.defaultPort}`,
        body: "The Office host is starting, or no session is running the bridge. Re-check in a few seconds.",
      };
  }
}
