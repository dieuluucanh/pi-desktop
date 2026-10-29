import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_RAIL_PREFS, RAIL_MENU_IDS } from "../../src/shared/rail";
import { DEFAULT_PREFS, type UiPrefs } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * The docked panel rail's store slice.
 *
 * The strip is always mounted, so the click it produces has to be exactly one of
 * three things: switch menus, expand the same menu, or collapse it. The other
 * half of the contract is the write: `prefs.rail` has one writer, and it must
 * only write when something actually changed — dragging a strip entry across its
 * own drop target should not churn `app-state.json`.
 */

const PROJECT = "/work/app";

let prefs: UiPrefs;
let set: ReturnType<typeof vi.fn>;

function resetStore(rail: Partial<typeof DEFAULT_RAIL_PREFS> = {}): void {
  prefs = { ...DEFAULT_PREFS, rail: { ...DEFAULT_RAIL_PREFS, ...rail } };
  const bridge = installBridge();
  set = vi.fn(async (patch: Partial<UiPrefs>) => {
    Object.assign(prefs, patch);
    return { ...prefs };
  });
  (window.pi as unknown as { prefs: { set: unknown } }).prefs.set = set;
  useAppStore.setState({
    prefs,
    project: { path: PROJECT, name: "app" },
    checkpoints: {},
    checkpointsError: null,
    officeDocuments: bridge ? useAppStore.getState().officeDocuments : null,
  });
}

beforeEach(() => {
  resetStore();
});

describe("clicking a strip entry", () => {
  it("opens the collapsed panel on that menu", () => {
    useAppStore.getState().toggleRailMenu("checkpoints");
    const rail = useAppStore.getState().prefs.rail;
    expect(rail.open).toBe(true);
    expect(rail.activeMenu).toBe("checkpoints");
  });

  it("collapses when the active, open entry is clicked again", () => {
    resetStore({ open: true, activeMenu: "checkpoints" });
    useAppStore.getState().toggleRailMenu("checkpoints");
    const rail = useAppStore.getState().prefs.rail;
    expect(rail.open).toBe(false);
    // The menu is remembered, so reopening returns to the same body.
    expect(rail.activeMenu).toBe("checkpoints");
  });

  it("switches menus without collapsing when another entry is clicked", () => {
    resetStore({ open: true, activeMenu: "source-control" });
    useAppStore.getState().toggleRailMenu("documents");
    const rail = useAppStore.getState().prefs.rail;
    expect(rail.open).toBe(true);
    expect(rail.activeMenu).toBe("documents");
  });

  it("re-opens a collapsed panel on its remembered menu when that entry is clicked", () => {
    resetStore({ open: false, activeMenu: "documents" });
    useAppStore.getState().toggleRailMenu("documents");
    const rail = useAppStore.getState().prefs.rail;
    expect(rail.open).toBe(true);
    expect(rail.activeMenu).toBe("documents");
  });

  it("writes the whole rail object, so the nested merge keeps the rest", () => {
    resetStore({ open: false, width: 420, activeMenu: "source-control" });
    useAppStore.getState().toggleRailMenu("checkpoints");
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]?.[0]).toEqual({
      rail: { open: true, activeMenu: "checkpoints", width: 420, order: [...RAIL_MENU_IDS] },
    });
  });
});

describe("opening a menu from the menu bar", () => {
  it("expands without toggling, even when that menu is already open", () => {
    resetStore({ open: true, activeMenu: "checkpoints" });
    useAppStore.getState().openRailMenu("checkpoints");
    expect(set).not.toHaveBeenCalled();
  });

  it("switches the body when another menu is requested", () => {
    resetStore({ open: true, activeMenu: "checkpoints" });
    useAppStore.getState().openRailMenu("source-control");
    const rail = useAppStore.getState().prefs.rail;
    expect(rail.open).toBe(true);
    expect(rail.activeMenu).toBe("source-control");
  });

  it("expands a collapsed panel without changing the remembered menu elsewhere", () => {
    resetStore({ open: false, activeMenu: "documents" });
    useAppStore.getState().openRailMenu("source-control");
    const rail = useAppStore.getState().prefs.rail;
    expect(rail.open).toBe(true);
    expect(rail.activeMenu).toBe("source-control");
  });
});

describe("toggling the panel body", () => {
  it("flips only `open`, keeping the remembered menu", () => {
    resetStore({ open: false, activeMenu: "checkpoints" });
    useAppStore.getState().toggleRail();
    expect(useAppStore.getState().prefs.rail).toMatchObject({
      open: true,
      activeMenu: "checkpoints",
    });
    useAppStore.getState().toggleRail();
    expect(useAppStore.getState().prefs.rail).toMatchObject({
      open: false,
      activeMenu: "checkpoints",
    });
  });

  it("does not write when the state already matches", () => {
    resetStore({ open: true });
    useAppStore.getState().setRailOpen(true);
    expect(set).not.toHaveBeenCalled();
  });
});

describe("strip order", () => {
  it("persists an adjusted order", () => {
    useAppStore.getState().setRailMenuOrder(["checkpoints", "source-control", "documents"]);
    expect(useAppStore.getState().prefs.rail.order).toEqual([
      "checkpoints",
      "source-control",
      "documents",
    ]);
  });

  it("completes a short order instead of losing menus", () => {
    useAppStore.getState().setRailMenuOrder(["documents"]);
    expect(useAppStore.getState().prefs.rail.order).toEqual([
      "documents",
      "source-control",
      "checkpoints",
    ]);
  });

  it("does not write when the order is unchanged", () => {
    useAppStore.getState().setRailMenuOrder([...RAIL_MENU_IDS]);
    expect(set).not.toHaveBeenCalled();
  });
});

describe("rail width", () => {
  it("clamps and persists a dragged width", () => {
    useAppStore.getState().setRailWidth(4_000);
    expect(useAppStore.getState().prefs.rail.width).toBe(560);
  });

  it("does not write when the width is unchanged", () => {
    resetStore({ width: 320 });
    useAppStore.getState().setRailWidth(320);
    expect(set).not.toHaveBeenCalled();
  });
});

describe("checkpoint seeding for the strip badge", () => {
  it("reads a folder once automatically; the explicit refresh is the forced read", async () => {
    const calls: string[] = [];
    const view = (path: string) => ({
      available: false,
      reason: "run_snapshots_unavailable",
      enabled: false,
      projectPath: path,
      checkpoints: [],
    });
    (window.pi as unknown as { checkpoints: { get: unknown; refresh: unknown } }).checkpoints.get =
      async (path: string) => {
        calls.push(`get:${path}`);
        return view(path);
      };
    (
      window.pi as unknown as { checkpoints: { get: unknown; refresh: unknown } }
    ).checkpoints.refresh = async (path: string) => {
      calls.push(`refresh:${path}`);
      return view(path);
    };

    await useAppStore.getState().loadCheckpoints(PROJECT);
    await useAppStore.getState().loadCheckpoints(PROJECT);
    expect(calls).toEqual([`get:${PROJECT}`]);

    await useAppStore.getState().refreshCheckpoints(PROJECT);
    expect(calls).toEqual([`get:${PROJECT}`, `refresh:${PROJECT}`]);
  });
});
