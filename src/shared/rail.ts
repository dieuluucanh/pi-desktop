/**
 * The docked panel rail's preference model.
 *
 * The rail is a VS Code-style dock on the right edge of a session: an
 * always-visible vertical **strip** of three menus — **Source Control**
 * (branch, commit composer, changes, stashes, history), **Checkpoints** and
 * **Documents** — beside one resizable **panel body**. Clicking an entry expands
 * its body; clicking the active entry collapses it again.
 *
 * This module is shared rather than renderer-only because `prefs` persists the
 * layout: the closed key set in `src/shared/prefs.ts`, the main-process
 * sanitizer and the renderer all have to agree on the ids and on the order.
 */

/** The rail's menus, in their canonical (default strip) order. */
export type RailMenuId = "source-control" | "checkpoints" | "documents";

export const RAIL_MENU_IDS: readonly RailMenuId[] = [
  "source-control",
  "checkpoints",
  "documents",
] as const;

/**
 * The menus that exist in every session.
 *
 * `documents` is absent on purpose: it only appears once the Office bridge
 * answered `/health` (plan D-A10 — no Office surface when Office was never set
 * up), which is a runtime fact, not a stored one.
 */
export const ALWAYS_AVAILABLE_RAIL_MENU_IDS: readonly RailMenuId[] = [
  "source-control",
  "checkpoints",
] as const;

/** True when a value is a known menu id. */
export function isRailMenuId(value: unknown): value is RailMenuId {
  return typeof value === "string" && (RAIL_MENU_IDS as readonly string[]).includes(value);
}

/** A menu's human label: the strip's tooltip and the panel's title. */
export const RAIL_MENU_LABELS: Record<RailMenuId, string> = {
  "source-control": "Source Control",
  checkpoints: "Checkpoints",
  documents: "Documents",
};

export interface RailPrefs {
  /**
   * Whether the panel body is expanded. The strip itself is always mounted, so
   * `false` means "collapsed to the strip", never "the rail does not exist".
   */
  open: boolean;
  /**
   * The menu the user last opened. It is remembered while the panel is
   * collapsed, so reopening returns to the same body. A menu that is not
   * currently available is resolved at render time — see
   * {@link resolveActiveMenu} — never rewritten here.
   */
  activeMenu: RailMenuId;
  /** Panel body width in CSS pixels, clamped to the supported range. */
  width: number;
  /** The strip's order, top to bottom. Always a permutation of {@link RAIL_MENU_IDS}. */
  order: RailMenuId[];
}

export const MIN_RAIL_WIDTH = 260;
export const MAX_RAIL_WIDTH = 560;
export const DEFAULT_RAIL_WIDTH = 320;

/**
 * Defaults: the panel is **collapsed** (a session should not open with a column
 * the user did not ask for) while the strip stays visible, and Source Control is
 * the menu a first click opens.
 */
export const DEFAULT_RAIL_PREFS: RailPrefs = {
  open: false,
  activeMenu: "source-control",
  width: DEFAULT_RAIL_WIDTH,
  order: [...RAIL_MENU_IDS],
};

/** Clamps a width into the supported range; a non-number becomes the default. */
export function clampRailWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_RAIL_WIDTH;
  return Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, Math.round(value)));
}

/**
 * Coerces an untrusted strip order into a full permutation.
 *
 * Known ids keep the given order, duplicates are dropped, and every id the
 * document is missing is appended in canonical order — so a menu added in a
 * later release is never lost by an older `app-state.json`, and an id removed
 * from the app simply disappears.
 */
export function sanitizeRailMenuOrder(value: unknown): RailMenuId[] {
  const result: RailMenuId[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (isRailMenuId(entry) && !result.includes(entry)) result.push(entry);
    }
  }
  for (const id of RAIL_MENU_IDS) if (!result.includes(id)) result.push(id);
  return result;
}

/**
 * The menus to show, in strip order: the persisted order filtered to what this
 * session actually has.
 */
