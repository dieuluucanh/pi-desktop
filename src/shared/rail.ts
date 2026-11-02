/**
 * The docked panel rail's preference model.
 *
 * The rail is a VS Code-style dock on the right edge of a session: an
 * always-visible vertical **strip** of three menus — **Source Control**
 * (branch, commit composer, changes, stashes, history), **Checkpoints** and
 * **Documents** — beside one resizable **panel body**. Clicking an entry expands
 * its body; clicking the active entry collapses it again.
 *
 * Two more pieces of the layout are persisted here:
 *
 *  - **`split`** — Source Control is three vertically stacked blocks (Source
 *    Control, Changes, Commit History) sized by two fractions, so a user can
 *    trade height between them with the block splitters.
 *  - **`collapsed`** — the `Staged Changes` / `Changes` groups and the Stashes
 *    list each remember whether they are folded away.
 *
 * This module is shared rather than renderer-only because `prefs` persists the
 * layout: the closed key set in `src/shared/prefs.ts`, the main-process
 * sanitizer and the renderer all have to agree on the ids and on the order.
 *
 * One rule the split math exists to hold: **a render-time clamp is never written
 * back**. `prefs.rail` has one writer (the store) and only an explicit user
 * gesture — a drag, a keyboard nudge, a double-click reset — calls it.
 */

/** The rail's menus, in their canonical (default strip) order. */
export type RailMenuId = "explorer" | "source-control" | "checkpoints" | "documents";

export const RAIL_MENU_IDS: readonly RailMenuId[] = [
  "source-control",
  "checkpoints",
  "documents",
] as const;

/**
 * The menus that exist in every session.
 *
 * `documents` is absent on purpose: it is a runtime fact, not a stored one.
 * Since the 2026-10-30 rail-headers plan it is present when **either** the Pi
 * settings list the bridge package (a stable, offline install fact), **or** the
 * bridge answered `/health`, **or** an `office`-kind tab exists — so one failed
 * probe during a host restart cannot remove the menu. See `ProjectRail`.
 */
export const ALWAYS_AVAILABLE_RAIL_MENU_IDS: readonly RailMenuId[] = [
  "source-control",
  "checkpoints",
] as const;

/** True when a value is a known menu id. Explorer is a valid id even though it
 * is not part of the persisted three-menu default order. */
export function isRailMenuId(value: unknown): value is RailMenuId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(RAIL_MENU_LABELS, value);
}

/** A menu's human label: the strip's tooltip and the panel's title. */
export const RAIL_MENU_LABELS: Record<RailMenuId, string> = {
  explorer: "Explorer",
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
  /** The Source Control menu's three block heights, as flex fractions. */
  split: RailSplitPrefs;
  /** Which collapsible groups inside Source Control are folded away. */
  collapsed: RailCollapsedPrefs;
}

/**
 * The Source Control menu's block heights, as fractions of the panel body.
 *
 * Two numbers describe three blocks: `history` is the remainder, so the three
 * always fill the panel exactly. Source Control is the top block (branch row,
 * commit composer, stashes), then Changes, then Commit History.
 */
export interface RailSplitPrefs {
  /** Fraction of the body given to the Source Control block. */
  top: number;
  /** Fraction given to the Changes block; Commit History takes the rest. */
  middle: number;
}

/** Which Source Control groups are collapsed. */
export interface RailCollapsedPrefs {
  /** The `Staged Changes` group. */
  staged: boolean;
  /** The `Changes` group. */
  changed: boolean;
  /** The Stashes list — collapsed by default. */
  stashes: boolean;
}

/** A group whose collapse state is persisted. */
export type RailCollapsedGroup = keyof RailCollapsedPrefs;

/** Which boundary a block splitter moves. */
export type RailSplitEdge = "top" | "middle";

/**
 * The panel body's minimum width. It matches the sidebar's minimum
 * (`MIN_SIDEBAR_WIDTH`), so both columns can be narrowed to the same size; the
 * rail's 44 px strip is additional chrome.
 */
export const MIN_RAIL_WIDTH = 200;
export const MAX_RAIL_WIDTH = 560;
export const DEFAULT_RAIL_WIDTH = 320;

/**
 * The default block split: Source Control 34 %, Changes 40 %, History 26 %.
 *
 * Chosen so all three clear {@link MIN_BLOCK_PX} in a window at the app's
 * minimum size: the smallest supported body is roughly 500 px tall, and the
 * floors add up to 240 px.
 */
export const DEFAULT_RAIL_SPLIT: RailSplitPrefs = { top: 0.34, middle: 0.4 };

/** Stashes start folded away; the two change groups start open. */
export const DEFAULT_RAIL_COLLAPSED: RailCollapsedPrefs = {
  staged: false,
  changed: false,
  stashes: true,
};

/** No block may be given less than this share of the body, whatever the drag. */
export const MIN_SPLIT_FRACTION = 0.15;
/** No block may be given more than this share; the other two need room. */
export const MAX_SPLIT_FRACTION = 0.72;
/** And no block may render shorter than this many pixels, measured at drag time. */
export const MIN_BLOCK_PX = 80;
/** Keyboard nudge for a block splitter (`Shift` multiplies it). */
export const SPLITTER_KEYBOARD_STEP = 16;
export const SPLITTER_KEYBOARD_STEP_LARGE = 48;

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
  split: { ...DEFAULT_RAIL_SPLIT },
  collapsed: { ...DEFAULT_RAIL_COLLAPSED },
};

/** Clamps a width into the supported range; a non-number becomes the default. */
export function clampRailWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_RAIL_WIDTH;
  return Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, Math.round(value)));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A finite number, or the fallback. */
