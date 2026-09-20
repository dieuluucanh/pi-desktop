/**
 * Pure helpers for the office tool card (plan step 20).
 *
 * Kept out of `OfficeToolCard.tsx` so that file exports only components (React
 * Fast Refresh) and these decisions stay unit-testable without a DOM.
 */

import {
  officeToolTarget,
  resolveToolDocument,
  type OfficeDocumentPane,
} from "../../../shared/office-documents";
import type { TranscriptToolRun } from "./session-events";

/** True for `office_list_documents` and every `office_<host>_<op>` tool. */
export function isOfficeTool(toolName: string | undefined): boolean {
  if (!toolName) return false;
  return toolName === "office_list_documents" || officeToolTarget(toolName) !== null;
}

/** The card header's one-line summary: the target document, when there is one. */
export function officeToolSummary(
  tool: TranscriptToolRun,
  panes: readonly OfficeDocumentPane[],
): string | null {
  if (!tool.toolName || !isOfficeTool(tool.toolName)) return null;
  if (tool.toolName === "office_list_documents") return null;
  const target = resolveToolDocument(tool.toolName, tool.args, panes);
  if (!target) return null;
  return target.explicit ? `→ ${target.label}` : "→ active document";
}

/** The `#mention` text a per-row insert action writes into the composer. */
export function mentionForRow(row: { id: string }, panes: readonly OfficeDocumentPane[]): string {
  const pane = panes.find(
    (entry) =>
      entry.documentId?.toLowerCase() === row.id.toLowerCase() ||
      entry.targetId?.toLowerCase() === row.id.toLowerCase(),
  );
  return pane?.mention ?? row.id;
}
