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

export interface DragTypes {
  types: readonly string[] | DOMStringList;
}

export interface DragReader {
  getData(type: string): string;
}

export interface DragWriter {
  setData(type: string, data: string): void;
  effectAllowed?: string;
}

function hasType(types: DragTypes["types"], wanted: string): boolean {
  return Array.from(types).includes(wanted);
}

/** True when a drag carries the Explorer's typed workspace payload. */
export function isWorkspaceDrag(dataTransfer: DragTypes): boolean {
  return hasType(dataTransfer.types, WORKSPACE_PATH_DRAG_MIME);
}

/** True for an external OS file drag (the browser sets the `Files` type). */
export function isExternalFileDrag(dataTransfer: DragTypes): boolean {
  return hasType(dataTransfer.types, "Files");
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
