import { describe, expect, it } from "vitest";
import {
  ALWAYS_AVAILABLE_RAIL_MENU_IDS,
  DEFAULT_RAIL_PREFS,
  MAX_RAIL_WIDTH,
  MIN_RAIL_WIDTH,
  RAIL_MENU_IDS,
  availableRailMenus,
  clampRailWidth,
  isRailMenuId,
  mergeRailPrefs,
  moveRailMenu,
  resolveActiveMenu,
  sanitizeRailMenuOrder,
  sanitizeRailPrefs,
  type RailMenuId,
} from "../../src/shared/rail";
import { DEFAULT_PREFS, mergePrefs, sanitizePrefs } from "../../src/shared/prefs";

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
  it("clamps into the supported range", () => {
    expect(clampRailWidth(0)).toBe(MIN_RAIL_WIDTH);
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

  it("moves one step in each direction", () => {
    expect(moveRailMenu(order, "checkpoints", "up")).toEqual([
      "checkpoints",
      "source-control",
      "documents",
    ]);
    expect(moveRailMenu(order, "source-control", "down")).toEqual([
      "checkpoints",
      "source-control",
      "documents",
    ]);
  });

  it("moves to the top", () => {
    expect(moveRailMenu(order, "documents", "top")).toEqual([
      "documents",
      "source-control",
      "checkpoints",
    ]);
  });

  it("clamps at both ends instead of wrapping", () => {
    expect(moveRailMenu(order, "source-control", "up")).toEqual(order);
    expect(moveRailMenu(order, "documents", "down")).toEqual(order);
  });

  it("accepts a drop index", () => {
    expect(moveRailMenu(order, "documents", 0)).toEqual([
      "documents",
      "source-control",
      "checkpoints",
    ]);
    expect(moveRailMenu(order, "source-control", 99)).toEqual([
      "checkpoints",
      "documents",
      "source-control",
    ]);
  });

  it("is a no-op for an unknown id and never mutates the input", () => {
    const input = [...order];
    expect(moveRailMenu(input, "git" as never, "up")).toEqual(order);
    expect(moveRailMenu(input, "documents", "top")).toEqual([
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
    });
    expect(prefs).toEqual({
      open: true,
      activeMenu: "checkpoints",
      width: 420,
      order: ["checkpoints", "source-control", "documents"],
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
    expect(DEFAULT_RAIL_PREFS.order).toEqual([...RAIL_MENU_IDS]);
    expect(DEFAULT_RAIL_PREFS.activeMenu).toBe("source-control");
    expect(sanitizeRailPrefs(undefined).order).toEqual([...RAIL_MENU_IDS]);
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
    expect(DEFAULT_PREFS.rail.order).toEqual([...RAIL_MENU_IDS]);
    expect(DEFAULT_PREFS.rail.activeMenu).toBe("source-control");
  });
});
