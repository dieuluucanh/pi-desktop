/**
 * The browser `DataTransfer` shape, as a structural type.
 *
 * Every in-app drag (a workspace file, a tab) needs three things from a transfer:
 * the type list, a reader and a writer. Typing them structurally instead of as
 * `DataTransfer` keeps the drag helpers testable in jsdom, where `DataTransfer`
 * is not constructible — the tests pass a plain object with the same members.
 */

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

/** True when the transfer advertises a MIME type, in both string and list form. */
export function hasDragType(types: DragTypes["types"], wanted: string): boolean {
  return Array.from(types).includes(wanted);
}
