import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore, type AppStateShape } from "../../src/renderer/src/state/app-store";
import { clearPane } from "../../src/renderer/src/state/grid-actions";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { gridMode } from "../../src/shared/session-grid";
import type { TabRecord } from "../../src/shared/session-ipc";
import type { SessionSummary } from "../../src/shared/session-browser";
import { installBridge } from "./fixtures";

/**
 * The session grid's renderer slice (2026-11-03 plan step 6).
 *
 * The store owns three things the components must not duplicate: the layout
 * preset (persisted in `prefs.grid`), the one-pane-per-tab assignment rule, and
 * the solo/grid decision. It also pushes the visible set to main, which is what
 * keeps a pane's host awake.
 */

const WORK = "C:/work/app";

function tab(overrides: Partial<TabRecord> = {}): TabRecord {
  return {
    id: "tab-1",
    kind: "session",
    cwd: WORK,
    title: "app",
    sessionFile: null,
    status: "idle",
    createdAt: 1,
    lastActiveAt: 1,
    model: null,
    ...overrides,
  };
}

function session(path: string): SessionSummary {
  return {
    path,
    id: path,
    cwd: WORK,
    name: null,
    created: 1,
    modified: 2,
    messageCount: 1,
    firstMessage: "hi",
    allMessagesText: "hi",
    parentSessionPath: null,
  };
}

function resetStore(overrides: Partial<AppStateShape> = {}): void {
  useAppStore.setState({
    view: "session",
    project: { path: WORK, name: "app" },
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    tabs: [tab(), tab({ id: "tab-2", title: "second", lastActiveAt: 2 })],
    activeTabId: "tab-1",
    panePickerTarget: null,
    transcripts: {},
    sessionStates: {},
    hint: null,
    ...overrides,
  });
}

beforeEach(() => {
  installBridge();
  resetStore();
});

describe("setGridLayout", () => {
  it("seeds the active tab when leaving the single layout", () => {
    useAppStore.getState().setGridLayout("two");

    expect(useAppStore.getState().prefs.grid).toEqual({
      layout: "two",
      lastMultiLayout: "two",
      panes: ["tab-1", null, null, null],
    });
  });

  it("pads the new layout and keeps what the old one held", () => {
    resetStore({
      prefs: {
        ...DEFAULT_PREFS,
        grid: { layout: "two", lastMultiLayout: "two", panes: ["tab-1", "tab-2"] },
      },
    });

    useAppStore.getState().setGridLayout("four");

    expect(useAppStore.getState().prefs.grid.panes).toEqual(["tab-1", "tab-2", null, null]);
  });

  it("rescues the active tab when shrinking would hide it", () => {
    resetStore({
      prefs: {
        ...DEFAULT_PREFS,
        grid: {
          layout: "four",
          lastMultiLayout: "four",
          panes: ["tab-2", "tab-3", "tab-4", "tab-5"],
        },
      },
      activeTabId: "tab-5",
    });

    useAppStore.getState().setGridLayout("two");

    // Truncation would have hidden the tab, so it moves into slot 0 and the
    // displaced tab takes its hidden slot. Every assignment survives.
    expect(useAppStore.getState().prefs.grid.panes).toEqual(["tab-5", "tab-3", "tab-4", "tab-2"]);
  });

  it("goes solo for the single layout and leaves the panes remembered", () => {
    resetStore({
      prefs: {
        ...DEFAULT_PREFS,
        grid: { layout: "two", lastMultiLayout: "two", panes: ["tab-1", "tab-2"] },
      },
    });

    useAppStore.getState().setGridLayout("single");

    expect(useAppStore.getState().prefs.grid).toEqual({
      layout: "single",
      lastMultiLayout: "two",
      panes: ["tab-1", "tab-2", null, null],
    });
  });

  it("keeps the remembered split across four -> single -> four", () => {
    resetStore({
      prefs: {
        ...DEFAULT_PREFS,
        grid: {
          layout: "four",
          lastMultiLayout: "four",
          panes: ["tab-1", "tab-2", "tab-3", "tab-4"],
        },
      },
    });

    useAppStore.getState().setGridLayout("single");
    expect(useAppStore.getState().prefs.grid).toEqual({
      layout: "single",
      lastMultiLayout: "four",
      panes: ["tab-1", "tab-2", "tab-3", "tab-4"],
    });

    useAppStore.getState().setGridLayout("four");
    expect(useAppStore.getState().prefs.grid).toEqual({
      layout: "four",
      lastMultiLayout: "four",
      panes: ["tab-1", "tab-2", "tab-3", "tab-4"],
    });
  });
});

