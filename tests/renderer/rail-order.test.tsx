import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { RightRail, type RailMenuSpec } from "../../src/renderer/src/rail/RightRail";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_RAIL_PREFS, RAIL_MENU_IDS, type RailPrefs } from "../../src/shared/rail";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * The strip's user-adjustable order.
 *
 * The order is a persisted preference, so both paths to it — a drag and the
 * per-entry menu — have to end in the same sanitized write. The menu is also the
 * accessible path, which is why it is exercised without a pointer drag: a
 * keyboard user must be able to reorder the strip too.
 *
 * Radix opens a dropdown on a *mouse* pointerdown; jsdom has no real pointer, so
 * the tests dispatch the event Radix actually listens for (the technique
 * `tab-strip.test.tsx` established) and then assert the `body` pointer-events
 * lock did not survive the menu.
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

/** Opens the inline reorder list for one entry. */
function openReorderMenu(id: string): void {
  fireEvent.click(screen.getByTestId(`rail-order-${id}`));
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

describe("the per-entry reorder menu", () => {
  it("moves an entry up, down and to the top", async () => {
    render(<RightRail menus={menus()} />);

    openReorderMenu("checkpoints");
    await waitFor(() => expect(screen.getByText("Move up")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Move up"));
    await waitFor(() =>
      expect(useAppStore.getState().prefs.rail.order).toEqual([
        "checkpoints",
        "source-control",
        "documents",
      ]),
    );

    openReorderMenu("checkpoints");
    await waitFor(() => expect(screen.getByText("Move down")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Move down"));
    await waitFor(() =>
      expect(useAppStore.getState().prefs.rail.order).toEqual([
        "source-control",
        "checkpoints",
        "documents",
      ]),
    );

    openReorderMenu("documents");
    await waitFor(() => expect(screen.getByText("Move to top")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Move to top"));
    await waitFor(() =>
      expect(useAppStore.getState().prefs.rail.order).toEqual([
        "documents",
        "source-control",
        "checkpoints",
      ]),
    );
  });

  it("disables the moves that would leave the strip", async () => {
    render(<RightRail menus={menus()} />);

    openReorderMenu("source-control");
    await waitFor(() => expect(screen.getByText("Move up")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Move up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move to top" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move down" })).toBeEnabled();
  });

  it("disables Move down for the last entry", async () => {
    render(<RightRail menus={menus()} />);
    openReorderMenu("documents");
    await waitFor(() => expect(screen.getByText("Move down")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Move down" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move up" })).toBeEnabled();
  });

  it("restores the canonical order", async () => {
    setRail({
      open: true,
      activeMenu: "checkpoints",
      order: ["checkpoints", "documents", "source-control"],
    });
    render(<RightRail menus={menus()} />);

    openReorderMenu("checkpoints");
    await waitFor(() => expect(screen.getByText("Reset order")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Reset order"));

    await waitFor(() =>
      expect(useAppStore.getState().prefs.rail.order).toEqual([...RAIL_MENU_IDS]),
    );
    expect(stripOrder()).toEqual([...RAIL_MENU_IDS]);
  });

  it("leaves no pointer-events lock on the body", async () => {
    render(<RightRail menus={menus()} />);
    openReorderMenu("checkpoints");
    await waitFor(() => expect(screen.getByText("Move up")).toBeInTheDocument());
    fireEvent.keyDown(document, { key: "Escape" });
    // A surviving lock poisons every later interaction in the window (a real bug
    // this repo hit before), so the menu must not leave one behind.
    await waitFor(() => expect(document.body.style.pointerEvents).not.toBe("none"));
  });

  it("keeps the strip fully reachable after a reorder", async () => {
    render(<RightRail menus={menus()} />);
    openReorderMenu("documents");
    await waitFor(() => expect(screen.getByText("Move to top")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Move to top"));
    await waitFor(() => expect(stripOrder()[0]).toBe("documents"));

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
