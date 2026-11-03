import { describe, expect, it } from "vitest";

import {
  DEFAULT_GRID_PREFS,
  GRID_LAYOUTS,
  GRID_LAYOUT_LABELS,
  GRID_PANE_COUNT,
  MAX_GRID_PANES,
  assignGridPane,
  firstEmptyPane,
  gridMode,
  gridPaneCount,
  gridRowCount,
  isGridLayout,
  mergeGridPrefs,
  normalizeGridPanes,
  paneAreaClass,
  paneIndexOfTab,
  sanitizeGridPrefs,
  visibleGridTabIds,
  type GridPrefs,
} from "../../src/shared/session-grid";

/**
 * The session grid's pure model (2026-11-03 grid plan step 1).
 *
 * Everything the grid decides without React lives here: the five preset shapes,
 * the swap rule that keeps one pane per tab, the sanitizer behind `prefs.grid`
 * and the solo/grid + visible-tab inputs the store and main both consume.
 */

function grid(layout: GridPrefs["layout"], panes: (string | null)[]): GridPrefs {
  return { layout, panes };
}

describe("layouts", () => {
  it("describes five presets with stable labels", () => {
    expect(GRID_LAYOUTS).toEqual(["single", "two", "three-left", "three-right", "four"]);
    for (const layout of GRID_LAYOUTS) {
      expect(GRID_LAYOUT_LABELS[layout].length).toBeGreaterThan(0);
    }
    expect(GRID_LAYOUT_LABELS.single).toBe("Single tab");
  });

  it("maps each preset to its pane count", () => {
    expect(GRID_LAYOUTS.map((layout) => gridPaneCount(layout))).toEqual([1, 2, 3, 3, 4]);
    expect(GRID_PANE_COUNT.four).toBe(4);
    // The largest preset is the only bound any stored array needs.
    expect(Math.max(...GRID_LAYOUTS.map(gridPaneCount))).toBe(MAX_GRID_PANES);
  });

  it("recognises only real layout ids", () => {
    for (const layout of GRID_LAYOUTS) expect(isGridLayout(layout)).toBe(true);
    for (const value of ["", "2", "two-columns", null, 3, {}, ["two"]]) {
      expect(isGridLayout(value)).toBe(false);
    }
  });

  it("declares the row count each preset needs", () => {
    // `single` must stay one row: a second row would halve the pane's height.
    expect(gridRowCount("single")).toBe(1);
    expect(gridRowCount("two")).toBe(2);
    expect(gridRowCount("three-left")).toBe(2);
    expect(gridRowCount("three-right")).toBe(2);
    expect(gridRowCount("four")).toBe(2);
  });
});

describe("pane geometry", () => {
  it("gives a single pane the whole area without a second row", () => {
    expect(paneAreaClass("single", 0)).toBe("col-span-2");
  });

  it("puts two panes in two full-height columns", () => {
    expect([0, 1].map((index) => paneAreaClass("two", index))).toEqual([
      "row-span-2",
      "row-span-2",
    ]);
  });

  it("puts the tall pane on the left for three-left", () => {
    expect([0, 1, 2].map((index) => paneAreaClass("three-left", index))).toEqual([
      "row-span-2",
      "",
      "",
    ]);
  });

  it("puts the tall pane on the right for three-right", () => {
    expect([0, 1, 2].map((index) => paneAreaClass("three-right", index))).toEqual([
      "",
      "row-span-2",
      "",
    ]);
  });

  it("lays four panes out as a 2x2 with no spans", () => {
    expect([0, 1, 2, 3].map((index) => paneAreaClass("four", index))).toEqual(["", "", "", ""]);
  });

  it("hides a pane index the layout does not show", () => {
    // A stale render after a shrink must not paint a fifth pane.
    expect(paneAreaClass("two", 2)).toBe("hidden");
    expect(paneAreaClass("single", 1)).toBe("hidden");
    expect(paneAreaClass("four", -1)).toBe("hidden");
  });
});

