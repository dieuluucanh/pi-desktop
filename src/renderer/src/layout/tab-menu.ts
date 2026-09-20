/**
 * The session tab's lifecycle menu, as data (plan step 11).
 *
 * Kept out of `TabStrip.tsx` so the set of lifecycle actions is a pure contract
 * that can be asserted without opening a Radix menu in jsdom — and so the
 * component module exports only components (react-refresh).
 */

export type TabMenuActionId =
  | "rename"
  | "duplicate"
  | "tree"
  | "fork"
  | "clone"
  | "export"
  | "reveal"
  | "close"
  | "close-others";

export interface TabMenuAction {
  id: TabMenuActionId;
  label: string;
  destructive?: boolean;
  /** Render a separator above this item. */
  separated?: boolean;
}

export function tabMenuItems(): readonly TabMenuAction[] {
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
