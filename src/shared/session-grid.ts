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

/** Canonical model order. The layout menu renders it widest-first (reversed). */
export const GRID_LAYOUTS: readonly GridLayout[] = [
  "single",
  "two",
  "three-left",
  "three-right",
  "four",
] as const;

/** A preset that actually splits the content area. */
export type GridMultiLayout = Exclude<GridLayout, "single">;

/** Canonical multi-pane order, used by the drag reveal and the sanitizer. */
export const GRID_MULTI_LAYOUTS: readonly GridMultiLayout[] = [
  "two",
  "three-left",
  "three-right",
  "four",
] as const;

/** The last multi-pane layout a drag reveals when none was chosen yet. */
export const DEFAULT_MULTI_LAYOUT: GridMultiLayout = "two";

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
  /**
   * The last multi-pane preset the user chose. Selecting Single keeps it, so a
   * drag reveal or a later layout switch can restore the remembered split.
   */
  lastMultiLayout: GridMultiLayout;
  /** Pane slots, indexed by pane. Always four entries; hidden slots survive. */
  panes: (string | null)[];
}

/**
 * A single pane showing the active tab, which is also today's single-tab view.
 *
 * `panes` already has the fixed four slots, so `sanitizeGridPrefs` of a default
 * document returns exactly this value — a sanitizer that disagreed with its own
 * default would rewrite `app-state.json` on every read.
 */
export const DEFAULT_GRID_PREFS: GridPrefs = {
  layout: "single",
  lastMultiLayout: DEFAULT_MULTI_LAYOUT,
  panes: [null, null, null, null],
};

/**
 * A fresh default, for writers.
 *
 * {@link DEFAULT_GRID_PREFS} is shared so equality checks are cheap; handing its
 * `panes` array to a mutation site would edit every future default.
 */
export function defaultGridPrefs(): GridPrefs {
  return {
    layout: DEFAULT_GRID_PREFS.layout,
    lastMultiLayout: DEFAULT_GRID_PREFS.lastMultiLayout,
    panes: [...DEFAULT_GRID_PREFS.panes],
  };
}

/** True for a value the rest of the app may treat as a layout. */
export function isGridLayout(value: unknown): value is GridLayout {
  return typeof value === "string" && (GRID_LAYOUTS as readonly string[]).includes(value);
}

/** True for a preset that splits the content area. */
export function isGridMultiLayout(value: unknown): value is GridMultiLayout {
  return typeof value === "string" && (GRID_MULTI_LAYOUTS as readonly string[]).includes(value);
}

/** Panes the layout shows (a total function, so callers never branch on the union). */
export function gridPaneCount(layout: GridLayout): number {
  return GRID_PANE_COUNT[layout];
}

/** Rows the layout's grid container declares. */
export function gridRowCount(layout: GridLayout): number {
  return layout === "single" ? 1 : 2;
}

function gridTabIdOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (id.length === 0 || id.length > MAX_GRID_TAB_ID) return null;
  return id;
}

/**
 * Coerces `panes` into exactly {@link MAX_GRID_PANES} slots.
 *
 * Every layout reads only its first `gridPaneCount(layout)` slots; the extra
 * slots are remembered hidden assignments. Padding (rather than truncating to
 * the current layout) is what lets a preset change be non-destructive: shrinking
 * to Single and growing back to Four keeps the assignments a caller did not
 * displace. Duplicates are dropped (keeping the first) because a tab may only be
 * visible once, and a malformed entry becomes an empty slot rather than moving
 * its neighbours.
 */
