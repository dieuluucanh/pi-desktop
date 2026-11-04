import { describe, expect, it } from "vitest";
import {
  ALWAYS_AVAILABLE_RAIL_MENU_IDS,
  DEFAULT_RAIL_COLLAPSED,
  DEFAULT_RAIL_PREFS,
  DEFAULT_RAIL_SPLIT,
  MAX_RAIL_WIDTH,
  MAX_SPLIT_FRACTION,
  MIN_BLOCK_PX,
  MIN_RAIL_WIDTH,
  MIN_SPLIT_FRACTION,
  RAIL_MENU_IDS,
  availableRailMenus,
  clampRailSplit,
  clampRailWidth,
  isRailMenuId,
  mergeRailPrefs,
  moveRailMenu,
  railSplitFractions,
  railSplitWithDelta,
  resolveActiveMenu,
  sanitizeRailCollapsed,
  sanitizeRailMenuOrder,
  sanitizeRailPrefs,
  type RailMenuId,
} from "../../src/shared/rail";
import {
  DEFAULT_PREFS,
  MIN_SIDEBAR_WIDTH,
  mergePrefs,
  sanitizePrefs,
} from "../../src/shared/prefs";

/**
 * The docked panel rail's preference model.
 *
 * The rail is the one nested preference, so its sanitizer and its merge are the
 * two places a bad document could widen the window, lose a menu, or let a
 * `{ open: true }` patch silently discard the width and the strip order. The
 * render-time resolver is the third: a persisted menu that the session does not
 * have (Documents without the Office bridge) must fall back without rewriting
 * what the user chose.
 */

describe("clampRailWidth", () => {
  it("matches the sidebar's minimum width", () => {
    // Both columns use the same floor; the rail's strip is extra chrome.
    expect(MIN_RAIL_WIDTH).toBe(MIN_SIDEBAR_WIDTH);
  });

  it("clamps into the supported range", () => {
    expect(clampRailWidth(0)).toBe(MIN_RAIL_WIDTH);
    expect(clampRailWidth(MIN_RAIL_WIDTH - 1)).toBe(MIN_RAIL_WIDTH);
    expect(clampRailWidth(10_000)).toBe(MAX_RAIL_WIDTH);
    expect(clampRailWidth(320)).toBe(320);
    expect(clampRailWidth(400.6)).toBe(401);
  });

  it("falls back to the default for a non-number", () => {
    expect(clampRailWidth(undefined)).toBe(DEFAULT_RAIL_PREFS.width);
    expect(clampRailWidth("400")).toBe(DEFAULT_RAIL_PREFS.width);
    expect(clampRailWidth(Number.NaN)).toBe(DEFAULT_RAIL_PREFS.width);
    expect(clampRailWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_RAIL_PREFS.width);
  });
});

describe("isRailMenuId", () => {
  it("accepts exactly the declared ids", () => {
    for (const id of RAIL_MENU_IDS) expect(isRailMenuId(id)).toBe(true);
    expect(isRailMenuId("source-control ")).toBe(false);
    expect(isRailMenuId("git")).toBe(false);
    expect(isRailMenuId("terminal")).toBe(false);
    expect(isRailMenuId(undefined)).toBe(false);
  });

  it("keeps the two unconditional menus inside the full set", () => {
    expect(RAIL_MENU_IDS).toEqual(["source-control", "checkpoints", "documents"]);
    expect(ALWAYS_AVAILABLE_RAIL_MENU_IDS).toEqual(["source-control", "checkpoints"]);
    for (const id of ALWAYS_AVAILABLE_RAIL_MENU_IDS) expect(RAIL_MENU_IDS).toContain(id);
  });
});

