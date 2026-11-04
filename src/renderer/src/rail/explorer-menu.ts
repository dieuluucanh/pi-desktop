/**
 * The explorer context menu as data.
 *
 * Keeping the item order and disabled states pure lets the component tests pin
 * the UX without opening a Radix portal, and lets the row/search/root menus
 * share one contract.
 */

import type { WorkspaceEntryKind } from "../../../shared/workspace";
import type { FileClipboardMode } from "../files/file-clipboard-store";

export type ExplorerMenuActionId =
  | "open"
  | "new-file"
  | "new-folder"
  | "add-to-chat"
  | "copy"
  | "cut"
  | "paste"
  | "rename"
  | "delete"
  | "reveal"
  | "copy-path"
  | "copy-relative-path"
  | "refresh";

export interface ExplorerMenuTarget {
  kind: WorkspaceEntryKind;
  path: string;
  name: string;
  outside: boolean;
}

export interface ExplorerMenuState {
  clipboard: { mode: FileClipboardMode } | null;
}

export interface ExplorerMenuItem {
  id: ExplorerMenuActionId;
  label: string;
  destructive?: boolean;
  /** Render a separator above this item. */
  separated?: boolean;
  disabled?: boolean;
}

const PASTE = (state: ExplorerMenuState, disabled = false): ExplorerMenuItem => ({
  id: "paste",
  label: "Paste",
  separated: true,
  ...(disabled || state.clipboard === null ? { disabled: true } : {}),
});

const COPY_ITEMS = (target: ExplorerMenuTarget): ExplorerMenuItem[] => [
  { id: "copy", label: "Copy", disabled: target.outside },
  { id: "cut", label: "Cut", disabled: target.outside },
];

const PATH_ITEMS: ExplorerMenuItem[] = [
  { id: "copy-path", label: "Copy Path", separated: true },
  { id: "copy-relative-path", label: "Copy Relative Path" },
];

const COMMON_TAIL = (): ExplorerMenuItem[] => [
  { id: "rename", label: "Rename…", separated: true },
  { id: "delete", label: "Delete", destructive: true },
  { id: "reveal", label: "Reveal in File Explorer", separated: true },
  ...PATH_ITEMS,
];

/** The menu for a file/folder row. `null` is the tree's blank/root area. */
export function explorerMenuItems(
  target: ExplorerMenuTarget | null,
  state: ExplorerMenuState,
): readonly ExplorerMenuItem[] {
  if (target === null) {
    return [
      { id: "new-file", label: "New File…" },
      { id: "new-folder", label: "New Folder…" },
      PASTE(state),
      { id: "refresh", label: "Refresh", separated: true },
    ];
  }

  if (target.kind === "directory") {
    return [
      { id: "new-file", label: "New File…" },
      { id: "new-folder", label: "New Folder…" },
      {
        id: "add-to-chat",
        label: "Add Folder to Chat",
        separated: true,
        ...(target.outside ? { disabled: true } : {}),
      },
      ...COPY_ITEMS(target),
      PASTE(state, target.outside),
      ...COMMON_TAIL(),
    ];
  }

  return [
    { id: "open", label: "Open", ...(target.outside ? { disabled: true } : {}) },
    {
      id: "add-to-chat",
      label: "Add to Chat",
      ...(target.outside ? { disabled: true } : {}),
    },
    ...COPY_ITEMS(target),
    PASTE(state, target.outside),
    ...COMMON_TAIL(),
  ];
}
