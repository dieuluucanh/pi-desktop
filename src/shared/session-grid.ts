/**
 * The session view grid's pure model.
 *
 * The grid shows several tabs of the same window at once. This module owns
 * everything about it that is not React: the preset shapes, the pane
 * assignments, the solo/grid decision and the sanitizer behind the persisted
 * `prefs.grid` block.
 *
 * Three rules it exists to hold:
 *
 *  - **A layout is a preset, not a free-form split.** `single`, `two`,
 *    `three-left`, `three-right` and `four` are the only shapes; the CSS area
 *    each pane occupies is data here, so the component never re-derives it and
 *    the geometry is unit tested without a DOM.
 *  - **One pane per tab.** A tab assigned to pane B while it is already shown in
 *    pane A **swaps** the two slots. There is one CodeMirror view per tab id and
 *    one native view per web tab, so the same tab in two panes would be
 *    ambiguous.
 *  - **A stored pane id may be stale.** Closing a tab leaves its slot empty;
 *    `applyTabs` prunes the id, and every reader here tolerates `null`.
 *
 * Nothing here touches React, Electron or the filesystem: the node test project
 * covers it, and `prefs.grid` (which main also sanitizes) imports the same
 * functions.
 */

/** The five preset shapes the window content area can take. */
export type GridLayout = "single" | "two" | "three-left" | "three-right" | "four";

/** Canonical order, used by the layout menu and by the sanitizer. */
export const GRID_LAYOUTS: readonly GridLayout[] = [
  "single",
  "two",
  "three-left",
  "three-right",
  "four",
] as const;

/** The words the layout menu shows for each preset. */
export const GRID_LAYOUT_LABELS: Record<GridLayout, string> = {
  single: "Single tab",
  two: "Two columns",
  "three-left": "Three panes (left tall)",
  "three-right": "Three panes (right tall)",
  four: "Four panes",
};

/**
 * Panes a layout shows. `three-left` and `three-right` both show three panes;
 * they differ only in which column is full height.
 */
export const GRID_PANE_COUNT: Record<GridLayout, 1 | 2 | 3 | 4> = {
  single: 1,
  two: 2,
  "three-left": 3,
  "three-right": 3,
  four: 4,
};

/** The largest pane count any preset has; bounds every stored array. */
export const MAX_GRID_PANES = 4;

/** Longest tab id accepted in a stored pane slot. */
const MAX_GRID_TAB_ID = 128;

/** Which panes are on screen and which tab each holds (persisted as `prefs.grid`). */
export interface GridPrefs {
  layout: GridLayout;
  /** Pane slots, indexed by pane. Padded with `null`; never longer than the layout. */
  panes: (string | null)[];
}

/**
 * A single pane showing the active tab, which is also today's single-tab view.
 *
 * `panes` already has the layout's one slot (empty), so `sanitizeGridPrefs` of a
 * default document returns exactly this value — a sanitizer that disagreed with
 * its own default would rewrite `app-state.json` on every read.
 */
export const DEFAULT_GRID_PREFS: GridPrefs = { layout: "single", panes: [null] };

/**
 * A fresh default, for writers.
 *
 * {@link DEFAULT_GRID_PREFS} is shared so equality checks are cheap; handing its
 * `panes` array to a mutation site would edit every future default.
 */
export function defaultGridPrefs(): GridPrefs {
  return { layout: DEFAULT_GRID_PREFS.layout, panes: [...DEFAULT_GRID_PREFS.panes] };
}

/** True for a value the rest of the app may treat as a layout. */
export function isGridLayout(value: unknown): value is GridLayout {
  return typeof value === "string" && (GRID_LAYOUTS as readonly string[]).includes(value);
}

/** Panes the layout shows (a total function, so callers never branch on the union). */
export function gridPaneCount(layout: GridLayout): number {
  return GRID_PANE_COUNT[layout];
}

/**
 * Tailwind classes placing pane `index` in the two-column grid.
 *
 * The grid container is always `grid-cols-2`; a preset chooses the row count and
 * which pane spans both rows. Keeping this as data means the CSS, the tests and
 * the drop targets cannot disagree about which slot a pane index address.
 */
export function paneAreaClass(layout: GridLayout, index: number): string {
  const count = gridPaneCount(layout);
  if (index < 0 || index >= count) return "hidden";
  switch (layout) {
    case "single":
      // One pane, one row: spanning the second row would create an implicit row
      // and halve the pane's height.
      return "col-span-2";
    case "two":
      return "row-span-2";
    case "three-left":
      // Column 1 is one tall pane; column 2 stacks two panes.
      return index === 0 ? "row-span-2" : "";
    case "three-right":
      return index === 0 ? "" : index === 1 ? "row-span-2" : "";
    case "four":
      return "";
    default:
      return "hidden";
  }
}

/** Rows the layout's grid container declares. */
export function gridRowCount(layout: GridLayout): number {
  return layout === "four" || layout === "two" ? 2 : layout === "single" ? 1 : 2;
}

function gridTabIdOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (id.length === 0 || id.length > MAX_GRID_TAB_ID) return null;
  return id;
}