describe("normalizeGridPanes", () => {
  it("pads to the layout's pane count with empty slots", () => {
    expect(normalizeGridPanes("four", ["a"])).toEqual(["a", null, null, null]);
    expect(normalizeGridPanes("single", [])).toEqual([null]);
  });

  it("truncates to the layout's pane count, keeping the first slots", () => {
    expect(normalizeGridPanes("two", ["a", "b", "c", "d"])).toEqual(["a", "b"]);
  });

  it("drops duplicates, keeping the first occurrence", () => {
    expect(normalizeGridPanes("two", ["a", "b"])).toEqual(["a", "b"]);
    expect(normalizeGridPanes("three-left", ["a", "a", "b"])).toEqual(["a", null, "b"]);
  });

  it("turns an invalid slot into null without moving its neighbours", () => {
    expect(normalizeGridPanes("three-left", ["a", 42, "b"])).toEqual(["a", null, "b"]);
    expect(normalizeGridPanes("three-left", ["a", "", "b"])).toEqual(["a", null, "b"]);
    expect(normalizeGridPanes("three-left", ["a", "   ", "b"])).toEqual(["a", null, "b"]);
  });

  it("rejects an oversized tab id", () => {
    const huge = "x".repeat(129);
    expect(normalizeGridPanes("two", [huge, "ok"])).toEqual([null, "ok"]);
    expect(normalizeGridPanes("two", ["x".repeat(128)])).toEqual(["x".repeat(128), null]);
  });

  it("accepts a missing or non-array panes value", () => {
    expect(normalizeGridPanes("two", null)).toEqual([null, null]);
    expect(normalizeGridPanes("two", undefined)).toEqual([null, null]);
    expect(normalizeGridPanes("two", "a" as unknown as string[])).toEqual([null, null]);
  });
});

describe("sanitizeGridPrefs", () => {
  it("returns the defaults for a non-object", () => {
    for (const value of [null, undefined, 42, "four", ["a"]]) {
      expect(sanitizeGridPrefs(value)).toEqual(DEFAULT_GRID_PREFS);
    }
    // The shared default already has the layout's single (empty) slot.
    expect(DEFAULT_GRID_PREFS.panes).toEqual([null]);
  });

  it("keeps a valid layout and its panes", () => {
    expect(sanitizeGridPrefs({ layout: "four", panes: ["a", null, "b"] })).toEqual({
      layout: "four",
      panes: ["a", null, "b", null],
    });
  });

  it("falls back to single for an unknown layout, keeping the first pane", () => {
    // The layout is the user's; the assignments survive a bad id so a hand-edited
    // app-state.json does not silently lose which tab was on screen.
    expect(sanitizeGridPrefs({ layout: "nine", panes: ["a", "b", "c", "d"] })).toEqual({
      layout: "single",
      panes: ["a"],
    });
  });

  it("tolerates a missing panes array", () => {
    expect(sanitizeGridPrefs({ layout: "three-right" })).toEqual({
      layout: "three-right",
      panes: [null, null, null],
    });
  });
});

describe("mergeGridPrefs", () => {
  it("keeps the current panes when the patch only names a layout", () => {
    const current = grid("four", ["a", "b", "c", "d"]);
    expect(mergeGridPrefs(current, { layout: "two" })).toEqual({
      layout: "two",
      panes: ["a", "b"],
    });
  });

  it("replaces panes wholesale and re-normalizes against the merged layout", () => {
    const current = grid("four", ["a", "b", "c", "d"]);
    expect(mergeGridPrefs(current, { panes: ["x"] })).toEqual({
      layout: "four",
      panes: ["x", null, null, null],
    });
  });

  it("ignores an unknown layout in the patch", () => {
    const current = grid("three-left", ["a", "b", "c"]);
    expect(mergeGridPrefs(current, { layout: "wat" })).toEqual(current);
  });

  it("accepts a garbage patch without throwing", () => {
    const current = grid("two", ["a", "b"]);
    expect(mergeGridPrefs(current, null)).toEqual(current);
    expect(mergeGridPrefs(current, 7)).toEqual(current);
    expect(mergeGridPrefs(current, [1, 2])).toEqual(current);
  });
});

