/**
 * Pure view helpers for the Explorer tree.
 *
 * The tree is stored as per-directory slices. Rendering it recursively made every
 * row subscribe to the whole tree and hid the filter logic inside JSX. This
 * module flattens the loaded slices into the rows the rail actually paints, so
 * hidden/ignored filtering and expansion are unit-testable without a DOM.
 */

import type { WorkspaceEntry } from "../../../shared/workspace";

/** The minimum tree shape the view needs (structural, so tests can build it). */
export interface ExplorerTreeView {
  children: Record<string, WorkspaceEntry[]>;
  expanded: Record<string, true>;
}

export interface ExplorerRowModel {
  entry: WorkspaceEntry;
  /** 0 for a root entry. */
  depth: number;
  expanded: boolean;
}

export interface ExplorerRowOptions {
  showHidden: boolean;
  showIgnored: boolean;
}

/**
 * Flattens the loaded tree in display order. A directory is included even when
 * its children have not been fetched; its `expanded` flag still describes the
 * chevron. Children are walked only when the directory is expanded.
 */
export function flattenExplorerRows(
  tree: ExplorerTreeView | null | undefined,
  options: ExplorerRowOptions,
): ExplorerRowModel[] {
  if (!tree) return [];
  const rows: ExplorerRowModel[] = [];
  const seen = new Set<string>();

  const visit = (path: string, depth: number): void => {
    for (const entry of tree.children[path] ?? []) {
      if (entry.hidden && !options.showHidden) continue;
      if (entry.ignored && !options.showIgnored) continue;
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      const expanded = entry.kind === "directory" && tree.expanded[entry.path] === true;
      rows.push({ entry, depth, expanded });
      if (expanded) visit(entry.path, depth + 1);
    }
  };

  visit("", 0);
  return rows;
}

/** True when the root slice exists and has no rows at all. */
export function isExplorerTreeEmpty(tree: ExplorerTreeView | null | undefined): boolean {
  return (tree?.children[""] ?? []).length === 0;
}
