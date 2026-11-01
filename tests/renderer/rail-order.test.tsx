import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { RightRail, type RailMenuSpec } from "../../src/renderer/src/rail/RightRail";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_RAIL_PREFS, RAIL_MENU_IDS, type RailPrefs } from "../../src/shared/rail";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * The strip's user-adjustable order.
 *
 * Reordering is native drag-and-drop only: the per-entry ⋯ menu was removed on
 * 2026-11-01 as unused chrome, so the tests cover the drag path and guard that
 * the menu does not come back.
 */

function menus(): RailMenuSpec[] {
  return [
    { id: "source-control", content: <p>changes body</p> },
    { id: "checkpoints", content: <p>checkpoints body</p> },
    { id: "documents", content: <p>documents body</p> },
  ];
}

function setRail(overrides: Partial<RailPrefs> = {}): void {
  const rail: RailPrefs = {
    ...DEFAULT_RAIL_PREFS,
    ...overrides,
    order: overrides.order ? [...overrides.order] : [...DEFAULT_RAIL_PREFS.order],
  };
  useAppStore.setState({ prefs: { ...DEFAULT_PREFS, drafts: {}, rail } });
}

function stripOrder(): string[] {
  return [
    ...screen.getByTestId("rail-strip").querySelectorAll<HTMLElement>("[data-rail-menu]"),
  ].map((node) => node.getAttribute("data-rail-menu") ?? "");
}

beforeEach(() => {
  installBridge();
  setRail({ open: true, activeMenu: "source-control" });
});

describe("drag and drop", () => {
  it("persists an entry dropped at another position", () => {
    render(<RightRail menus={menus()} />);
    fireEvent.dragStart(screen.getByTestId("rail-menu-documents"));
    fireEvent.dragOver(screen.getByTestId("rail-menu-source-control"));
    fireEvent.drop(screen.getByTestId("rail-menu-source-control"));

    expect(useAppStore.getState().prefs.rail.order).toEqual([
      "documents",
      "source-control",
      "checkpoints",
    ]);
    expect(stripOrder()).toEqual(["documents", "source-control", "checkpoints"]);
  });

  it("moves an entry down the strip", () => {
    render(<RightRail menus={menus()} />);
    fireEvent.dragStart(screen.getByTestId("rail-menu-source-control"));
    fireEvent.drop(screen.getByTestId("rail-menu-documents"));
    expect(useAppStore.getState().prefs.rail.order).toEqual([
      "checkpoints",
      "documents",
      "source-control",
    ]);
  });

  it("ignores a drop on the dragged entry itself", () => {
    render(<RightRail menus={menus()} />);
    fireEvent.dragStart(screen.getByTestId("rail-menu-checkpoints"));
    fireEvent.drop(screen.getByTestId("rail-menu-checkpoints"));
    expect(useAppStore.getState().prefs.rail.order).toEqual([...RAIL_MENU_IDS]);
  });
});

describe("reorder chrome", () => {
  it("renders no per-entry reorder menu", () => {
    render(<RightRail menus={menus()} />);
    expect(screen.queryByRole("button", { name: /^Reorder / })).toBeNull();
    expect(screen.queryByTestId("rail-order-source-control")).toBeNull();
    expect(screen.queryByTestId("rail-order-list-source-control")).toBeNull();
  });

  it("keeps the strip fully reachable after a reorder", () => {
    render(<RightRail menus={menus()} />);
    fireEvent.dragStart(screen.getByTestId("rail-menu-documents"));
    fireEvent.drop(screen.getByTestId("rail-menu-source-control"));
    expect(stripOrder()[0]).toBe("documents");

    // One tab stop: it follows the active entry (Source Control), not the new
    // first entry — position and selection are different things.
    expect(screen.getByTestId("rail-menu-source-control")).toHaveAttribute("tabindex", "0");
    expect(screen.getByTestId("rail-menu-documents")).toHaveAttribute("tabindex", "-1");
    // The arrows walk every entry in the new order from wherever focus is.
    const first = screen.getByTestId("rail-menu-documents");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(screen.getByTestId("rail-menu-source-control")).toHaveFocus();
    fireEvent.keyDown(screen.getByTestId("rail-menu-source-control"), { key: "ArrowDown" });
    expect(screen.getByTestId("rail-menu-checkpoints")).toHaveFocus();
  });
});

describe("an order that is only partly available", () => {
  it("reorders within the strip without dropping the hidden menu", () => {
    // Documents is unavailable here, but it stays in the persisted order, so the
    // entry comes back exactly where the user put it.
    render(<RightRail menus={menus().filter((menu) => menu.id !== "documents")} />);
    fireEvent.dragStart(screen.getByTestId("rail-menu-checkpoints"));
    fireEvent.drop(screen.getByTestId("rail-menu-source-control"));

    expect(useAppStore.getState().prefs.rail.order).toEqual([
      "checkpoints",
      "source-control",
      "documents",
    ]);
    expect(stripOrder()).toEqual(["checkpoints", "source-control"]);
  });
});