describe("assignGridPane", () => {
  it("fills an empty pane", () => {
    const next = assignGridPane(grid("four", ["a", null, null, null]), 2, "b");
    expect(next.panes).toEqual(["a", null, "b", null]);
  });

  it("clears a pane when the tab is null", () => {
    const next = assignGridPane(grid("two", ["a", "b"]), 0, null);
    expect(next.panes).toEqual([null, "b"]);
  });

  it("is idempotent for the same assignment", () => {
    const next = assignGridPane(grid("two", ["a", "b"]), 1, "b");
    expect(next.panes).toEqual(["a", "b"]);
  });

  it("swaps instead of showing one tab twice", () => {
    // 'b' lives in pane 1; dropping it on pane 0 moves 'a' to pane 1.
    const next = assignGridPane(grid("two", ["a", "b"]), 0, "b");
    expect(next.panes).toEqual(["b", "a"]);
  });

  it("keeps a displaced empty slot empty", () => {
    const next = assignGridPane(grid("four", ["a", "b", null, null]), 2, "b");
    expect(next.panes).toEqual(["a", null, "b", null]);
  });

  it("ignores a pane index the layout does not show", () => {
    const prefs = grid("two", ["a", "b"]);
    expect(assignGridPane(prefs, 3, "c").panes).toEqual(["a", "b"]);
    expect(assignGridPane(prefs, -1, "c").panes).toEqual(["a", "b"]);
  });

  it("rejects a blank or oversized id, clearing the slot", () => {
    expect(assignGridPane(grid("two", ["a", "b"]), 0, "  ").panes).toEqual([null, "b"]);
    expect(assignGridPane(grid("two", ["a", "b"]), 0, "x".repeat(129)).panes).toEqual([null, "b"]);
  });

  it("normalizes the stored panes before assigning", () => {
    // A stale array longer than the layout is truncated first, so the dropped
    // 'c' can still be assigned: it is no longer "already shown" in a hidden slot.
    const next = assignGridPane({ layout: "two", panes: ["a", "b", "c", "d"] }, 1, "c");
    expect(next.panes).toEqual(["a", "c"]);
  });
});

describe("lookups", () => {
  it("finds the pane holding a tab, or -1", () => {
    const prefs = grid("three-left", ["a", null, "b"]);
    expect(paneIndexOfTab(prefs, "b")).toBe(2);
    expect(paneIndexOfTab(prefs, "a")).toBe(0);
    expect(paneIndexOfTab(prefs, "missing")).toBe(-1);
    expect(paneIndexOfTab(prefs, null)).toBe(-1);
  });

  it("finds the first empty pane, or null when the layout is full", () => {
    expect(firstEmptyPane(grid("three-left", ["a", null, "b"]))).toBe(1);
    expect(firstEmptyPane(grid("two", ["a", "b"]))).toBeNull();
    expect(firstEmptyPane(grid("four", []))).toBe(0);
  });
});

describe("gridMode", () => {
  const base = { layout: "two", panes: ["a", null], solo: false, activeTabId: "a" } as const;

  it("is always solo for the single layout", () => {
    expect(gridMode({ ...base, layout: "single" })).toBe("solo");
  });

  it("is grid when a pane holds the active tab", () => {
    expect(gridMode(base)).toBe("grid");
  });

  it("is solo when the user opened a tab no pane holds", () => {
    expect(gridMode({ ...base, solo: true })).toBe("solo");
  });

  it("is solo with no active tab", () => {
    expect(gridMode({ ...base, activeTabId: null })).toBe("solo");
  });
});

describe("visibleGridTabIds", () => {
  it("is only the active tab in solo", () => {
    expect(
      visibleGridTabIds({ layout: "two", panes: ["a", "b"], solo: true, activeTabId: "c" }),
    ).toEqual(["c"]);
  });

  it("is empty when nothing is active and nothing is arranged", () => {
    expect(
      visibleGridTabIds({ layout: "single", panes: [], solo: false, activeTabId: null }),
    ).toEqual([]);
  });

  it("lists the focused tab first, then the other panes", () => {
    expect(
      visibleGridTabIds({
        layout: "four",
        panes: ["b", "c", null, "d"],
        solo: false,
        activeTabId: "b",
      }),
    ).toEqual(["b", "c", "d"]);
  });

  it("includes the active tab even when no pane holds it", () => {
    // The focused tab is on screen only in solo, but its caches must stay warm.
    expect(
      visibleGridTabIds({ layout: "two", panes: ["a", "b"], solo: false, activeTabId: "z" }),
    ).toEqual(["z", "a", "b"]);
  });

  it("drops duplicate pane slots", () => {
    expect(
      visibleGridTabIds({
        layout: "four",
        panes: ["a", "a", "b", null],
        solo: false,
        activeTabId: "b",
      }),
    ).toEqual(["b", "a"]);
  });
});
