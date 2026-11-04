/**
 * Renderer-side drag helpers.
 *
 * The shared module owns the payload format; this wrapper owns the browser
 * `DataTransfer` shape so components never read a raw MIME string. The functions
 * take structural arguments instead of a concrete `DataTransfer`, which keeps
 * them testable in jsdom (where `DataTransfer` is not constructible).
 */

import {
  WORKSPACE_PATH_DRAG_MIME,
  parseWorkspaceDrag,
  serializeWorkspaceDrag,
  type WorkspaceDragPayload,
} from "../../../shared/workspace-drag";
import { hasDragType, type DragReader, type DragTypes, type DragWriter } from "../ui/drag-transfer";

// The transfer shape (and its `hasDragType` helper) is shared with the tab drag
// helpers in `layout/tab-drag.ts`; re-exported so callers of this module keep
// one import.
export type { DragReader, DragTypes, DragWriter };

/** True when a drag carries the Explorer's typed workspace payload. */
export function isWorkspaceDrag(dataTransfer: DragTypes): boolean {
  return hasDragType(dataTransfer.types, WORKSPACE_PATH_DRAG_MIME);
}

/** True for an external OS file drag (the browser sets the `Files` type). */
export function isExternalFileDrag(dataTransfer: DragTypes): boolean {
  return hasDragType(dataTransfer.types, "Files");
}

/** Reads and validates a workspace drag; never falls back to `text/plain`. */
export function readWorkspaceDrop(dataTransfer: DragReader): WorkspaceDragPayload | null {
  return parseWorkspaceDrag(dataTransfer.getData(WORKSPACE_PATH_DRAG_MIME));
}

/** Writes both the typed payload and a plain-path fallback for other consumers. */
export function writeWorkspaceDrag(dataTransfer: DragWriter, payload: WorkspaceDragPayload): void {
  dataTransfer.setData(WORKSPACE_PATH_DRAG_MIME, serializeWorkspaceDrag(payload));
  dataTransfer.setData("text/plain", payload.path);
  dataTransfer.effectAllowed = "copy";
}
