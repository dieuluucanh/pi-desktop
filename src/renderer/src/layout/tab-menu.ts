/**
 * The tab lifecycle menu, as data.
 *
 * The right-click context menu (both strips) and the sidebar's “…” dropdown
 * render this exact list. Close All/Close Others are kind-scoped: a session menu
 * never reaches the editor strip, and an editor menu never closes a session.
 */

import type { TabKind } from "../../../shared/session-ipc";

export type TabMenuActionId =
  | "rename"
  | "duplicate"
  | "tree"
  | "fork"
  | "clone"
  | "export"
  | "reveal"
  | "save"
  | "copy-absolute-path"
  | "copy-relative-path"
  | "close"
  | "close-others"
  | "close-all"
  | "pin"
  | "unpin"
  // Web tabs.
  | "reload"
  | "copy-url"
  | "open-browser";

export interface TabMenuAction {
  id: TabMenuActionId;
  label: string;
  destructive?: boolean;
  /** Render a separator above this item. */
  separated?: boolean;
}

function closeAllLabel(kind: TabKind): string {
  switch (kind) {
    case "editor":
      return "Close all editor tabs";
    case "web":
      return "Close all web tabs";
    case "office":
      return "Close all Office tabs";
    default:
      return "Close all sessions";
  }
}

export function tabMenuItems(kind: TabKind = "session", pinned = false): readonly TabMenuAction[] {
  const pinItem: TabMenuAction = pinned
    ? { id: "unpin", label: "Unpin", separated: true }
    : { id: "pin", label: "Pin", separated: true };

  if (kind === "editor") {
    return [
      { id: "save", label: "Save" },
      { id: "copy-absolute-path", label: "Copy Path" },
      { id: "copy-relative-path", label: "Copy Relative Path" },
      { id: "reveal", label: "Reveal in File Explorer", separated: true },
      pinItem,
      { id: "close", label: "Close", separated: true },
      { id: "close-others", label: "Close others", destructive: true },
      { id: "close-all", label: closeAllLabel(kind), destructive: true },
    ];
  }

  if (kind === "web") {
    return [
      { id: "reload", label: "Reload" },
      { id: "copy-url", label: "Copy URL" },
      { id: "open-browser", label: "Open in browser" },
      pinItem,
      { id: "close", label: "Close", separated: true },
      { id: "close-others", label: "Close others", destructive: true },
      { id: "close-all", label: closeAllLabel(kind), destructive: true },
    ];
  }

  return [
    { id: "rename", label: "Rename…" },
    { id: "duplicate", label: "Duplicate in this project" },
    { id: "tree", label: "Browse history tree…", separated: true },
    { id: "fork", label: "Fork from a message…" },
    { id: "clone", label: "Clone session" },
    { id: "export", label: "Export to HTML" },
    { id: "reveal", label: "Reveal session file" },
    pinItem,
    { id: "close", label: "Close", separated: true },
    { id: "close-others", label: "Close others", destructive: true },
    { id: "close-all", label: closeAllLabel(kind), destructive: true },
  ];
}