describe("sanitizeRailMenuOrder", () => {
  it("keeps a full permutation as given", () => {
    expect(sanitizeRailMenuOrder(["documents", "source-control", "checkpoints"])).toEqual([
      "documents",
      "source-control",
      "checkpoints",
    ]);
  });

  it("drops duplicates and unknown ids", () => {
    expect(sanitizeRailMenuOrder(["checkpoints", "checkpoints", "git", 42])).toEqual([
      "checkpoints",
      "source-control",
      "documents",
    ]);
  });

  it("appends every missing menu in canonical order", () => {
    // A document from a build that only knew one menu must not lose the others.
    expect(sanitizeRailMenuOrder(["documents"])).toEqual([
      "documents",
      "source-control",
      "checkpoints",
    ]);
  });

  it("falls back to the canonical order for a non-array", () => {
    for (const value of [undefined, null, "order", 7, { order: [] }]) {
      expect(sanitizeRailMenuOrder(value)).toEqual([...RAIL_MENU_IDS]);
    }
  });
});

describe("availableRailMenus", () => {
  it("filters the persisted order to the available menus", () => {
    expect(availableRailMenus([...RAIL_MENU_IDS], [...ALWAYS_AVAILABLE_RAIL_MENU_IDS])).toEqual([
      "source-control",
      "checkpoints",
    ]);
  });

  it("appends an available menu the stored order forgot", () => {
    // Derived state must never hide a menu because an older build wrote a short
    // order list; the sanitizer normally prevents it, the guard is belt and braces.
    expect(availableRailMenus(["documents"], ["source-control", "documents"])).toEqual([
      "documents",
      "source-control",
    ]);
  });
});

describe("resolveActiveMenu", () => {
  const all = [...RAIL_MENU_IDS];

  it("shows the requested menu when it is available", () => {
    expect(resolveActiveMenu("checkpoints", all, all)).toEqual({
      menus: all,
      menu: "checkpoints",
      isFallback: false,
    });
  });

  it("falls back to the first available menu, without writing anything", () => {
    // A persisted `documents` on a machine with no Office bridge.
    const resolved = resolveActiveMenu("documents", all, [...ALWAYS_AVAILABLE_RAIL_MENU_IDS]);
    expect(resolved.menu).toBe("source-control");
    expect(resolved.isFallback).toBe(true);
    expect(resolved.menus).toEqual(["source-control", "checkpoints"]);
  });

  it("respects the user's order when choosing the fallback", () => {
    expect(
      resolveActiveMenu(
        "documents",
        ["checkpoints", "source-control", "documents"],
        ["source-control", "checkpoints"],
      ).menu,
    ).toBe("checkpoints");
  });

  it("falls back for an unknown or missing active menu", () => {
    for (const value of [undefined, null, "git", 3]) {
      expect(resolveActiveMenu(value, all, all)).toEqual({
        menus: all,
        menu: "source-control",
        isFallback: true,
      });
    }
  });

  it("has no body when nothing is available", () => {
    expect(resolveActiveMenu("source-control", all, [])).toEqual({
      menus: [],
      menu: null,
      isFallback: false,
    });
  });
});

describe("moveRailMenu", () => {
  const order = [...RAIL_MENU_IDS];

  it("moves an entry to a drop index", () => {
    expect(moveRailMenu(order, "documents", 0)).toEqual([
      "documents",
      "source-control",
      "checkpoints",
    ]);
    expect(moveRailMenu(order, "source-control", 1)).toEqual([
      "checkpoints",
      "source-control",
      "documents",
    ]);
  });

  it("clamps the index at both ends instead of wrapping", () => {
    expect(moveRailMenu(order, "source-control", -2)).toEqual(order);
    expect(moveRailMenu(order, "documents", 99)).toEqual(order);
  });

  it("is a no-op for an unknown id or the entry's own index, and never mutates the input", () => {
    const input = [...order];
    expect(moveRailMenu(input, "git" as never, 0)).toEqual(order);
    expect(moveRailMenu(input, "checkpoints", 1)).toEqual(order);
    expect(moveRailMenu(input, "documents", 0)).toEqual([
      "documents",
      "source-control",
      "checkpoints",
    ]);
    expect(input).toEqual(order);
  });
});

