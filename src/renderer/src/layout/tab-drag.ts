/**
 * Renderer-side tab drag helpers.
 *
 * `src/shared/tab-drag.ts` owns the payload format; this wrapper owns the browser
 * `DataTransfer` shape so a strip, a sidebar row and a pane never read a raw MIME
 * string. The functions take structural arguments (see `ui/drag-transfer.ts`)
 * instead of a concrete `DataTransfer`, which keeps them testable in jsdom.
 *
 * A tab drag carries **both** the typed payload and `text/plain`, exactly like a
 * workspace-file drag: the plain form keeps the gesture legible to anything that
 * only understands text, while every in-app drop target insists on the typed
 * MIME so a file path can never fill a pane.
 */

import {
  TAB_DRAG_MIME,
  TAB_DRAG_VERSION,
  parseTabDrag,
  serializeTabDrag,
  type TabDragPayload,
} from "../../../shared/tab-drag";
import { hasDragType, type DragReader, type DragTypes, type DragWriter } from "../ui/drag-transfer";

/** True when a drag carries the strip's typed tab payload. */
export function isTabDrag(dataTransfer: DragTypes): boolean {
  return hasDragType(dataTransfer.types, TAB_DRAG_MIME);
}

/** Reads and validates a tab drag; never falls back to `text/plain`. */
export function readTabDrop(dataTransfer: DragReader): TabDragPayload | null {
  return parseTabDrag(dataTransfer.getData(TAB_DRAG_MIME));
}

/** Writes the typed payload plus a plain tab-id fallback, marked as a move. */
export function writeTabDrag(dataTransfer: DragWriter | null | undefined, tabId: string): void {
  // A synthetic drag (jsdom, or a keyboard-initiated one) may carry no transfer.
  // The strip's own reorder works from its state, so this is a no-op there.
  if (!dataTransfer || tabId.length === 0) return;
  dataTransfer.setData(TAB_DRAG_MIME, serializeTabDrag({ version: TAB_DRAG_VERSION, tabId }));
  dataTransfer.setData("text/plain", tabId);
  dataTransfer.effectAllowed = "move";
}