describe("assignPaneTab", () => {
  it("fills an empty pane and focuses its tab", async () => {
    resetStore({
      prefs: {
        ...DEFAULT_PREFS,
        grid: { layout: "two", lastMultiLayout: "two", panes: [null, null] },
      },
    });

    await useAppStore.getState().assignPaneTab(1, "tab-2");

    expect(useAppStore.getState().prefs.grid.panes).toEqual([null, "tab-2", null, null]);
    expect(useAppStore.getState().activeTabId).toBe("tab-2");
  });

  it("swaps instead of showing one tab in two panes", async () => {
    resetStore({
      prefs: {
        ...DEFAULT_PREFS,
        grid: { layout: "two", lastMultiLayout: "two", panes: ["tab-1", "tab-2"] },
      },
    });

    await useAppStore.getState().assignPaneTab(0, "tab-2");

    expect(useAppStore.getState().prefs.grid.panes).toEqual(["tab-2", "tab-1", null, null]);
  });

  it("clears a pane with null", async () => {
    resetStore({
      prefs: {
        ...DEFAULT_PREFS,
        grid: { layout: "two", lastMultiLayout: "two", panes: ["tab-1", "tab-2"] },
      },
    });

    await useAppStore.getState().assignPaneTab(1, null);

    expect(useAppStore.getState().prefs.grid.panes).toEqual(["tab-1", null, null, null]);
    expect(useAppStore.getState().activeTabId).toBe("tab-1");
  });

  it("assigns into an effective layout and records it as the last split", async () => {
    resetStore({
      prefs: {
        ...DEFAULT_PREFS,
        grid: { layout: "single", lastMultiLayout: "four", panes: [null, null, null, null] },
      },
    });

    await useAppStore.getState().assignPaneTab(1, "tab-2", { layout: "three-left" });

    expect(useAppStore.getState().prefs.grid).toEqual({
      layout: "three-left",
      lastMultiLayout: "three-left",
      panes: [null, "tab-2", null, null],
    });
  });

  it("leaves prefs untouched for a redundant assignment", async () => {
    resetStore({
      prefs: {
        ...DEFAULT_PREFS,
        grid: { layout: "two", lastMultiLayout: "two", panes: ["tab-1", null] },
      },
    });
    const setPrefs = vi.spyOn(useAppStore.getState(), "setPrefs");

    await useAppStore.getState().assignPaneTab(0, "tab-1");

    expect(setPrefs).not.toHaveBeenCalled();
  });
});