describe("sanitizeRailPrefs", () => {
  it("returns the defaults for nothing at all", () => {
    expect(sanitizeRailPrefs(undefined)).toEqual(DEFAULT_RAIL_PREFS);
    expect(sanitizeRailPrefs(null)).toEqual(DEFAULT_RAIL_PREFS);
    expect(sanitizeRailPrefs("nope")).toEqual(DEFAULT_RAIL_PREFS);
    expect(sanitizeRailPrefs([])).toEqual(DEFAULT_RAIL_PREFS);
  });

  it("keeps a valid document", () => {
    const prefs = sanitizeRailPrefs({
      open: true,
      activeMenu: "checkpoints",
      width: 420,
      order: ["checkpoints", "source-control", "documents"],
      split: { top: 0.5, middle: 0.3 },
      collapsed: { staged: true, changed: false, stashes: false },
    });
    expect(prefs).toEqual({
      open: true,
      activeMenu: "checkpoints",
      width: 420,
      order: ["checkpoints", "source-control", "documents"],
      split: { top: 0.5, middle: 0.3 },
      collapsed: { staged: true, changed: false, stashes: false },
    });
  });

  it("clamps a hostile width", () => {
    expect(sanitizeRailPrefs({ width: -5 }).width).toBe(MIN_RAIL_WIDTH);
    expect(sanitizeRailPrefs({ width: 99_999 }).width).toBe(MAX_RAIL_WIDTH);
  });

  it("keeps an unavailable-but-known active menu (availability is a render-time fact)", () => {
    // `documents` is known here even when the Office bridge is absent; the
    // resolver, not the sanitizer, decides what to show.
    expect(sanitizeRailPrefs({ activeMenu: "documents" }).activeMenu).toBe("documents");
  });

  it("falls back to the default menu for an unknown active menu", () => {
    for (const value of [undefined, null, "git", 2]) {
      expect(sanitizeRailPrefs({ activeMenu: value }).activeMenu).toBe(
        DEFAULT_RAIL_PREFS.activeMenu,
      );
    }
  });

  it("migrates a pre-strip document that carried `sections`", () => {
    const prefs = sanitizeRailPrefs({
      open: true,
      width: 400,
      sections: { git: false, changes: false, history: true, checkpoints: true, documents: true },
    });
    expect(prefs.open).toBe(true);
    expect(prefs.width).toBe(400);
    expect(prefs.order).toEqual([...RAIL_MENU_IDS]);
    expect(prefs.activeMenu).toBe(DEFAULT_RAIL_PREFS.activeMenu);
    expect("sections" in prefs).toBe(false);
  });

  it("drops unknown keys instead of carrying them forward", () => {
    const prefs = sanitizeRailPrefs({ evil: "payload", order: ["nope"] });
    expect("evil" in prefs).toBe(false);
    expect(prefs.order).toEqual([...RAIL_MENU_IDS]);
  });

  it("returns a fresh object and a fresh order array each time", () => {
    const first = sanitizeRailPrefs(undefined);
    first.order.reverse();
    first.activeMenu = "documents";
    first.split.top = 0.9;
    first.collapsed.stashes = false;
    expect(DEFAULT_RAIL_PREFS.order).toEqual([...RAIL_MENU_IDS]);
    expect(DEFAULT_RAIL_PREFS.activeMenu).toBe("source-control");
    expect(DEFAULT_RAIL_PREFS.split).toEqual(DEFAULT_RAIL_SPLIT);
    expect(DEFAULT_RAIL_PREFS.collapsed).toEqual(DEFAULT_RAIL_COLLAPSED);
    expect(sanitizeRailPrefs(undefined).order).toEqual([...RAIL_MENU_IDS]);
  });
});

