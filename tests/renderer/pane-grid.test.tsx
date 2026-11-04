import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { useAppStore, type AppStateShape } from "../../src/renderer/src/state/app-store";
import { PaneGrid } from "../../src/renderer/src/layout/PaneGrid";
import { panePickerModel } from "../../src/renderer/src/layout/PanePicker";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { GridLayout } from "../../src/shared/session-grid";
import { TAB_DRAG_MIME, TAB_DRAG_VERSION } from "../../src/shared/tab-drag";
import type { TabRecord } from "../../src/shared/session-ipc";
import { installBridge } from "./fixtures";

/**
 * The session view grid (2026-11-03 plan step 10).
 *
 * The grid is the content area's only multi-tab surface: presets, one pane per
 * tab, a chevron picker classified by session/editor, and drag-and-drop from the
 * strips. Everything it decides about layout lives in `shared/session-grid.ts`,
 * so these tests are about wiring, not geometry.
 */

const WORK = "C:/work/app";
const OTHER = "C:/work/other";

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

function editorTab(id: string, title: string): TabRecord {
  return tab({
    id,
    kind: "editor",
    title,
    filePath: title,
    sessionFile: null,
    lastActiveAt: 5,
  });
}

function setGrid(
  layout: GridLayout,
  panes: (string | null)[],
  extra: Partial<AppStateShape> = {},
): void {
  useAppStore.setState({
    prefs: {
      ...DEFAULT_PREFS,
      drafts: {},
      grid: { layout, lastMultiLayout: layout === "single" ? "two" : layout, panes },
    },
    panePickerTarget: null,
    hint: null,
    ...extra,
  });
}

function fakeTabDrop(tabId: string) {
  return {
    types: [TAB_DRAG_MIME],
    files: [] as File[],
    dropEffect: "none",
    effectAllowed: "none",
    getData: (type: string) =>
      type === TAB_DRAG_MIME ? JSON.stringify({ version: TAB_DRAG_VERSION, tabId }) : "",
    setData: () => undefined,
  };
}

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    view: "session",
    project: { path: WORK, name: "app" },
    projects: [],
    projectsLoaded: true,
    tabs: [
      tab(),
      tab({ id: "tab-2", title: "second", lastActiveAt: 2 }),
      tab({ id: "tab-3", title: "other project", cwd: OTHER, lastActiveAt: 3 }),
      editorTab("editor-1", "a.ts"),
    ],
    activeTabId: "tab-1",
    transcripts: {},
    sessionStates: {},
    extensionUi: {},
    tuiSurfaces: {},
  });
  setGrid("two", ["tab-1", null]);
});