describe("clearPane", () => {
  it("keeps the grid and focuses the next occupied pane", async () => {
    resetStore({
      prefs: {
        ...DEFAULT_PREFS,
        grid: {
          layout: "two",
          lastMultiLayout: "two",
          panes: ["tab-1", "tab-2"],
        },
      },
      activeTabId: "tab-1",
    });

    await clearPane(0);

    expect(useAppStore.getState().prefs.grid.panes).toEqual([null, "tab-2", null, null]);
    expect(useAppStore.getState().activeTabId).toBe("tab-2");
    expect(
      gridMode({
        layout: useAppStore.getState().prefs.grid.layout,
        panes: useAppStore.getState().prefs.grid.panes,
        activeTabId: useAppStore.getState().activeTabId,
      }),
    ).toBe("grid");
  });

  it("leaves the active tab alone when a background pane is cleared", async () => {
    resetStore({
      prefs: {
        ...DEFAULT_PREFS,
        grid: { layout: "two", lastMultiLayout: "two", panes: ["tab-1", "tab-2"] },
      },
      activeTabId: "tab-1",
    });

    await clearPane(1);

    expect(useAppStore.getState().prefs.grid.panes).toEqual(["tab-1", null, null, null]);
    expect(useAppStore.getState().activeTabId).toBe("tab-1");
  });

  it("keeps the empty grid after clearing the last occupied pane", async () => {
    resetStore({
      prefs: {
        ...DEFAULT_PREFS,
        grid: { layout: "two", lastMultiLayout: "two", panes: ["tab-1", null] },
      },
      activeTabId: "tab-1",
    });

    await clearPane(0);

    expect(useAppStore.getState().prefs.grid.panes).toEqual([null, null, null, null]);
    expect(useAppStore.getState().activeTabId).toBeNull();
    expect(
      gridMode({
        layout: useAppStore.getState().prefs.grid.layout,
        panes: useAppStore.getState().prefs.grid.panes,
        activeTabId: useAppStore.getState().activeTabId,
      }),
    ).toBe("grid");
  });

  it("preserves hidden slots while clearing a visible pane", async () => {
    resetStore({
      prefs: {
        ...DEFAULT_PREFS,
        grid: {
          layout: "two",
          lastMultiLayout: "two",
          panes: ["tab-1", "tab-2", "tab-3", "tab-4"],
        },
      } as unknown as AppStateShape["prefs"],
      tabs: [
        tab(),
        tab({ id: "tab-2", title: "second", lastActiveAt: 2 }),
        tab({ id: "tab-3", title: "third", lastActiveAt: 3 }),
        tab({ id: "tab-4", title: "fourth", lastActiveAt: 4 }),
      ],
      activeTabId: "tab-1",
    });

    await clearPane(0);

    expect(useAppStore.getState().prefs.grid.panes).toEqual([null, "tab-2", "tab-3", "tab-4"]);
    expect(useAppStore.getState().activeTabId).toBe("tab-2");
  });

  it("writes the cleared panes once", async () => {
    const { bridge } = installBridge();
    const setPrefs = vi.spyOn(bridge.prefs, "set");
    resetStore({
      prefs: {
        ...DEFAULT_PREFS,
        grid: { layout: "two", lastMultiLayout: "two", panes: ["tab-1", "tab-2"] },
      },
      activeTabId: "tab-1",
    });

    await clearPane(0);

    expect(setPrefs).toHaveBeenCalledWith({
      grid: { layout: "two", lastMultiLayout: "two", panes: [null, "tab-2", null, null] },
    });
    expect(setPrefs).toHaveBeenCalledTimes(1);
  });

  it("does not re-insert the cleared tab when the layout changes", async () => {
    resetStore({
      prefs: {
        ...DEFAULT_PREFS,
        grid: { layout: "two", lastMultiLayout: "two", panes: ["tab-1", null] },
      },
      activeTabId: "tab-1",
    });

    await clearPane(0);
    useAppStore.getState().setGridLayout("four");

    expect(useAppStore.getState().prefs.grid.panes).toEqual([null, null, null, null]);
    expect(useAppStore.getState().activeTabId).toBeNull();
  });

  it("is a no-op for an already empty pane", async () => {
    const setPrefs = vi.spyOn(useAppStore.getState(), "setPrefs");
    resetStore({
      prefs: {
        ...DEFAULT_PREFS,
        grid: { layout: "two", lastMultiLayout: "two", panes: ["tab-1", null] },
      },
    });

    await clearPane(1);

    expect(setPrefs).not.toHaveBeenCalled();
  });
});