describe("clampRailSplit", () => {
  it("returns the defaults for nothing usable", () => {
    expect(clampRailSplit(undefined)).toEqual(DEFAULT_RAIL_SPLIT);
    expect(clampRailSplit(null)).toEqual(DEFAULT_RAIL_SPLIT);
    expect(clampRailSplit("nope")).toEqual(DEFAULT_RAIL_SPLIT);
    expect(clampRailSplit([])).toEqual(DEFAULT_RAIL_SPLIT);
  });

  it("clamps each fraction into the supported band", () => {
    // middle lands on the floor, which leaves History exactly its own floor, so
    // top is then renormalised down from MAX to 0.70 — that is the invariant
    // working, not a bug: three blocks must still fit the panel.
    const hostile = clampRailSplit({ top: 5, middle: -1 });
    expect(hostile.middle).toBe(MIN_SPLIT_FRACTION);
    expect(hostile.top).toBeCloseTo(1 - 2 * MIN_SPLIT_FRACTION, 9);
    expect(hostile.top).toBeLessThanOrEqual(MAX_SPLIT_FRACTION);
    // A pair with room to spare keeps its values verbatim.
    expect(clampRailSplit({ top: 0.5, middle: 0.3 })).toEqual({ top: 0.5, middle: 0.3 });
  });

  it("falls back per key for a non-number", () => {
    expect(clampRailSplit({ top: "wide", middle: 0.5 })).toEqual({
      top: DEFAULT_RAIL_SPLIT.top,
      middle: 0.5,
    });
    // NaN is not usable, so the default stands rather than poisoning the layout.
    expect(clampRailSplit({ top: Number.NaN, middle: 0.5 })).toEqual({
      top: DEFAULT_RAIL_SPLIT.top,
      middle: 0.5,
    });
  });

  it("renormalises an overlapping pair so History keeps its floor", () => {
    // 0.7 + 0.7 = 1.4, which would leave History negative.
    const split = clampRailSplit({ top: 0.7, middle: 0.7 });
    expect(split.top + split.middle).toBeCloseTo(1 - MIN_SPLIT_FRACTION, 9);
    expect(split.top).toBeGreaterThan(MIN_SPLIT_FRACTION);
    expect(split.middle).toBeGreaterThan(MIN_SPLIT_FRACTION);
  });

  it("shrinks proportionally, so neither block collapses into the other", () => {
    const split = clampRailSplit({ top: 0.72, middle: 0.6 });
    expect(split.top + split.middle).toBeCloseTo(1 - MIN_SPLIT_FRACTION, 9);
    // The larger block gives up more absolute height than the smaller one.
    expect(0.72 - split.top).toBeGreaterThan(0.6 - split.middle);
  });
});

describe("railSplitFractions", () => {
  it("always sums to one", () => {
    for (const split of [
      DEFAULT_RAIL_SPLIT,
      { top: 0.15, middle: 0.15 },
      { top: 0.72, middle: 0.72 },
      { top: 0.5, middle: 0.4 },
    ]) {
      const fractions = railSplitFractions(split);
      expect(fractions.top + fractions.middle + fractions.history).toBeCloseTo(1, 9);
      expect(fractions.history).toBeGreaterThanOrEqual(MIN_SPLIT_FRACTION - 1e-9);
    }
  });

  it("reports the default split as the documented thirds", () => {
    expect(railSplitFractions(DEFAULT_RAIL_SPLIT)).toEqual({
      top: 0.34,
      middle: 0.4,
      history: expect.closeTo(0.26, 9),
    });
  });
});

