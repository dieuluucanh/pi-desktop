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
  gridSurface,
  isGridLayout,
  mergeGridPrefs,
  nextVisiblePaneTab,
  normalizeGridPanes,
  paneIndexOfTab,
  sanitizeGridPrefs,
  visibleGridTabIds,
  visiblePaneIds,
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
  return { layout, lastMultiLayout: layout === "single" ? "two" : layout, panes };
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

describe("normalizeGridPanes", () => {
  it("pads every array to the four fixed slots", () => {
    expect(normalizeGridPanes(["a"])).toEqual(["a", null, null, null]);
    expect(normalizeGridPanes([])).toEqual([null, null, null, null]);
  });

  it("never truncates to the current layout, so a preset switch can round-trip", () => {
    expect(normalizeGridPanes(["a", "b", "c", "d"])).toEqual(["a", "b", "c", "d"]);
    expect(normalizeGridPanes(["a", "b", "c", "d", "e"])).toEqual(["a", "b", "c", "d"]);
  });

  it("drops duplicates, keeping the first occurrence", () => {
    expect(normalizeGridPanes(["a", "a", "b"])).toEqual(["a", null, "b", null]);
  });

  it("turns an invalid slot into null without moving its neighbours", () => {
    expect(normalizeGridPanes(["a", 42, "b"])).toEqual(["a", null, "b", null]);
    expect(normalizeGridPanes(["a", "", "b"])).toEqual(["a", null, "b", null]);
    expect(normalizeGridPanes(["a", "   ", "b"])).toEqual(["a", null, "b", null]);
  });

  it("rejects an oversized tab id", () => {
    const huge = "x".repeat(129);
    expect(normalizeGridPanes([huge, "ok"])).toEqual([null, "ok", null, null]);
    expect(normalizeGridPanes(["x".repeat(128)])).toEqual(["x".repeat(128), null, null, null]);
  });

  it("accepts a missing or non-array panes value", () => {
    expect(normalizeGridPanes(null)).toEqual([null, null, null, null]);
    expect(normalizeGridPanes(undefined)).toEqual([null, null, null, null]);
    expect(normalizeGridPanes("a" as unknown as string[])).toEqual([null, null, null, null]);
  });
});

describe("visiblePaneIds", () => {
  it("returns only the slots the layout shows", () => {
    const panes = ["a", "b", "c", "d"];
    expect(visiblePaneIds("single", panes)).toEqual(["a"]);
    expect(visiblePaneIds("two", panes)).toEqual(["a", "b"]);
    expect(visiblePaneIds("three-left", panes)).toEqual(["a", "b", "c"]);
    expect(visiblePaneIds("four", panes)).toEqual(panes);
  });
});

describe("sanitizeGridPrefs", () => {
  it("returns the defaults for a non-object", () => {
    for (const value of [null, undefined, 42, "four", ["a"]]) {
      expect(sanitizeGridPrefs(value)).toEqual(DEFAULT_GRID_PREFS);
    }
    // The shared default already has the four empty slots.
    expect(DEFAULT_GRID_PREFS.panes).toEqual([null, null, null, null]);
  });

  it("keeps a valid layout and its panes", () => {
    expect(sanitizeGridPrefs({ layout: "four", panes: ["a", null, "b"] })).toEqual({
      layout: "four",
      lastMultiLayout: "four",
      panes: ["a", null, "b", null],
    });
  });

  it("keeps the last multi layout while Single is selected", () => {
    expect(
      sanitizeGridPrefs({ layout: "single", lastMultiLayout: "three-left", panes: ["a"] })
        .lastMultiLayout,
    ).toBe("three-left");
  });

  it("forces lastMultiLayout to the layout whenever a multi layout is active", () => {
    expect(
      sanitizeGridPrefs({ layout: "four", lastMultiLayout: "two", panes: [] }).lastMultiLayout,
    ).toBe("four");
    expect(
      sanitizeGridPrefs({ layout: "single", lastMultiLayout: "wat", panes: [] }).lastMultiLayout,
    ).toBe("two");
  });

  it("falls back to single for an unknown layout, keeping the first pane", () => {
    // The layout is the user's; the assignments survive a bad id so a hand-edited
    // app-state.json does not silently lose which tab was on screen.
    expect(sanitizeGridPrefs({ layout: "nine", panes: ["a", "b", "c", "d"] })).toEqual({
      layout: "single",
      lastMultiLayout: "two",
      panes: ["a", "b", "c", "d"],
    });
  });

  it("tolerates a missing panes array", () => {
    expect(sanitizeGridPrefs({ layout: "three-right" })).toEqual({
      layout: "three-right",
      lastMultiLayout: "three-right",
      panes: [null, null, null, null],
    });
  });
});