describe("layouts", () => {
  it.each([
    ["single", 1],
    ["two", 2],
    ["three-left", 3],
    ["three-right", 3],
    ["four", 4],
  ] as const)("renders %s as %i panes", (layout, count) => {
    setGrid(layout, []);
    render(<PaneGrid />);

    expect(screen.getByTestId("pane-grid")).toHaveAttribute("data-layout", layout);
    expect(screen.getAllByRole("region", { hidden: true }).length).toBeGreaterThanOrEqual(count);
    for (let index = 0; index < count; index += 1) {
      expect(screen.getByTestId(`pane-${index}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId(`pane-${count}`)).toBeNull();
  });

  it("places the tall pane on the correct column with explicit starts", () => {
    setGrid("three-left", ["tab-1", "tab-2", null]);
    const { unmount } = render(<PaneGrid />);
    expect(screen.getByTestId("pane-0").className).toContain("col-start-1");
    expect(screen.getByTestId("pane-0").className).toContain("row-span-2");
    expect(screen.getByTestId("pane-1").className).toContain("col-start-2");
    expect(screen.getByTestId("pane-1").className).toContain("row-start-1");
    expect(screen.getByTestId("pane-1").className).not.toContain("row-span-2");
    expect(screen.getByTestId("pane-2").className).toContain("row-start-2");
    unmount();

    setGrid("three-right", ["tab-1", "tab-2", null]);
    render(<PaneGrid />);
    expect(screen.getByTestId("pane-0").className).toContain("col-start-1");
    expect(screen.getByTestId("pane-0").className).not.toContain("row-span-2");
    expect(screen.getByTestId("pane-1").className).toContain("col-start-2");
    expect(screen.getByTestId("pane-1").className).toContain("row-span-2");
    expect(screen.getByTestId("pane-2").className).toContain("col-start-1");
    expect(screen.getByTestId("pane-2").className).toContain("row-start-2");
  });
});

describe("panes", () => {
  it("shows a placeholder for an empty pane", () => {
    render(<PaneGrid />);

    const empty = screen.getByTestId("pane-1");
    expect(within(empty).getByText("Pick a session")).toBeInTheDocument();
    expect(within(empty).getByText(/drop a tab here/i)).toBeInTheDocument();
  });

  it("renders each pane's own tab, not the selected one", () => {
    setGrid("two", ["tab-2", "tab-3"]);
    render(<PaneGrid />);

    expect(screen.getByRole("heading", { name: "second" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "other project" })).toBeInTheDocument();
  });

  it("focuses a pane's tab on pointer-down", () => {
    setGrid("two", ["tab-1", "tab-2"]);
    render(<PaneGrid />);

    fireEvent.pointerDown(within(screen.getByTestId("pane-1")).getByTestId("session-view"));

    expect(useAppStore.getState().activeTabId).toBe("tab-2");
  });

  it("marks only the focused pane", () => {
    setGrid("two", ["tab-1", "tab-2"], { activeTabId: "tab-2" });
    render(<PaneGrid />);

    expect(screen.getByTestId("pane-0")).not.toHaveAttribute("data-pane-active");
    expect(screen.getByTestId("pane-1")).toHaveAttribute("data-pane-active", "true");
  });

  it("clears a pane from its header", async () => {
    setGrid("two", ["tab-1", "tab-2"]);
    render(<PaneGrid />);

    await userEvent.click(screen.getByRole("button", { name: "Clear pane 2" }));

    expect(useAppStore.getState().prefs.grid.panes).toEqual(["tab-1", null, null, null]);
    expect(useAppStore.getState().activeTabId).toBe("tab-1");
    expect(within(screen.getByTestId("pane-1")).getByText("Pick a session")).toBeInTheDocument();
  });

  it("clears the focused pane, keeps the grid and focuses the survivor", async () => {
    setGrid("two", ["tab-1", "tab-2"], { activeTabId: "tab-2" });
    render(<PaneGrid />);

    await userEvent.click(screen.getByRole("button", { name: "Clear pane 2" }));

    expect(useAppStore.getState().prefs.grid.panes).toEqual(["tab-1", null, null, null]);
    expect(useAppStore.getState().activeTabId).toBe("tab-1");
    expect(screen.getByTestId("pane-grid")).toBeInTheDocument();
    expect(screen.getByTestId("pane-0")).toHaveAttribute("data-pane-active", "true");
  });

  it("does not change focus when clearing a background pane", async () => {
    setGrid("two", ["tab-1", "tab-2"], { activeTabId: "tab-1" });
    render(<PaneGrid />);

    await userEvent.click(screen.getByRole("button", { name: "Clear pane 2" }));

    expect(useAppStore.getState().activeTabId).toBe("tab-1");
    expect(screen.getByTestId("pane-0")).toHaveAttribute("data-pane-active", "true");
  });
});

describe("pane picker model", () => {
  const tabsFixture = (): TabRecord[] => useAppStore.getState().tabs;

  it("classifies open tabs into session groups and an editor group", () => {
    const model = panePickerModel(tabsFixture(), ["tab-1", null], null, "two");

    // One group per project, titled by the folder's own name, in tab order.
    expect(model.sessions.map((group) => group.name)).toEqual(["app", "other"]);
    expect(model.sessions[0]!.tabs.map((tab) => tab.id)).toEqual(["tab-1", "tab-2"]);
    expect(model.sessions[1]!.tabs.map((tab) => tab.id)).toEqual(["tab-3"]);
    expect(model.editors.map((tab) => tab.id)).toEqual(["editor-1"]);
    expect(model.editors[0]!.filePath).toBe("a.ts");
  });

  it("marks the pane's own tab and hints the panes holding the others", () => {
    const model = panePickerModel(tabsFixture(), ["tab-1", "tab-2"], "tab-1", "two");

    const [first, second] = model.sessions[0]!.tabs;
    expect(first).toMatchObject({ id: "tab-1", current: true, paneHint: null });
    // Choosing tab-2 in another pane swaps the two slots.
    expect(second).toMatchObject({ id: "tab-2", current: false, paneHint: "pane 2" });
  });

  it("skips a session tab with no project folder", () => {
    const homeless = tab({ id: "tab-x", cwd: "", title: "no folder" });
    const model = panePickerModel([...tabsFixture(), homeless], [], null, "two");

    expect(model.sessions.flatMap((group) => group.tabs.map((tab) => tab.id))).not.toContain(
      "tab-x",
    );
  });

  it("does not hint a tab held only in a hidden slot", () => {
    const model = panePickerModel(tabsFixture(), ["tab-1", "tab-2", "tab-3", null], "tab-1", "two");

    const hidden = model.sessions[1]!.tabs[0];
    expect(hidden).toMatchObject({ id: "tab-3", current: false, paneHint: null });
  });

  it("is empty when nothing is open", () => {
    const model = panePickerModel([], [], null, "two");
    expect(model.sessions).toEqual([]);
    expect(model.editors).toEqual([]);
  });
});

describe("pane picker", () => {
  it("opens the same picker from the empty-pane plus", async () => {
    setGrid("two", ["tab-1", null]);
    render(<PaneGrid />);

    const trigger = screen.getByTestId("pane-empty-picker-1");
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");

    await userEvent.click(trigger);

    expect(await screen.findByTestId("pane-pick-tab-2")).toBeInTheDocument();
    expect(screen.getByTestId("pane-browse-1")).toBeInTheDocument();
    expect(screen.getAllByTestId("pane-picker-menu-1")).toHaveLength(1);
  });

  it("does not open from the placeholder text or empty background", async () => {
    setGrid("two", ["tab-1", null]);
    render(<PaneGrid />);

    await userEvent.click(screen.getByText("Pick a session"));
    await userEvent.click(screen.getByText(/drop a tab here/i));
    await userEvent.click(screen.getByTestId("pane-1"));

    expect(screen.queryByTestId("pane-pick-tab-2")).not.toBeInTheDocument();
  });

  it("opens the same menu from the header chevron", async () => {
    setGrid("two", ["tab-1", null]);
    render(<PaneGrid />);

    const trigger = screen.getByTestId("pane-picker-1");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });

    expect(await screen.findByTestId("pane-pick-tab-2")).toBeInTheDocument();
    expect(screen.getByTestId("pane-picker-menu-1")).toHaveAttribute("id", "pane-picker-content-1");
  });

  it("renders a chevron in every pane header", () => {
    setGrid("two", ["tab-1", null]);
    render(<PaneGrid />);

    expect(screen.getByTestId("pane-picker-0")).toHaveAttribute(
      "aria-label",
      "Choose a tab for pane 1",
    );
    expect(screen.getByTestId("pane-picker-1")).toBeInTheDocument();
  });

  it("arms the pane for “Browse saved sessions…”", async () => {
    setGrid("two", ["tab-1", null]);

    await useAppStore.getState().browseSessionsForPane(1);

    expect(useAppStore.getState().panePickerTarget).toBe(1);
    expect(useAppStore.getState().sessionBrowserOpen).toBe(true);
  });
});

describe("drag and drop", () => {
  it("fills a pane from a dragged tab", () => {
    setGrid("two", ["tab-1", null]);
    render(<PaneGrid />);

    const pane = screen.getByTestId("pane-1");
    fireEvent.dragEnter(pane, { dataTransfer: fakeTabDrop("tab-2") });
    expect(pane).toHaveAttribute("data-drop-active", "true");

    fireEvent.drop(pane, { dataTransfer: fakeTabDrop("tab-2") });

    expect(useAppStore.getState().prefs.grid.panes).toEqual(["tab-1", "tab-2", null, null]);
    expect(pane).not.toHaveAttribute("data-drop-active");
  });

  it("swaps when the dragged tab is already shown elsewhere", () => {
    setGrid("two", ["tab-1", "tab-2"]);
    render(<PaneGrid />);

    fireEvent.drop(screen.getByTestId("pane-1"), { dataTransfer: fakeTabDrop("tab-1") });

    expect(useAppStore.getState().prefs.grid.panes).toEqual(["tab-2", "tab-1", null, null]);
  });

  it("ignores a workspace-file drag", () => {
    setGrid("two", ["tab-1", null]);
    render(<PaneGrid />);

    const pane = screen.getByTestId("pane-1");
    const fileDrag = {
      types: ["application/x-pi-workspace-path"],
      files: [],
      dropEffect: "none",
      effectAllowed: "none",
      getData: () => "",
      setData: () => undefined,
    };
    fireEvent.dragEnter(pane, { dataTransfer: fileDrag });
    fireEvent.drop(pane, { dataTransfer: fileDrag });

    expect(pane).not.toHaveAttribute("data-drop-active");
    expect(useAppStore.getState().prefs.grid.panes).toEqual(["tab-1", null]);
  });
});
