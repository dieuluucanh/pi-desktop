/**
 * The tab drag payload.
 *
 * A tab can be dragged out of the session strip, the editor strip or the sidebar
 * and dropped on a grid pane. The drag travels through Chromium's `DataTransfer`,
 * so the contract is a string: this module owns that string, mirroring
 * `shared/workspace-drag.ts`.
 *
 * It is a **separate MIME** from the workspace-file drag on purpose, and a tab
 * drag writes no plain-text copy. Requiring `application/x-pi-tab` is what keeps
 * "drop to add a mention" and "drop to fill a pane" from ever competing for the
 * same gesture; a tab id must not be insertable as text into a composer or editor.
 *
 * Pure and DOM-free, so the renderer, the tests and any future main-process
 * consumer share one parser; the `DataTransfer` wrapper lives beside the strips.
 */

/** Custom MIME set by tab drags. Kept lowercase: browsers normalise it. */
export const TAB_DRAG_MIME = "application/x-pi-tab";

export const TAB_DRAG_VERSION = 1 as const;

/**
 * The longest tab id a payload may carry. Matches the pane-slot bound in
 * `shared/session-grid.ts`: a drag is external input, and an id that could never
 * be a pane slot is not worth parsing any further.
 */
export const MAX_TAB_DRAG_ID = 128;

export interface TabDragPayload {
  version: typeof TAB_DRAG_VERSION;
  tabId: string;
}

/** Serialises a drag payload for `DataTransfer.setData`. */
export function serializeTabDrag(payload: TabDragPayload): string {
  return JSON.stringify(payload);
}

/**
 * Parses an untrusted drag payload. Returns null for anything malformed: a drag
 * is external input, so this never throws and never repairs a bad id.
 */
export function parseTabDrag(raw: string | null | undefined): TabDragPayload | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== TAB_DRAG_VERSION) return null;
  const tabId = record.tabId;
  if (typeof tabId !== "string") return null;
  const trimmed = tabId.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TAB_DRAG_ID) return null;
  return { version: TAB_DRAG_VERSION, tabId: trimmed };
}