/**
 * Coerces `panes` into exactly `gridPaneCount(layout)` slots.
 *
 * Padding with `null` is what lets a preset change be non-destructive: shrinking
 * to two panes and growing back to four keeps the assignments a caller did not
 * displace. Duplicates are dropped (keeping the first) because a tab may only be
 * visible once, and a malformed entry becomes an empty slot rather than moving
 * its neighbours.
 */
export function normalizeGridPanes(
  layout: GridLayout,
  panes: readonly unknown[] | null | undefined,
): (string | null)[] {
  const count = gridPaneCount(layout);
  const source = Array.isArray(panes) ? panes : [];
  const seen = new Set<string>();
  const out: (string | null)[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = gridTabIdOf(source[index]);
    if (id === null || seen.has(id)) {
      out.push(null);
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Coerces an untrusted value (a stored prefs block) into a valid {@link GridPrefs}. */
export function sanitizeGridPrefs(value: unknown): GridPrefs {
  const source =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const layout = isGridLayout(source.layout) ? source.layout : DEFAULT_GRID_PREFS.layout;
  return { layout, panes: normalizeGridPanes(layout, source.panes as readonly unknown[] | null) };
}

/**
 * Merges a partial `grid` patch over the current value.
 *
 * `panes` is a list, so a patch replaces it wholesale and is then normalized
 * against the merged layout — merging element-wise would duplicate entries the
 * moment two documents disagree (the same rule `mergeRailPrefs` applies to
 * `order`).
 */
export function mergeGridPrefs(current: GridPrefs, patch: unknown): GridPrefs {
  const source =
    patch && typeof patch === "object" && !Array.isArray(patch)
      ? (patch as Record<string, unknown>)
      : {};
  const layout = isGridLayout(source.layout) ? source.layout : current.layout;
  const panes = "panes" in source ? (source.panes as readonly unknown[] | null) : current.panes;
  return { layout, panes: normalizeGridPanes(layout, panes) };
}

/**
 * The one assignment rule: set, clear or **swap**.
 *
 * Assigning a tab that another pane already shows swaps the two slots, so the
 * tab stays visible exactly once and the pane the user dropped on wins. An
 * unchanged assignment returns an equivalent (but new) object, which callers
 * compare before writing prefs.
 */
export function assignGridPane(
  prefs: GridPrefs,
  paneIndex: number,
  tabId: string | null,
): GridPrefs {
  const panes = normalizeGridPanes(prefs.layout, prefs.panes);
  if (paneIndex < 0 || paneIndex >= panes.length) return { ...prefs, panes };

  const next = [...panes];
  const incoming = gridTabIdOf(tabId);
  if (incoming === null) {
    next[paneIndex] = null;
    return { layout: prefs.layout, panes: next };
  }

  const occupiedAt = next.indexOf(incoming);
  if (occupiedAt >= 0 && occupiedAt !== paneIndex) {
    // Swap: the tab the user displaced takes the incoming tab's old pane.
    const displaced = next[paneIndex] ?? null;
    next[paneIndex] = incoming;
    next[occupiedAt] = displaced;
    return { layout: prefs.layout, panes: next };
  }

  next[paneIndex] = incoming;
  return { layout: prefs.layout, panes: next };
}

/** The pane holding one tab, or -1. */
export function paneIndexOfTab(prefs: GridPrefs, tabId: string | null): number {
  if (tabId === null) return -1;
  return normalizeGridPanes(prefs.layout, prefs.panes).indexOf(tabId);
}

/** The first empty slot, or null when every pane is taken. */
export function firstEmptyPane(prefs: GridPrefs): number | null {
  const panes = normalizeGridPanes(prefs.layout, prefs.panes);
  const index = panes.indexOf(null);
  return index === -1 ? null : index;
}

/** Everything the solo/grid decision needs, taken from the store. */
export interface GridViewInput {
  layout: GridLayout;
  panes: readonly (string | null)[];
  /** True when the user last activated a tab that no pane holds. */
  solo: boolean;
  activeTabId: string | null;
}

/**
 * Which surface the content area shows.
 *
 * `single` is inherently solo (one pane already fills the area), a tab that no
 * pane holds is shown full-size, and with no active tab there is nothing to
 * arrange — so all three are `solo`. Anything else is the grid.
 */
export function gridMode(input: GridViewInput): "solo" | "grid" {
  if (input.layout === "single") return "solo";
  if (input.solo) return "solo";
  if (input.activeTabId === null) return "solo";
  return "grid";
}

/**
 * The tabs a mounted surface shows — the input the retention bound and the
 * host-pinning push both need.
 *
 * The active tab is always included: in solo it *is* the surface, and in the
 * grid it is the focused pane (whose transcript and TUI state must stay warm
 * even while another pane is being pointed at).
 */
export function visibleGridTabIds(input: GridViewInput): string[] {
  if (gridMode(input) === "solo") {
    return input.activeTabId === null ? [] : [input.activeTabId];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  if (input.activeTabId !== null) {
    seen.add(input.activeTabId);
    out.push(input.activeTabId);
  }
  for (const id of normalizeGridPanes(input.layout, input.panes)) {
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
