/**
 * Documents panel (plan step 20).
 *
 * The right rail that makes the Office integration visible from a session: every
 * task pane the bridge has attached, with the facts a user needs to target it —
 * host app, name, id, focus, window count, advertised ops and last-seen age —
 * and the actions that turn a document into a prompt.
 *
 * It renders nothing until the bridge answers `/health` (plan D-A10: no Office
 * surface when Office was never set up), and an empty state that says exactly
 * what to open when the bridge is up but no document is attached.
 */

import { useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { useAppStore } from "../state/app-store";
import {
  formatPaneAge,
  shortDocumentId,
  type OfficeDocumentPane,
} from "../../../shared/office-documents";
import { PI_FOR_OFFICE } from "../../../shared/office";

/** A tiny copy-to-clipboard button that confirms itself, like the transcript's. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="text-[11px] text-ink-faint hover:text-ink"
      onClick={() => {
        const clipboard = navigator.clipboard;
        if (!clipboard) return;
        void clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1_500);
        });
      }}
    >
      {copied ? "copied" : label}
    </button>
  );
}

function PaneRow({ pane }: { pane: OfficeDocumentPane }) {
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
          onClick={() => chatAboutDocument(pane)}
        >
          Chat about this
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Insert document mention"
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

/** Who owns the bridge port, and how to move it (plan step 20 session management). */
function OfficeHostFooter() {
  const tabs = useAppStore((state) => state.tabs);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const promote = useAppStore((state) => state.promoteToOfficeHost);

  const officeTab = tabs.find((tab) => tab.kind === "office") ?? null;
  if (officeTab) {
    return (
      <p className="border-t border-line px-3 py-2 text-[11px] text-ink-faint">
        Office host: <span className="text-ink-muted">{officeTab.title}</span> · port 38617
      </p>
    );
  }
  const active = tabs.find((tab) => tab.id === activeTabId) ?? null;
  if (!active) return null;
  return (
    <div className="border-t border-line px-3 py-2 text-[11px] text-ink-faint">
      <p>No session owns the Office host port.</p>
      <Button
        size="sm"
        variant="secondary"
        className="mt-1"
        onClick={() => void promote(active.id)}
        aria-label="Promote to Office host"
      >
        Promote to Office host
      </Button>
    </div>
  );
}

export function DocumentsPanel() {
  const view = useAppStore((state) => state.officeDocuments);
  const open = useAppStore((state) => state.documentsPanelOpen);
  const toggle = useAppStore((state) => state.toggleDocumentsPanel);
  const refresh = useAppStore((state) => state.refreshOfficeDocuments);

  // Visible only when the bridge responds (plan step 20) and the rail is open.
  if (!view?.available || !open) return null;

  return (
    <aside
      className="flex w-72 shrink-0 flex-col border-l border-line bg-surface"
      aria-label="Attached documents"
      data-testid="documents-panel"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <h2 className="text-xs font-semibold">Documents</h2>
        <Badge tone="neutral">{view.panes.length}</Badge>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="text-ink-faint hover:text-ink"
            aria-label="Refresh documents"
            onClick={() => void refresh()}
          >
            <RefreshCw className="size-3" aria-hidden />
          </button>
          <button
            type="button"
            className="text-ink-faint hover:text-ink"
            aria-label="Close documents panel"
            onClick={toggle}
          >
            <X className="size-3" aria-hidden />
          </button>
        </div>
      </header>

      {view.compatibility && view.compatibility.shape === "older" ? (
        <p className="border-b border-line px-3 py-1 text-[11px] text-warn">
          {view.compatibility.summary}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {view.panes.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="flex flex-col gap-2 p-2">
            {view.panes.map((pane) => (
              <PaneRow key={pane.paneId ?? pane.mention} pane={pane} />
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
        <OfficeHostFooter />
      </div>
    </aside>
  );
}