describe("mergeGridPrefs", () => {
  it("keeps the current panes when the patch only names a layout", () => {
    const current = grid("four", ["a", "b", "c", "d"]);
    expect(mergeGridPrefs(current, { layout: "two" })).toEqual({
      layout: "two",
      lastMultiLayout: "two",
      panes: ["a", "b", "c", "d"],
    });
  });

  it("keeps the remembered split when the patch names Single", () => {
    const current = grid("four", ["a", "b", "c", "d"]);
    expect(mergeGridPrefs(current, { layout: "single" })).toEqual({
      layout: "single",
      lastMultiLayout: "four",
      panes: ["a", "b", "c", "d"],
    });
  });

  it("replaces panes wholesale and re-normalizes against the merged layout", () => {
    const current = grid("four", ["a", "b", "c", "d"]);
    expect(mergeGridPrefs(current, { panes: ["x"] })).toEqual({
      layout: "four",
      lastMultiLayout: "four",
      panes: ["x", null, null, null],
    });
  });

  it("ignores an unknown layout in the patch", () => {
    const current = grid("three-left", ["a", "b", "c"]);
    expect(mergeGridPrefs(current, { layout: "wat" })).toEqual({
      layout: "three-left",
      lastMultiLayout: "three-left",
      panes: ["a", "b", "c", null],
    });
  });

  it("accepts a garbage patch without throwing", () => {
    const current = grid("two", ["a", "b"]);
    const normalised = {
      layout: "two",
      lastMultiLayout: "two",
      panes: ["a", "b", null, null],
    };
    expect(mergeGridPrefs(current, null)).toEqual(normalised);
    expect(mergeGridPrefs(current, 7)).toEqual(normalised);
    expect(mergeGridPrefs(current, [1, 2])).toEqual(normalised);
  });
});

describe("assignGridPane", () => {
  it("fills an empty pane", () => {
    const next = assignGridPane(grid("four", ["a", null, null, null]), 2, "b");
    expect(next.panes).toEqual(["a", null, "b", null]);
  });

  it("clears a pane when the tab is null", () => {
    const next = assignGridPane(grid("two", ["a", "b"]), 0, null);
    expect(next.panes).toEqual([null, "b", null, null]);
  });

  it("is idempotent for the same assignment", () => {
    const next = assignGridPane(grid("two", ["a", "b"]), 1, "b");
    expect(next.panes).toEqual(["a", "b", null, null]);
  });

  it("swaps instead of showing one tab twice", () => {
    // 'b' lives in pane 1; dropping it on pane 0 moves 'a' to pane 1.
    const next = assignGridPane(grid("two", ["a", "b"]), 0, "b");
    expect(next.panes).toEqual(["b", "a", null, null]);
  });

  it("keeps a displaced empty slot empty", () => {
    const next = assignGridPane(grid("four", ["a", "b", null, null]), 2, "b");
    expect(next.panes).toEqual(["a", null, "b", null]);
  });

  it("ignores a pane index beyond the four stored slots", () => {
    const prefs = grid("two", ["a", "b"]);
    expect(assignGridPane(prefs, 4, "c").panes).toEqual(["a", "b", null, null]);
    expect(assignGridPane(prefs, -1, "c").panes).toEqual(["a", "b", null, null]);
  });

  it("rejects a blank or oversized id, clearing the slot", () => {
    expect(assignGridPane(grid("two", ["a", "b"]), 0, "  ").panes).toEqual([null, "b", null, null]);
    expect(assignGridPane(grid("two", ["a", "b"]), 0, "x".repeat(129)).panes).toEqual([
      null,
      "b",
      null,
      null,
    ]);
  });

  it("keeps hidden slot assignments when assigning another pane", () => {
    const next = assignGridPane(grid("two", ["a", "b", "c", "d"]), 0, "e");
    expect(next.panes).toEqual(["e", "b", "c", "d"]);
  });

  it("swaps with a tab held only in a hidden slot", () => {
    const next = assignGridPane(grid("two", ["a", "b", "c", "d"]), 0, "c");
    expect(next.panes).toEqual(["c", "b", "a", "d"]);
  });

  it("preserves the remembered split when assigning a pane", () => {
    const next = assignGridPane(
      { layout: "single", lastMultiLayout: "four", panes: ["a", "b", "c", "d"] },
      0,
      "e",
    );
    expect(next.lastMultiLayout).toBe("four");
    expect(next.panes).toEqual(["e", "b", "c", "d"]);
  });

  it("normalizes the stored panes before assigning", () => {
    // A stale array longer than four is truncated first, so the dropped 'e' can
    // still be assigned.
    const next = assignGridPane(
      { layout: "two", lastMultiLayout: "two", panes: ["a", "b", "c", "d", "e"] },
      1,
      "e",
    );
    expect(next.panes).toEqual(["a", "e", "c", "d"]);
  });
});