describe("solo and grid", () => {
  it("returns to the grid when a pane's tab is activated", async () => {
    resetStore({
      prefs: {
        ...DEFAULT_PREFS,
        grid: { layout: "two", lastMultiLayout: "two", panes: ["tab-1", "tab-2"] },
      },
      activeTabId: "tab-3",
    });

    await useAppStore.getState().activateTab("tab-2");

    expect(
      gridMode({
        layout: useAppStore.getState().prefs.grid.layout,
        panes: useAppStore.getState().prefs.grid.panes,
        activeTabId: useAppStore.getState().activeTabId,
      }),
    ).toBe("grid");
  });

  it("goes solo when a tab no pane holds is activated", async () => {
    resetStore({
      prefs: {
        ...DEFAULT_PREFS,
        grid: { layout: "two", lastMultiLayout: "two", panes: ["tab-1", "tab-2"] },
      },
      tabs: [tab(), tab({ id: "tab-2", lastActiveAt: 2 }), tab({ id: "tab-3", lastActiveAt: 3 })],
      activeTabId: "tab-1",
    });

    await useAppStore.getState().activateTab("tab-3");

    expect(
      gridMode({
        layout: useAppStore.getState().prefs.grid.layout,
        panes: useAppStore.getState().prefs.grid.panes,
        activeTabId: useAppStore.getState().activeTabId,
      }),
    ).toBe("solo");
  });

  it("is always solo for a single layout", async () => {
    resetStore({ activeTabId: "tab-1" });

    await useAppStore.getState().activateTab("tab-2");

    expect(
      gridMode({
        layout: useAppStore.getState().prefs.grid.layout,
        panes: useAppStore.getState().prefs.grid.panes,
        activeTabId: useAppStore.getState().activeTabId,
      }),
    ).toBe("solo");
  });

  it("keeps the grid after clearing the focused pane", async () => {
    resetStore({
      prefs: {
        ...DEFAULT_PREFS,
        grid: { layout: "two", lastMultiLayout: "two", panes: ["tab-1", null] },
      },
      activeTabId: "tab-1",
    });

    await useAppStore.getState().assignPaneTab(0, null);

    expect(useAppStore.getState().activeTabId).toBeNull();
    expect(
      gridMode({
        layout: useAppStore.getState().prefs.grid.layout,
        panes: useAppStore.getState().prefs.grid.panes,
        activeTabId: useAppStore.getState().activeTabId,
      }),
    ).toBe("grid");
  });
});

describe("applyTabs", () => {
  it("clears a pane whose tab closed and persists it once", () => {
    const { bridge } = installBridge();
    const setPrefs = vi.spyOn(bridge.prefs, "set");
    resetStore({
      prefs: {
        ...DEFAULT_PREFS,
        grid: { layout: "two", lastMultiLayout: "two", panes: ["tab-1", "tab-2"] },
      },
      activeTabId: "tab-1",
    });

    useAppStore.getState().applyTabs({ tabs: [tab()], activeTabId: "tab-1" });

    expect(useAppStore.getState().prefs.grid.panes).toEqual(["tab-1", null, null, null]);
    expect(setPrefs).toHaveBeenCalledWith({
      grid: { layout: "two", lastMultiLayout: "two", panes: ["tab-1", null, null, null] },
    });
    expect(setPrefs).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when no pane referenced a closed tab", () => {
    const { bridge } = installBridge();
    const setPrefs = vi.spyOn(bridge.prefs, "set");
    resetStore({
      prefs: {
        ...DEFAULT_PREFS,
        grid: { layout: "two", lastMultiLayout: "two", panes: ["tab-1", null] },
      },
      tabs: [tab(), tab({ id: "tab-2", lastActiveAt: 2 })],
      activeTabId: "tab-1",
    });

    useAppStore.getState().applyTabs({ tabs: [tab()], activeTabId: "tab-1" });

    expect(setPrefs).not.toHaveBeenCalled();
  });

  it("does not strand a newly created tab in a grid it is not shown in", () => {
    resetStore({
      prefs: {
        ...DEFAULT_PREFS,
        grid: { layout: "two", lastMultiLayout: "two", panes: ["tab-1", "tab-2"] },
      },
      activeTabId: "tab-1",
    });

    useAppStore.getState().applyTabs({
      tabs: [tab(), tab({ id: "tab-2", lastActiveAt: 2 }), tab({ id: "tab-3", lastActiveAt: 3 })],
      activeTabId: "tab-3",
    });

    expect(
      gridMode({
        layout: useAppStore.getState().prefs.grid.layout,
        panes: useAppStore.getState().prefs.grid.panes,
        activeTabId: useAppStore.getState().activeTabId,
      }),
    ).toBe("solo");
  });

  it("keeps every visible pane's transcript hydrated", () => {
    resetStore({
      prefs: {
        ...DEFAULT_PREFS,
        grid: { layout: "four", lastMultiLayout: "four", panes: ["tab-1", "tab-2", null, null] },
      },
    });
    const hydrated = Object.fromEntries(
      ["tab-1", "tab-2", "tab-3", "tab-4", "tab-5", "tab-6"].map((id) => [
        id,
        { ...useAppStore.getState().transcripts[id], items: [], hydrated: true },
      ]),
    );
    const tabs = Array.from({ length: 6 }, (_, index) =>
      tab({ id: `tab-${index + 1}`, lastActiveAt: index + 1 }),
    );
    useAppStore.setState({ transcripts: hydrated as never, tabs });

    useAppStore.getState().applyTabs({ tabs, activeTabId: "tab-1" });

    const transcripts = useAppStore.getState().transcripts;
    // Both panes survive even though MAX_RETAINED_TRANSCRIPTS is 4 and there are
    // six hydrated transcripts.
    expect(transcripts["tab-1"]?.hydrated).toBe(true);
    expect(transcripts["tab-2"]?.hydrated).toBe(true);
  });
});