describe("railSplitWithDelta", () => {
  const BODY = 500;

  it("moves the top boundary: Top and Changes trade height, History is fixed", () => {
    const next = railSplitWithDelta({ top: 0.34, middle: 0.4 }, "top", 50, BODY);
    expect(next.top).toBeCloseTo(0.34 + 50 / BODY, 9);
    // A splitter moves a boundary, so only its two neighbours change.
    expect(next.middle).toBeCloseTo(0.4 - 50 / BODY, 9);
    expect(1 - next.top - next.middle).toBeCloseTo(0.26, 9);
  });

  it("moves the middle boundary and leaves the top untouched", () => {
    const next = railSplitWithDelta({ top: 0.34, middle: 0.4 }, "middle", -50, BODY);
    expect(next.top).toBe(0.34);
    // Changes shrinks and History — the remainder — absorbs the difference.
    expect(next.middle).toBeCloseTo(0.4 - 50 / BODY, 9);
    expect(1 - next.top - next.middle).toBeCloseTo(0.26 + 50 / BODY, 9);
  });

  it("stops at MIN_BLOCK_PX for the block being shrunk", () => {
    const shrunk = railSplitWithDelta({ top: 0.34, middle: 0.4 }, "top", -10_000, BODY);
    expect(shrunk.top * BODY).toBeCloseTo(MIN_BLOCK_PX, 6);
    const shrunkMiddle = railSplitWithDelta({ top: 0.34, middle: 0.4 }, "middle", -10_000, BODY);
    expect(shrunkMiddle.middle * BODY).toBeCloseTo(MIN_BLOCK_PX, 6);
  });

  it("stops the top edge before Changes drops below its floor", () => {
    const next = railSplitWithDelta({ top: 0.34, middle: 0.4 }, "top", 10_000, BODY);
    // History is fixed; the drag is bounded by Changes hitting its floor.
    expect(next.middle * BODY).toBeCloseTo(MIN_BLOCK_PX, 6);
    expect(1 - next.top - next.middle).toBeCloseTo(0.26, 9);
  });

  it("stops the middle edge before History drops below its floor", () => {
    const next = railSplitWithDelta({ top: 0.34, middle: 0.4 }, "middle", 10_000, BODY);
    expect(next.top).toBe(0.34);
    expect((1 - next.top - next.middle) * BODY).toBeCloseTo(MIN_BLOCK_PX, 6);
  });

  it("is a no-op without a measurable container", () => {
    for (const containerPx of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(railSplitWithDelta({ top: 0.34, middle: 0.4 }, "top", 100, containerPx)).toEqual({
        top: 0.34,
        middle: 0.4,
      });
    }
  });

  it("is a no-op for a non-finite delta", () => {
    expect(railSplitWithDelta({ top: 0.34, middle: 0.4 }, "top", Number.NaN, BODY)).toEqual({
      top: 0.34,
      middle: 0.4,
    });
  });

  it("never exceeds MAX_SPLIT_FRACTION in a tall panel", () => {
    const next = railSplitWithDelta({ top: 0.34, middle: 0.4 }, "top", 10_000, 4_000);
    expect(next.top).toBeLessThanOrEqual(MAX_SPLIT_FRACTION);
  });
});

describe("sanitizeRailCollapsed", () => {
  it("defaults every group, with Stashes folded away", () => {
    expect(sanitizeRailCollapsed(undefined)).toEqual(DEFAULT_RAIL_COLLAPSED);
    expect(DEFAULT_RAIL_COLLAPSED).toEqual({ staged: false, changed: false, stashes: true });
  });

  it("keeps booleans and ignores anything else", () => {
    expect(sanitizeRailCollapsed({ staged: true, changed: "yes", stashes: 0 })).toEqual({
      staged: true,
      changed: false,
      stashes: true,
    });
  });
});

describe("mergeRailPrefs", () => {
  const current = {
    open: true,
    activeMenu: "checkpoints" as const,
    width: 400,
    order: ["checkpoints", "source-control", "documents"] as const satisfies readonly [
      "checkpoints",
      "source-control",
      "documents",
    ],
    split: { top: 0.5, middle: 0.3 },
    collapsed: { staged: true, changed: false, stashes: true },
  };

  it("keeps untouched fields when only `open` changes", () => {
    const next = mergeRailPrefs({ ...current, order: [...current.order] }, { open: false });
    expect(next).toEqual({ ...current, open: false, order: [...current.order] });
  });

  it("replaces the order wholesale instead of merging entries", () => {
    const next = mergeRailPrefs(
      { ...current, order: [...current.order] },
      {
        order: ["documents"],
      },
    );
    // Replaced, then completed by the sanitizer — never concatenated, which
    // would duplicate `documents`.
    expect(next.order).toEqual(["documents", "source-control", "checkpoints"]);
    expect(next.width).toBe(400);
    expect(next.activeMenu).toBe("checkpoints");
  });

  it("ignores a non-object patch", () => {
    expect(mergeRailPrefs({ ...current, order: [...current.order] }, null)).toEqual({
      ...current,
      order: [...current.order],
    });
    expect(mergeRailPrefs({ ...current, order: [...current.order] }, "x")).toEqual({
      ...current,
      order: [...current.order],
    });
  });

  it("merges one split key without discarding its sibling", () => {
    const next = mergeRailPrefs(
      { ...current, order: [...current.order] },
      { split: { top: 0.45 } },
    );
    expect(next.split).toEqual({ top: 0.45, middle: 0.3 });
    expect(next.collapsed).toEqual(current.collapsed);
    expect(next.width).toBe(400);
  });

  it("merges one collapsed key without discarding its siblings", () => {
    const next = mergeRailPrefs(
      { ...current, order: [...current.order] },
      { collapsed: { stashes: false } },
    );
    expect(next.collapsed).toEqual({ staged: true, changed: false, stashes: false });
    expect(next.split).toEqual(current.split);
  });
});