export function availableRailMenus(
  order: readonly RailMenuId[],
  available: readonly RailMenuId[],
): RailMenuId[] {
  const shown = order.filter((id) => available.includes(id));
  // A caller can hand a hand-built order that omits an available menu; the
  // strip must still offer it, so anything filtered out is appended.
  for (const id of available) if (!shown.includes(id)) shown.push(id);
  return shown;
}

export interface ResolvedRailMenu {
  /** The strip's entries, in order (persisted order filtered to what exists). */
  menus: RailMenuId[];
  /** The menu whose body is shown, or `null` when nothing is available. */
  menu: RailMenuId | null;
  /**
   * True when the persisted `activeMenu` is not available and another menu is
   * being shown instead. The body is then render-only: nothing is written back
   * to `prefs`, so this stays a read of the persisted layout rather than a
   * write-on-read (D15).
   */
  isFallback: boolean;
}

/**
 * Which menu body to render, and which entries the strip shows.
 *
 * Asking for a menu that is unavailable (a persisted `activeMenu: "documents"`
 * on a machine where Office was never set up) must not blank the rail or
 * rewrite the user's preference, so the first available menu is shown and the
 * caller is told it is a fallback.
 */
export function resolveActiveMenu(
  activeMenu: unknown,
  order: readonly RailMenuId[],
  available: readonly RailMenuId[],
): ResolvedRailMenu {
  const menus = availableRailMenus(order, available);
  const first = menus[0] ?? null;
  if (first === null) return { menus, menu: null, isFallback: false };
  if (isRailMenuId(activeMenu) && menus.includes(activeMenu)) {
    return { menus, menu: activeMenu, isFallback: false };
  }
  return { menus, menu: first, isFallback: true };
}

/** Where a reorder can send an entry. */
export type RailMenuMove = "up" | "down" | "top";

/**
 * Reorders one strip entry. Used by drag-and-drop (as an index) and by the
 * per-entry menu, so both paths agree on bounds and on unknown ids.
 */
export function moveRailMenu(
  order: readonly RailMenuId[],
  id: RailMenuId,
  to: RailMenuMove | number,
): RailMenuId[] {
  const next = [...order];
  const from = next.indexOf(id);
  if (from === -1) return next;
  let target: number;
  if (typeof to === "number") target = Math.round(to);
  else if (to === "top") target = 0;
  else target = from + (to === "up" ? -1 : 1);
  if (target < 0) target = 0;
  if (target > next.length - 1) target = next.length - 1;
  if (target === from) return next;
  next.splice(from, 1);
  next.splice(target, 0, id);
  return next;
}

/**
 * Coerces an untrusted rail preference document into the valid shape.
 *
 * A document written before the strip existed carries `sections` instead of
 * `order`/`activeMenu`; both new keys fall back to their defaults and the stale
 * key is dropped, so the migration needs no version bump.
 */
export function sanitizeRailPrefs(value: unknown): RailPrefs {
  const source =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    open: typeof source.open === "boolean" ? source.open : DEFAULT_RAIL_PREFS.open,
    // Availability is a render-time fact, so any known id is kept here; an
    // unknown one falls back to the default menu.
    activeMenu: isRailMenuId(source.activeMenu) ? source.activeMenu : DEFAULT_RAIL_PREFS.activeMenu,
    width: clampRailWidth(source.width),
    order: sanitizeRailMenuOrder(source.order),
  };
}

/** Merges a partial rail patch over the current value (nested, unlike a spread). */
export function mergeRailPrefs(current: RailPrefs, patch: unknown): RailPrefs {
  const source =
    patch && typeof patch === "object" && !Array.isArray(patch)
      ? (patch as Record<string, unknown>)
      : {};
  return sanitizeRailPrefs({
    ...current,
    ...source,
    // `order` is a list: a patch replaces it wholesale. Merging element-wise
    // would duplicate entries the moment two documents disagree.
    order: "order" in source ? source.order : current.order,
  });
}
