import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "../../src/renderer/src/state/app-store";
import {
  GridLayoutMenu,
  gridLayoutChoices,
  gridViewToggle,
} from "../../src/renderer/src/layout/GridLayoutMenu";
import { SessionTabStrip } from "../../src/renderer/src/layout/SessionTabStrip";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { GRID_LAYOUT_LABELS, GRID_LAYOUTS } from "../../src/shared/session-grid";
import type { TabRecord } from "../../src/shared/session-ipc";
import { installBridge } from "./fixtures";

/**
 * The layout switcher (2026-11-03 plan step 13).
 *
 * It sits at the far right of the session strip, which is always mounted — the
 * editor row would have hidden it whenever no file was open. The items are a pure
 * model (`gridLayoutChoices`, `gridViewToggle`) so the labels, the checked preset
 * and the enablement are pinned without opening a Radix menu in jsdom.
 */

const WORK = "C:/work/app";

function tab(id: string, title: string, lastActiveAt = 1): TabRecord {
  return {
    id,
    kind: "session",
    cwd: WORK,
    title,
    sessionFile: null,
    status: "idle",
    createdAt: lastActiveAt,
    lastActiveAt,
    model: null,
  };
}

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    view: "session",
    project: { path: WORK, name: "app" },
    prefs: { ...DEFAULT_PREFS, drafts: {}, grid: { layout: "single", panes: [null] } },
    tabs: [tab("tab-1", "first")],
    activeTabId: "tab-1",
    gridSolo: false,
    hint: null,
  });
});

describe("gridLayoutChoices", () => {
  it("lists every preset with its label, checking the current one", () => {
    const choices = gridLayoutChoices("three-right");

    expect(choices.map((choice) => choice.layout)).toEqual([...GRID_LAYOUTS]);
    expect(choices.map((choice) => choice.label)).toEqual(
      GRID_LAYOUTS.map((layout) => GRID_LAYOUT_LABELS[layout]),
    );
    expect(choices.filter((choice) => choice.checked).map((choice) => choice.layout)).toEqual([
      "three-right",
    ]);
  });
});

describe("gridViewToggle", () => {
  it("is disabled for the single layout, which is always solo", () => {
    expect(gridViewToggle("solo", "single")).toEqual({
      id: "show-grid",
      label: "Show single tab",
      disabled: true,
    });
  });

  it("offers solo while the grid is on screen", () => {
    expect(gridViewToggle("grid", "two")).toEqual({
      id: "show-solo",
      label: "Show single tab",
      disabled: false,
    });
  });

  it("offers the grid while a hidden tab is solo", () => {
    expect(gridViewToggle("solo", "four")).toEqual({
      id: "show-grid",
      label: "Show grid",
      disabled: false,
    });
  });
});

describe("the strip control", () => {
  it("renders the switcher at the far right of the session strip", () => {
    render(<SessionTabStrip />);

    const trigger = screen.getByTestId("grid-layout-menu");
    expect(trigger).toHaveAttribute("aria-label", "Grid layout");
    expect(trigger).toHaveAttribute("data-layout", "single");
    // The strip keeps its own actions: `+` is still there, immediately left of it.
    expect(screen.getByRole("button", { name: "New session" })).toBeInTheDocument();
  });

  it("reflects a layout change", () => {
    const { rerender } = render(<SessionTabStrip />);
    expect(screen.getByTestId("grid-layout-menu")).toHaveAttribute("data-layout", "single");

    useAppStore.getState().setGridLayout("four");
    rerender(<SessionTabStrip />);

    expect(screen.getByTestId("grid-layout-menu")).toHaveAttribute("data-layout", "four");
    expect(useAppStore.getState().prefs.grid.layout).toBe("four");
  });

  it("is reachable with no editor tabs open", () => {
    // The editor row returns null in this state; the session row must not.
    render(
      <>
        <SessionTabStrip />
        <GridLayoutMenu />
      </>,
    );

    expect(screen.getAllByTestId("grid-layout-menu")).toHaveLength(2);
    expect(screen.queryByTestId("editor-tab-strip")).toBeNull();
  });
});