export function normalizeGridPanes(
  panes: readonly unknown[] | null | undefined,
): (string | null)[] {
  const source = Array.isArray(panes) ? panes : [];
  const seen = new Set<string>();
  const out: (string | null)[] = [];
  for (let index = 0; index < MAX_GRID_PANES; index += 1) {
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

/**
 * The pane slots the layout actually shows.
 *
 * Stored `panes` always has four entries; a layout only renders its first
 * `gridPaneCount(layout)`. Every visible calculation goes through this helper so
 * a pane hidden by a smaller preset can never be treated as on screen.
 */
export function visiblePaneIds(
  layout: GridLayout,
  panes: readonly (string | null)[],
): (string | null)[] {
  return normalizeGridPanes(panes).slice(0, gridPaneCount(layout));
}

/** Coerces an untrusted value (a stored prefs block) into a valid {@link GridPrefs}. */
export function sanitizeGridPrefs(value: unknown): GridPrefs {
  const source =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const layout = isGridLayout(source.layout) ? source.layout : DEFAULT_GRID_PREFS.layout;
  // A multi layout is always its own last-multi layout; Single keeps the stored
  // memory (or the default when an older document has none).
  let lastMultiLayout: GridMultiLayout;
  if (layout !== "single") {
    lastMultiLayout = layout;
  } else if (isGridMultiLayout(source.lastMultiLayout)) {
    lastMultiLayout = source.lastMultiLayout;
  } else {
    lastMultiLayout = DEFAULT_MULTI_LAYOUT;
  }
  return {
    layout,
    lastMultiLayout,
    panes: normalizeGridPanes(source.panes as readonly unknown[] | null),
  };
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
  const lastMultiLayout =
    "lastMultiLayout" in source ? source.lastMultiLayout : current.lastMultiLayout;
  return sanitizeGridPrefs({ layout, lastMultiLayout, panes });
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
  const panes = normalizeGridPanes(prefs.panes);
  if (paneIndex < 0 || paneIndex >= MAX_GRID_PANES) return { ...prefs, panes };

  const next = [...panes];
  const incoming = gridTabIdOf(tabId);
  if (incoming === null) {
    next[paneIndex] = null;
    return { ...prefs, panes: next };
  }

  const occupiedAt = next.indexOf(incoming);
  if (occupiedAt >= 0 && occupiedAt !== paneIndex) {
    // Swap: the tab the user displaced takes the incoming tab's old pane. This
    // also handles a tab held in a hidden slot when the layout grows.
    const displaced = next[paneIndex] ?? null;
    next[paneIndex] = incoming;
    next[occupiedAt] = displaced;
    return { ...prefs, panes: next };
  }

  next[paneIndex] = incoming;
  return { ...prefs, panes: next };
}

/** The visible pane holding one tab, or -1. Hidden slots are not panes. */
export function paneIndexOfTab(prefs: GridPrefs, tabId: string | null): number {
  if (tabId === null) return -1;
  return visiblePaneIds(prefs.layout, prefs.panes).indexOf(tabId);
}

/** The first empty visible slot, or null when every visible pane is taken. */
export function firstEmptyPane(prefs: GridPrefs): number | null {
  const panes = visiblePaneIds(prefs.layout, prefs.panes);
  const index = panes.indexOf(null);
  return index === -1 ? null : index;
}

/**
 * The next occupied visible pane after one slot, searching cyclically.
 *
 * Used when clearing the focused pane: the grid must stay on screen, so the
 * selection moves to a pane that still holds a tab. Hidden slots never count.
 * Returns null when no other visible pane is occupied.
 */
export function nextVisiblePaneTab(
  layout: GridLayout,
  panes: readonly (string | null)[],
  afterIndex: number,
): string | null {
  const visible = visiblePaneIds(layout, panes);
  if (visible.length === 0) return null;
  const start = Number.isInteger(afterIndex)
    ? ((afterIndex % visible.length) + visible.length) % visible.length
    : -1;
  for (let step = 1; step < visible.length; step += 1) {
    const id = visible[(start + step + visible.length) % visible.length] ?? null;
    if (id !== null) return id;
  }
  return null;
}

/** The content area's surface. */
export type GridMode = "solo" | "grid";

/** Everything the solo/grid decision needs, taken from the store. */
export interface GridViewInput {
  layout: GridLayout;
  panes: readonly (string | null)[];
  activeTabId: string | null;
}

/**
 * Which surface the content area shows.
 *
 * `single` is inherently solo and a tab that no visible pane holds is shown
 * full-size. A split layout with no active tab keeps the grid on screen (all
 * panes empty), which is what makes clearing the last pane stay in the grid
 * instead of falling back to a blank solo surface. No separate mode flag is
 * needed.
 */
export function gridMode(input: GridViewInput): GridMode {
  if (input.layout === "single") return "solo";
  if (input.activeTabId === null) return "grid";
  return visiblePaneIds(input.layout, input.panes).includes(input.activeTabId) ? "grid" : "solo";
}

/**
 * The tabs a mounted surface shows — the input the retention bound and the
 * host-pinning push both need.
 *
 * The active tab is always included: in solo it *is* the surface, and in the
 * grid it is the focused pane (whose transcript and TUI state must stay warm
 * even while another pane is being pointed at).
 */
export function visibleGridTabIds(
  input: GridViewInput,
  mode: GridMode = gridMode(input),
): string[] {
  if (mode === "solo") {
    return input.activeTabId === null ? [] : [input.activeTabId];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  if (input.activeTabId !== null) {
    seen.add(input.activeTabId);
    out.push(input.activeTabId);
  }
  for (const id of visiblePaneIds(input.layout, input.panes)) {
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** What the content area should render while a tab drag is active. */
export interface GridSurfaceInput extends GridViewInput {
  lastMultiLayout: GridMultiLayout;
  dragging: boolean;
}

export interface GridSurface {
  mode: GridMode;
  layout: GridLayout;
  /** True only when the grid is shown *because* a drag is active. */
  dragReveal: boolean;
}

/**
 * The surface for the current inputs, including the transient drag reveal.
 *
 * A drag from solo replaces the single surface with the remembered multi layout,
 * so every pane is a drop target. The reveal is renderer-only: it never mutates
 * `prefs.grid`; a drop adopts the layout explicitly, and a cancelled drag simply
 * stops asking for the grid.
 */
export function gridSurface(input: GridSurfaceInput): GridSurface {
  const mode = gridMode(input);
  if (!input.dragging || mode === "grid") {
    return { mode, layout: input.layout, dragReveal: false };
  }
  return {
    mode: "grid",
    layout: input.layout === "single" ? input.lastMultiLayout : input.layout,
    dragReveal: true,
  };
}
