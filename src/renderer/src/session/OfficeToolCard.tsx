/**
 * Office tool cards (plan step 20).
 *
 * Two things a user cannot get from the raw tool output: *which document* an
 * `office_*` call targeted (the `document` argument defaults to "active", which
 * is only meaningful against the live pane registry), and whether the call was
 * capability-gated (the bridge only exposes the ops an attached pane advertised).
 * `office_list_documents` is rendered as a real table with per-row actions
 * instead of a markdown blob.
 *
 * The pane registry comes from the renderer store (pushed by main's `/health`
 * poll), so the card reflects what is attached right now, not at call time.
 */

import type { ReactNode } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { useAppStore } from "../state/app-store";
import {
  officeCapabilityLabel,
  officeToolCapability,
  parseDocumentListTable,
  resolveToolDocument,
  shortDocumentId,
  type OfficeDocumentPane,
} from "../../../shared/office-documents";
import { mentionForRow } from "./office-tool-card";
import type { TranscriptToolRun } from "./session-events";

const EMPTY_PANES: readonly OfficeDocumentPane[] = [];

/** The target-document chip and the capability-gating note. */
function OfficeTargetLine({ tool }: { tool: TranscriptToolRun }) {
  const panes = useAppStore((state) => state.officeDocuments?.panes ?? EMPTY_PANES);
  if (!tool.toolName || tool.toolName === "office_list_documents") return null;

  const target = resolveToolDocument(tool.toolName, tool.args, panes);
  const note = officeCapabilityLabel(officeToolCapability(tool.toolName, panes));
  if (!target && !note) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
      {target ? (
        <span data-testid="office-tool-target">
          target: <span className="text-ink">{target.label}</span>
          {target.explicit ? null : " (active)"}
        </span>
      ) : null}
      {note ? (
        <Badge tone="warn" data-testid="office-capability-note">
          {note}
        </Badge>
      ) : null}
    </div>
  );
}

/** A per-row action that inserts a `#mention` into the active composer draft. */
function insertMention(mention: string): void {
  const state = useAppStore.getState();
  const tabId = state.activeTabId;
  if (!tabId) return;
  const draft = state.prefs.drafts[tabId] ?? "";
  const value = `#${mention}`;
  if (draft.includes(value)) return;
  state.setDraft(
    tabId,
    draft.length > 0 && !draft.endsWith(" ") ? `${draft} ${value} ` : `${draft}${value} `,
  );
}

function DocumentListRow({
  row,
}: {
  row: { document: string; id: string; host: string; focused: boolean; windows: number };
}) {
  const panes = useAppStore((state) => state.officeDocuments?.panes ?? EMPTY_PANES);
  const chatAboutDocument = useAppStore((state) => state.chatAboutDocument);
  const pane =
    panes.find(
      (entry) =>
        entry.documentId?.toLowerCase() === row.id.toLowerCase() ||
        entry.targetId?.toLowerCase() === row.id.toLowerCase(),
    ) ?? null;
  const mention = mentionForRow(row, panes);

  return (
    <tr className="border-t border-line" data-testid={`office-document-row-${row.id}`}>
      <td className="px-2 py-1">{row.document}</td>
      <td className="px-2 py-1 font-mono text-[11px] text-ink-faint" title={row.id}>
        {shortDocumentId(row.id)}
      </td>
      <td className="px-2 py-1">{row.host}</td>
      <td className="px-2 py-1">{row.focused ? "yes" : "no"}</td>
      <td className="px-2 py-1">
        <div className="flex flex-wrap items-center gap-2">
          {pane ? (
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Chat about ${row.document}`}
              onClick={() => chatAboutDocument(pane)}
            >
              Chat
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Insert mention for ${row.document}`}
            onClick={() => insertMention(mention)}
          >
            #{mention}
          </Button>
        </div>
      </td>
    </tr>
  );
}

/** `office_list_documents` as a table; falls back to raw text when unparseable. */
function OfficeDocumentList({ tool, fallback }: { tool: TranscriptToolRun; fallback: ReactNode }) {
  const rows = parseDocumentListTable(tool.resultText ?? tool.partial ?? "");
  if (rows.length === 0) return <>{fallback}</>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[11px]" data-testid="office-document-table">
        <thead className="text-ink-faint">
          <tr>
            <th className="px-2 py-1 font-medium">document</th>
            <th className="px-2 py-1 font-medium">id</th>
            <th className="px-2 py-1 font-medium">host</th>
            <th className="px-2 py-1 font-medium">focused</th>
            <th className="px-2 py-1 font-medium">actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <DocumentListRow key={`${row.host}:${row.id}`} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The body of an office tool card. A plain `office_*` call keeps the app's
 * output rendering and gains the target/capability line above it; the document
 * list is rendered as a table.
 */
export function OfficeToolCard({
  tool,
  fallback,
}: {
  tool: TranscriptToolRun;
  fallback: ReactNode;
}) {
  if (tool.toolName === "office_list_documents") {
    return <OfficeDocumentList tool={tool} fallback={fallback} />;
  }
  return (
    <div className="flex flex-col gap-2">
      <OfficeTargetLine tool={tool} />
      {fallback}
    </div>
  );
}