describe("rail inside the preference patch", () => {
  it("does not let a nested patch discard the width or the order", () => {
    const current = {
      ...DEFAULT_PREFS,
      rail: {
        ...DEFAULT_RAIL_PREFS,
        open: false,
        width: 480,
        order: ["checkpoints", "source-control", "documents"] as RailMenuId[],
      },
    };
    const next = mergePrefs(current, { rail: { open: true } });
    expect(next.rail.open).toBe(true);
    // The spread-only merge would have reset these to the defaults.
    expect(next.rail.width).toBe(480);
    expect(next.rail.order).toEqual(["checkpoints", "source-control", "documents"]);
  });

  it("merges the active menu without collapsing the rest", () => {
    const next = mergePrefs(DEFAULT_PREFS, { rail: { activeMenu: "checkpoints" } });
    expect(next.rail.activeMenu).toBe("checkpoints");
    expect(next.rail.width).toBe(DEFAULT_RAIL_PREFS.width);
    expect(next.rail.order).toEqual([...RAIL_MENU_IDS]);
    expect(next.rail.split).toEqual(DEFAULT_RAIL_SPLIT);
    expect(next.rail.collapsed).toEqual(DEFAULT_RAIL_COLLAPSED);
  });

  it("keeps a dragged split and a collapsed group across an unrelated patch", () => {
    const current = {
      ...DEFAULT_PREFS,
      rail: {
        ...DEFAULT_RAIL_PREFS,
        split: { top: 0.5, middle: 0.25 },
        collapsed: { staged: true, changed: false, stashes: false },
      },
    };
    const next = mergePrefs(current, { rail: { open: true } });
    expect(next.rail.split).toEqual({ top: 0.5, middle: 0.25 });
    expect(next.rail.collapsed).toEqual({ staged: true, changed: false, stashes: false });
  });

  it("migrates an app-state.json written before the rail existed", () => {
    // A pre-rail document: no `rail` key at all.
    const prefs = sanitizePrefs({
      theme: "light",
      sidebarWidth: 300,
      showExpandedPrompts: true,
    });
    expect(prefs.theme).toBe("light");
    expect(prefs.sidebarWidth).toBe(300);
    expect(prefs.rail).toEqual(DEFAULT_RAIL_PREFS);
  });

  it("migrates an app-state.json written before the strip existed", () => {
    const prefs = sanitizePrefs({
      rail: {
        open: true,
        width: 400,
        sections: { git: true, changes: true, history: true, checkpoints: true, documents: true },
      },
    });
    expect(prefs.rail.open).toBe(true);
    expect(prefs.rail.width).toBe(400);
    expect(prefs.rail.activeMenu).toBe("source-control");
    expect(prefs.rail.order).toEqual([...RAIL_MENU_IDS]);
    expect("sections" in prefs.rail).toBe(false);
  });

  it("survives a corrupted rail value", () => {
    expect(sanitizePrefs({ rail: "broken" }).rail).toEqual(DEFAULT_RAIL_PREFS);
    expect(sanitizePrefs({ rail: { order: 42 } }).rail.order).toEqual([...RAIL_MENU_IDS]);
  });

  it("never mutates the module default through a sanitized copy", () => {
    const copy = sanitizePrefs({}).rail;
    copy.order.push("documents");
    copy.activeMenu = "documents";
    copy.split.top = 0.9;
    copy.collapsed.stashes = false;
    expect(DEFAULT_PREFS.rail.order).toEqual([...RAIL_MENU_IDS]);
    expect(DEFAULT_PREFS.rail.activeMenu).toBe("source-control");
    expect(DEFAULT_PREFS.rail.split).toEqual(DEFAULT_RAIL_SPLIT);
    expect(DEFAULT_PREFS.rail.collapsed).toEqual(DEFAULT_RAIL_COLLAPSED);
  });
});