function fraction(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Coerces an untrusted block split into a usable one.
 *
 * Each fraction is clamped into `[MIN_SPLIT_FRACTION, MAX_SPLIT_FRACTION]`, and
 * then the pair is shrunk — proportionally to the headroom each still has — so
 * the three blocks cannot sum past 100 % with History still needing
 * `MIN_SPLIT_FRACTION` of its own. Shrinking proportionally is what keeps the
 * smaller block from being pushed below its floor while the larger one keeps
 * most of its height.
 */
export function clampRailSplit(value: unknown): RailSplitPrefs {
  const source = asRecord(value);
  let top = clampFraction(fraction(source.top, DEFAULT_RAIL_SPLIT.top));
  let middle = clampFraction(fraction(source.middle, DEFAULT_RAIL_SPLIT.middle));

  const room = 1 - MIN_SPLIT_FRACTION;
  const overlap = top + middle - room;
  if (overlap > 0) {
    const shrinkableTop = Math.max(0, top - MIN_SPLIT_FRACTION);
    const shrinkableMiddle = Math.max(0, middle - MIN_SPLIT_FRACTION);
    const shrinkable = shrinkableTop + shrinkableMiddle;
    if (shrinkable > 0) {
      // `ratio` never exceeds 1: when both blocks are already at their floor the
      // pair sums to 2×MIN, which is well inside `room`.
      const ratio = Math.min(1, overlap / shrinkable);
      top -= shrinkableTop * ratio;
      middle -= shrinkableMiddle * ratio;
    }
  }

  return { top, middle };
}

function clampFraction(value: number): number {
  return Math.min(MAX_SPLIT_FRACTION, Math.max(MIN_SPLIT_FRACTION, value));
}

/**
 * The three blocks' flex weights, always summing to 1.
 *
 * The renderer uses these directly as `flexGrow`, so History is derived rather
 * than stored: a persisted pair can never describe three blocks that overflow or
 * leave a gap.
 */
export function railSplitFractions(split: RailSplitPrefs): {
  top: number;
  middle: number;
  history: number;
} {
  const { top, middle } = clampRailSplit(split);
  return { top, middle, history: 1 - top - middle };
}

/**
 * The split after dragging one boundary by `deltaPx` in a container of
 * `containerPx`.
 *
 * The measurement is passed in rather than read from the DOM so the arithmetic
 * is testable without layout (jsdom measures nothing). A non-positive container
 * (before first layout, or a collapsed ancestor) leaves the split untouched —
 * the caller must not fabricate a delta it cannot scale.
 *
 * `edge: "top"` moves the boundary between Source Control and Changes: those two
 * trade height and History keeps exactly its current share. `edge: "middle"`
 * moves the boundary between Changes and History, so Top keeps its share and
 * History (the remainder) absorbs the difference. That is what a splitter
 * physically does — it moves a boundary, so only its two neighbours change.
 */
export function railSplitWithDelta(
  split: RailSplitPrefs,
  edge: RailSplitEdge,
  deltaPx: number,
  containerPx: number,
): RailSplitPrefs {
  const current = clampRailSplit(split);
  if (!Number.isFinite(deltaPx) || !Number.isFinite(containerPx) || containerPx <= 0) {
    return current;
  }
  const delta = deltaPx / containerPx;
  // The px floors become fractions once the container is measured; whichever is
  // stricter wins, so a tall panel is governed by MIN_SPLIT_FRACTION and a short
  // one by MIN_BLOCK_PX.
  const floor = Math.max(MIN_SPLIT_FRACTION, MIN_BLOCK_PX / containerPx);

  if (edge === "top") {
    // History is the fixed third: Top and Changes share what History leaves.
    const history = 1 - current.top - current.middle;
    const upper = Math.max(floor, Math.min(MAX_SPLIT_FRACTION, 1 - history - floor));
    const top = clampBetween(current.top + delta, floor, upper);
    return { top, middle: 1 - top - history };
  }
  // Top is fixed: Changes and History share the rest.
  const upper = Math.max(floor, Math.min(MAX_SPLIT_FRACTION, 1 - current.top - floor));
  return { top: current.top, middle: clampBetween(current.middle + delta, floor, upper) };
}

function clampBetween(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value));
}

/** Coerces the collapse record; a missing or non-boolean key takes its default. */
export function sanitizeRailCollapsed(value: unknown): RailCollapsedPrefs {
  const source = asRecord(value);
  return {
    staged: typeof source.staged === "boolean" ? source.staged : DEFAULT_RAIL_COLLAPSED.staged,
    changed: typeof source.changed === "boolean" ? source.changed : DEFAULT_RAIL_COLLAPSED.changed,
    stashes: typeof source.stashes === "boolean" ? source.stashes : DEFAULT_RAIL_COLLAPSED.stashes,
  };
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

/**
 * Moves one strip entry to `toIndex` (clamped). Used by drag-and-drop, so the
 * strip and the persisted order agree on bounds and on unknown ids.
 */
export function moveRailMenu(
  order: readonly RailMenuId[],
  id: RailMenuId,
  toIndex: number,
): RailMenuId[] {
  const next = [...order];
  const from = next.indexOf(id);
  if (from === -1) return next;
  let target = Math.round(toIndex);
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
    // A document written before the three-block Source Control has neither
    // record; both fall back to their defaults, so no version bump is needed.
    split: clampRailSplit(source.split),
    collapsed: sanitizeRailCollapsed(source.collapsed),
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
    // `split` and `collapsed` are records: a patch of one key must not wipe its
    // siblings, so they merge one level deeper than the spread above.
    split: "split" in source ? { ...current.split, ...asRecord(source.split) } : current.split,
    collapsed:
      "collapsed" in source
        ? { ...current.collapsed, ...asRecord(source.collapsed) }
        : current.collapsed,
  });
}
