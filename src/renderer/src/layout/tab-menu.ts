/**
 * The session tab's lifecycle menu, as data (plan step 11).
 *
 * Kept out of `TabStrip.tsx` so the set of lifecycle actions is a pure contract
 * that can be asserted without opening a Radix menu in jsdom — and so the
 * component module exports only components (react-refresh).
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
  | "copy-path"
  | "close"
  | "close-others"
  // Web tabs (plan step 21).
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

export function tabMenuItems(kind: TabKind = "session"): readonly TabMenuAction[] {
  if (kind === "editor") {
    return [
      { id: "save", label: "Save" },
      { id: "copy-path", label: "Copy path" },
      { id: "reveal", label: "Reveal in File Explorer", separated: true },
      { id: "close", label: "Close", separated: true },
      { id: "close-others", label: "Close others", destructive: true },
    ];
  }
  if (kind === "web") {
    // A web tab has no Pi session, so the lifecycle actions do not apply; the
    // chrome commands and closing are what remain.
    return [
      { id: "reload", label: "Reload" },
      { id: "copy-url", label: "Copy URL" },
      { id: "open-browser", label: "Open in browser" },
      { id: "close", label: "Close", separated: true },
      { id: "close-others", label: "Close others", destructive: true },
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
    { id: "close", label: "Close", separated: true },
    { id: "close-others", label: "Close others", destructive: true },
  ];
}
