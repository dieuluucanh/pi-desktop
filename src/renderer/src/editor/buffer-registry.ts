/**
 * The editor's document buffers.
 *
 * CodeMirror owns the live state; this registry keeps the last text and the
 * on-disk baseline for save/backup/conflict handling. It lives outside zustand
 * on purpose: a keystroke must not re-render the tab strip or the explorer.
 */

import type { FileEol } from "../../../shared/workspace";

export interface EditorBuffer {
  tabId: string;
  projectPath: string;
  path: string;
  text: string;
  baselineMtimeMs: number | null;
  eol: FileEol;
  bom: boolean;
  readOnly: boolean;
}

const buffers = new Map<string, EditorBuffer>();

export function putBuffer(buffer: EditorBuffer): void {
  buffers.set(buffer.tabId, buffer);
}

export function getBuffer(tabId: string): EditorBuffer | undefined {
  return buffers.get(tabId);
}

export function setBufferText(tabId: string, text: string): void {
  const buffer = buffers.get(tabId);
  if (buffer) buffer.text = text;
}

export function updateBufferBaseline(tabId: string, mtimeMs: number | null): void {
  const buffer = buffers.get(tabId);
  if (buffer) buffer.baselineMtimeMs = mtimeMs;
}

export function removeBuffer(tabId: string): void {
  buffers.delete(tabId);
}

export function clearBuffersExcept(tabIds: ReadonlySet<string>): void {
  for (const tabId of [...buffers.keys()]) {
    if (!tabIds.has(tabId)) buffers.delete(tabId);
  }
}
