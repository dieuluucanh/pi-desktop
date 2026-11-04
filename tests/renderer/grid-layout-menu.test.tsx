import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "../../src/renderer/src/state/app-store";
import { GridLayoutMenu, gridLayoutChoices } from "../../src/renderer/src/layout/GridLayoutMenu";
import { SessionTabStrip } from "../../src/renderer/src/layout/SessionTabStrip";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { GRID_LAYOUT_LABELS } from "../../src/shared/session-grid";
import type { TabRecord } from "../../src/shared/session-ipc";
import { installBridge } from "./fixtures";

/**
 * The layout switcher (2026-11-03 plan step 13).
 *
 * It sits at the far right of the session strip, which is always mounted — the
 * editor row would have hidden it whenever no file was open. The items are a pure
 * model (`gridLayoutChoices`) so the labels and the checked preset are pinned
 * without opening a Radix menu in jsdom.
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
    prefs: {
      ...DEFAULT_PREFS,
      drafts: {},
      grid: { layout: "single", lastMultiLayout: "two", panes: [null] },
    },
    tabs: [tab("tab-1", "first")],
    activeTabId: "tab-1",
    hint: null,
  });
});

describe("gridLayoutChoices", () => {
  it("lists every preset widest-first and checks the current one", () => {
    const choices = gridLayoutChoices("three-right");

    expect(choices.map((choice) => choice.layout)).toEqual([
      "four",
      "three-right",
      "three-left",
      "two",
      "single",
    ]);
    expect(choices.map((choice) => choice.label)).toEqual(
      choices.map((choice) => GRID_LAYOUT_LABELS[choice.layout]),
    );
    expect(choices.filter((choice) => choice.checked).map((choice) => choice.layout)).toEqual([
      "three-right",
    ]);
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

  it("shows icon-only choices with distinct three-pane icons", async () => {
    render(<GridLayoutMenu />);
    const trigger = screen.getByTestId("grid-layout-menu");
    expect(trigger.querySelector('[data-icon="square"]')).not.toBeNull();

    await userEvent.click(trigger);

    const items = await screen.findAllByRole("menuitemradio");
    expect(items.map((item) => item.getAttribute("data-testid"))).toEqual([
      "grid-layout-four",
      "grid-layout-three-right",
      "grid-layout-three-left",
      "grid-layout-two",
      "grid-layout-single",
    ]);

    const left = await screen.findByTestId("grid-layout-three-left");
    const right = screen.getByTestId("grid-layout-three-right");
    expect(left.querySelector('[data-icon="panels-left-bottom"]')).not.toBeNull();
    expect(right.querySelector('[data-icon="panels-right-bottom"]')).not.toBeNull();
    expect(left).toHaveAccessibleName(GRID_LAYOUT_LABELS["three-left"]);
    expect(right).toHaveAccessibleName(GRID_LAYOUT_LABELS["three-right"]);
    expect(left).toHaveAttribute("aria-checked", "false");

    // No visible wording: labels exist only as accessible names/tooltips.
    expect(screen.queryByText("Layout")).toBeNull();
    expect(screen.queryByText("Two columns")).toBeNull();

    await userEvent.click(screen.getByTestId("grid-layout-four"));
    expect(useAppStore.getState().prefs.grid.layout).toBe("four");
  });
});