describe("syncVisibleTabs", () => {
  it("pushes the visible set once per change", () => {
    const { visibleTabPushes } = installBridge();
    resetStore({
      prefs: {
        ...DEFAULT_PREFS,
        grid: { layout: "two", lastMultiLayout: "two", panes: ["tab-1", "tab-2"] },
      },
    });
    const before = visibleTabPushes.length;

    useAppStore.getState().syncVisibleTabs();
    expect(visibleTabPushes.length).toBe(before + 1);
    expect(visibleTabPushes.at(-1)).toEqual(["tab-1", "tab-2"]);

    // A repeat is a no-op: the effect runs on every render.
    useAppStore.getState().syncVisibleTabs();
    expect(visibleTabPushes.length).toBe(before + 1);
  });

  it("pushes only the active tab when the active tab is not in a pane", () => {
    const { visibleTabPushes } = installBridge();
    resetStore({
      prefs: {
        ...DEFAULT_PREFS,
        grid: { layout: "two", lastMultiLayout: "two", panes: ["tab-1", "tab-2"] },
      },
      activeTabId: "tab-3",
    });

    useAppStore.getState().syncVisibleTabs();

    expect(visibleTabPushes.at(-1)).toEqual(["tab-3"]);
  });
});

describe("browseSessionsForPane", () => {
  it("assigns the resumed session to the pane that asked", async () => {
    const { bridge } = installBridge();
    const created = tab({ id: "tab-9", title: "resumed", lastActiveAt: 9 });
    (bridge.sessions as unknown as { create: unknown }).create = vi.fn(async () => ({
      tabs: [...useAppStore.getState().tabs, created],
      activeTabId: created.id,
    }));
    resetStore({
      prefs: {
        ...DEFAULT_PREFS,
        grid: { layout: "two", lastMultiLayout: "two", panes: ["tab-1", null] },
      },
    });

    await useAppStore.getState().browseSessionsForPane(1);
    expect(useAppStore.getState().sessionBrowserOpen).toBe(true);
    expect(useAppStore.getState().panePickerTarget).toBe(1);

    await useAppStore.getState().resumeSession(session("C:/profile/s9.jsonl"));

    expect(useAppStore.getState().prefs.grid.panes).toEqual(["tab-1", "tab-9", null, null]);
    expect(useAppStore.getState().panePickerTarget).toBeNull();
    expect(useAppStore.getState().activeTabId).toBe("tab-9");
  });

  it("clears the target when the browser is dismissed", async () => {
    resetStore();
    await useAppStore.getState().browseSessionsForPane(0);

    useAppStore.getState().closeSessionBrowser();

    expect(useAppStore.getState().panePickerTarget).toBeNull();
  });
});