describe("lookups", () => {
  it("finds the visible pane holding a tab, or -1", () => {
    const prefs = grid("three-left", ["a", null, "b"]);
    expect(paneIndexOfTab(prefs, "b")).toBe(2);
    expect(paneIndexOfTab(prefs, "a")).toBe(0);
    expect(paneIndexOfTab(prefs, "missing")).toBe(-1);
    expect(paneIndexOfTab(prefs, null)).toBe(-1);
  });

  it("does not treat a hidden slot as a pane", () => {
    expect(paneIndexOfTab(grid("two", ["a", "b", "c", "d"]), "d")).toBe(-1);
  });

  it("finds the first empty visible pane, or null when the layout is full", () => {
    expect(firstEmptyPane(grid("three-left", ["a", null, "b"]))).toBe(1);
    expect(firstEmptyPane(grid("two", ["a", "b"]))).toBeNull();
    expect(firstEmptyPane(grid("four", []))).toBe(0);
    // Slots 2 and 3 are hidden in the two-pane layout, not empty panes.
    expect(firstEmptyPane(grid("two", ["a", "b", null, null]))).toBeNull();
  });

  it("finds the next occupied visible pane cyclically", () => {
    expect(nextVisiblePaneTab("three-left", ["a", null, "b"], 0)).toBe("b");
    expect(nextVisiblePaneTab("three-left", ["a", null, "b"], 2)).toBe("a");
    expect(nextVisiblePaneTab("three-left", ["a", null, "c"], 1)).toBe("c");
    expect(nextVisiblePaneTab("two", ["a", "b"], 0)).toBe("b");
    expect(nextVisiblePaneTab("four", ["a", "b", "c", "d"], 3)).toBe("a");
    // A hidden slot is never a handoff target, and an empty grid has none.
    expect(nextVisiblePaneTab("two", ["a", null, "hidden", null], 0)).toBeNull();
    expect(nextVisiblePaneTab("two", [null, null], 0)).toBeNull();
  });
});

describe("gridMode", () => {
  const base = { layout: "two", panes: ["a", null], activeTabId: "a" } as const;

  it("is always solo for the single layout", () => {
    expect(gridMode({ ...base, layout: "single" })).toBe("solo");
  });

  it("is grid when a pane holds the active tab", () => {
    expect(gridMode(base)).toBe("grid");
  });

  it("is solo when the active tab is not in a visible pane", () => {
    expect(gridMode({ ...base, activeTabId: "hidden" })).toBe("solo");
    expect(
      gridMode({ layout: "two", panes: ["a", "b", "hidden", null], activeTabId: "hidden" }),
    ).toBe("solo");
  });

  it("keeps the grid with no active tab in a split layout", () => {
    expect(gridMode({ ...base, activeTabId: null })).toBe("grid");
  });
});

describe("gridSurface", () => {
  const base = {
    layout: "single" as const,
    lastMultiLayout: "four" as const,
    panes: ["a", "b", "c", "d"],
    activeTabId: "a",
    dragging: false,
  };

  it("is the normal surface when no drag is active", () => {
    expect(gridSurface(base)).toEqual({ mode: "solo", layout: "single", dragReveal: false });
    expect(gridSurface({ ...base, layout: "four", panes: ["a", "b", "c", "d"] })).toEqual({
      mode: "grid",
      layout: "four",
      dragReveal: false,
    });
  });

  it("reveals the last multi layout from Single while dragging", () => {
    expect(gridSurface({ ...base, dragging: true })).toEqual({
      mode: "grid",
      layout: "four",
      dragReveal: true,
    });
  });

  it("reveals the current layout from a multi-layout solo view", () => {
    expect(
      gridSurface({
        ...base,
        layout: "two",
        lastMultiLayout: "two",
        activeTabId: "hidden",
        dragging: true,
      }),
    ).toEqual({ mode: "grid", layout: "two", dragReveal: true });
  });

  it("does not mark an already-visible grid as a reveal", () => {
    expect(gridSurface({ ...base, layout: "four", activeTabId: "b", dragging: true })).toEqual({
      mode: "grid",
      layout: "four",
      dragReveal: false,
    });
  });
});

describe("visibleGridTabIds", () => {
  it("is only the active tab when the tab is not in a pane", () => {
    expect(visibleGridTabIds({ layout: "two", panes: ["a", "b"], activeTabId: "c" })).toEqual([
      "c",
    ]);
  });

  it("is empty when nothing is active and nothing is arranged", () => {
    expect(visibleGridTabIds({ layout: "single", panes: [], activeTabId: null })).toEqual([]);
  });

  it("lists the focused tab first, then the other panes", () => {
    expect(
      visibleGridTabIds({
        layout: "four",
        panes: ["b", "c", null, "d"],
        activeTabId: "b",
      }),
    ).toEqual(["b", "c", "d"]);
  });

  it("is solo-only when the active tab is held in a hidden slot", () => {
    expect(
      visibleGridTabIds({ layout: "two", panes: ["a", "b", "z", null], activeTabId: "z" }),
    ).toEqual(["z"]);
  });

  it("drops duplicate pane slots", () => {
    expect(
      visibleGridTabIds({
        layout: "four",
        panes: ["a", "a", "b", null],
        activeTabId: "b",
      }),
    ).toEqual(["b", "a"]);
  });
});
