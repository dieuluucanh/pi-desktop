import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { RightRail, type RailMenuSpec } from "../../src/renderer/src/rail/RightRail";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import {
  DEFAULT_RAIL_PREFS,
  MAX_RAIL_WIDTH,
  MIN_RAIL_WIDTH,
  RAIL_MENU_IDS,
  type RailPrefs,
} from "../../src/shared/rail";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * The docked panel rail host.
 *
 * The host owns chrome only — the always-visible strip, the title row, the resize
 * handle and the scroll model — so these tests are about interaction and
 * persistence rather than git: the strip never disappears, one click on an entry
 * opens its body and a second collapses it, the body that mounts is the only one
 * that mounts, and the width a user drags is the width that is persisted.
 */

function menus(): RailMenuSpec[] {
  return [
    { id: "source-control", count: 3, content: <p>changes body</p> },
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

beforeEach(() => {
  installBridge();
  setRail({ open: false });
});

describe("the strip", () => {
  it("is visible while the panel is collapsed", () => {
    render(<RightRail menus={menus()} />);
    expect(screen.getByTestId("right-rail")).toBeInTheDocument();
    expect(screen.getByTestId("rail-strip")).toBeInTheDocument();
    // The strip is the affordance: no body, but every entry reachable.
    expect(screen.queryByTestId("rail-panel")).not.toBeInTheDocument();
    for (const id of RAIL_MENU_IDS) {
      expect(screen.getByTestId(`rail-menu-${id}`)).toBeInTheDocument();
    }
  });

  it("renders nothing at all when no menu is supplied", () => {
    render(<RightRail menus={[]} />);
    expect(screen.queryByTestId("right-rail")).not.toBeInTheDocument();
  });

  it("opens the panel on the clicked menu", async () => {
    render(<RightRail menus={menus()} />);
    await userEvent.click(screen.getByTestId("rail-menu-checkpoints"));
    expect(screen.getByTestId("rail-panel")).toBeInTheDocument();
    expect(screen.getByText("checkpoints body")).toBeInTheDocument();
    // Persisted, so a relaunch restores it.
    expect(useAppStore.getState().prefs.rail).toMatchObject({
      open: true,
      activeMenu: "checkpoints",
    });
  });

  it("collapses when the active entry is clicked again", async () => {
    setRail({ open: true, activeMenu: "checkpoints" });
    render(<RightRail menus={menus()} />);
    expect(screen.getByText("checkpoints body")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("rail-menu-checkpoints"));

    expect(screen.queryByTestId("rail-panel")).not.toBeInTheDocument();
    // The strip stays, and the menu is remembered for the next click.
    expect(screen.getByTestId("rail-strip")).toBeInTheDocument();
    expect(useAppStore.getState().prefs.rail).toMatchObject({
      open: false,
      activeMenu: "checkpoints",
    });
  });

  it("swaps the body when another entry is clicked", async () => {
    setRail({ open: true, activeMenu: "source-control" });
    render(<RightRail menus={menus()} />);
    expect(screen.getByText("changes body")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("rail-menu-documents"));

    expect(screen.queryByText("changes body")).not.toBeInTheDocument();
    expect(screen.getByText("documents body")).toBeInTheDocument();
    expect(useAppStore.getState().prefs.rail.open).toBe(true);
  });

  it("mounts only the active body", () => {
    // Hydration-on-mount is the load signal for History and Checkpoints, so an
    // inactive body must never be rendered (it would fetch on first paint).
    setRail({ open: true, activeMenu: "checkpoints" });
    render(<RightRail menus={menus()} />);
    expect(screen.queryByText("changes body")).not.toBeInTheDocument();
    expect(screen.queryByText("documents body")).not.toBeInTheDocument();
    expect(screen.getByText("checkpoints body")).toBeInTheDocument();
  });

  it("shows a count badge only when the count is positive", () => {
    setRail({ open: false });
    render(<RightRail menus={menus()} />);
    expect(screen.getByTestId("rail-menu-count-source-control")).toHaveTextContent("3");
    expect(screen.queryByTestId("rail-menu-count-checkpoints")).not.toBeInTheDocument();
    expect(screen.queryByTestId("rail-menu-count-documents")).not.toBeInTheDocument();
  });

  it("labels every entry for assistive technology", () => {
    setRail({ open: true, activeMenu: "source-control" });
    render(<RightRail menus={menus()} />);
    expect(screen.getByRole("button", { name: "Source Control" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("button", { name: "Checkpoints" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    // Only the active entry points at the body.
    expect(screen.getByRole("button", { name: "Source Control" })).toHaveAttribute(
      "aria-controls",
      "rail-panel",
    );
    expect(screen.getByRole("button", { name: "Checkpoints" })).not.toHaveAttribute(
      "aria-controls",
    );
  });
});

describe("the panel body", () => {
  it("names the region after the menu, not after its badge", () => {
    setRail({ open: true, activeMenu: "source-control" });
    render(<RightRail menus={menus()} />);
    const panel = screen.getByTestId("rail-panel");
    expect(panel).toHaveAccessibleName("Source Control");
    // The count lives in the strip, so it cannot leak into the region's name.
    expect(panel).not.toHaveTextContent("3");
  });

  it("collapses from its title row", async () => {
    setRail({ open: true, activeMenu: "checkpoints" });
    render(<RightRail menus={menus()} />);
    await userEvent.click(screen.getByRole("button", { name: "Collapse panel" }));
    expect(screen.queryByTestId("rail-panel")).not.toBeInTheDocument();
    expect(useAppStore.getState().prefs.rail.open).toBe(false);
  });

  it("owns the scroll container by default", () => {
    setRail({ open: true, activeMenu: "checkpoints" });
    render(<RightRail menus={menus()} />);
    const scroller = screen.getByText("checkpoints body").parentElement;
    expect(scroller).toHaveClass("overflow-y-auto");
  });

  it("leaves scrolling to a body that asks for it", () => {
    setRail({ open: true, activeMenu: "checkpoints" });
    render(
      <RightRail
        menus={[
          {
            id: "source-control",
            scroll: "self",
            content: <p>pinned and scrolled</p>,
          },
        ]}
      />,
    );
    const wrapper = screen.getByText("pinned and scrolled").parentElement;
    expect(wrapper).not.toHaveClass("overflow-y-auto");
  });
});

describe("a menu this session does not have", () => {
  it("is absent from the strip while the order still contains it", () => {
    setRail({ open: false, order: [...RAIL_MENU_IDS], activeMenu: "source-control" });
    render(<RightRail menus={menus().filter((menu) => menu.id !== "documents")} />);
    expect(screen.queryByTestId("rail-menu-documents")).not.toBeInTheDocument();
    expect(useAppStore.getState().prefs.rail.order).toContain("documents");
  });

  it("falls back to the first available menu without rewriting prefs", () => {
    // A persisted `documents` on a machine where the Office bridge is absent.
    setRail({ open: true, activeMenu: "documents" });
    render(<RightRail menus={menus().filter((menu) => menu.id !== "documents")} />);

    expect(screen.getByText("changes body")).toBeInTheDocument();
    // Render-only: the user's choice is left on disk for when Office returns.
    expect(useAppStore.getState().prefs.rail.activeMenu).toBe("documents");
  });

  it("shows an empty state when nothing at all is available", () => {
    setRail({ open: true });
    render(<RightRail menus={[]} />);
    // No rail at all rather than a strip with no entries.
    expect(screen.queryByTestId("right-rail")).not.toBeInTheDocument();
  });
});

describe("resizing", () => {
  it("applies the persisted width to the panel body", () => {
    setRail({ open: true, activeMenu: "checkpoints", width: 400 });
    render(<RightRail menus={menus()} />);
    expect(screen.getByTestId("rail-panel")).toHaveStyle({ width: "400px" });
  });

  it("has no handle while the panel is collapsed", () => {
    render(<RightRail menus={menus()} />);
    expect(screen.queryByTestId("right-rail-resize")).not.toBeInTheDocument();
  });

  it("widens with ArrowLeft and narrows with ArrowRight", async () => {
    setRail({ open: true, activeMenu: "checkpoints", width: 320 });
    render(<RightRail menus={menus()} />);
    const handle = screen.getByRole("separator", { name: /resize panel/i });

    handle.focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(useAppStore.getState().prefs.rail.width).toBe(340);

    await userEvent.keyboard("{ArrowRight}");
    expect(useAppStore.getState().prefs.rail.width).toBe(320);
  });

  it("clamps a keyboard resize to the supported range", async () => {
    setRail({ open: true, activeMenu: "checkpoints", width: MAX_RAIL_WIDTH });
    render(<RightRail menus={menus()} />);
    const handle = screen.getByRole("separator", { name: /resize panel/i });
    handle.focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(useAppStore.getState().prefs.rail.width).toBe(MAX_RAIL_WIDTH);

    setRail({ open: true, activeMenu: "checkpoints", width: MIN_RAIL_WIDTH });
    await userEvent.keyboard("{ArrowRight}");
    expect(useAppStore.getState().prefs.rail.width).toBe(MIN_RAIL_WIDTH);
  });

  it("exposes the current width on the separator", () => {
    setRail({ open: true, activeMenu: "checkpoints", width: 360 });
    render(<RightRail menus={menus()} />);
    expect(screen.getByRole("separator", { name: /resize panel/i })).toHaveAttribute(
      "aria-valuenow",
      "360",
    );
  });

  it("persists a dragged width on release", () => {
    setRail({ open: true, activeMenu: "checkpoints", width: 320 });
    render(<RightRail menus={menus()} />);
    const handle = screen.getByTestId("right-rail-resize");

    // Drag 40px to the left: the panel is anchored right, so it widens.
    handle.dispatchEvent(new PointerEvent("pointerdown", { clientX: 500, bubbles: true }));
    handle.dispatchEvent(new PointerEvent("pointermove", { clientX: 460, bubbles: true }));
    handle.dispatchEvent(new PointerEvent("pointerup", { clientX: 460, bubbles: true }));

    expect(useAppStore.getState().prefs.rail.width).toBe(360);
  });

  it("does not commit a width that never moved", () => {
    setRail({ open: true, activeMenu: "checkpoints", width: 320 });
    render(<RightRail menus={menus()} />);
    const handle = screen.getByTestId("right-rail-resize");
    handle.dispatchEvent(new PointerEvent("pointerdown", { clientX: 500, bubbles: true }));
    handle.dispatchEvent(new PointerEvent("pointerup", { clientX: 500, bubbles: true }));
    expect(useAppStore.getState().prefs.rail.width).toBe(320);
  });
});

describe("the strip is one tab stop", () => {
  it("gives only the active entry tabIndex 0", () => {
    setRail({ open: true, activeMenu: "checkpoints" });
    render(<RightRail menus={menus()} />);
    expect(screen.getByTestId("rail-menu-checkpoints")).toHaveAttribute("tabindex", "0");
    expect(screen.getByTestId("rail-menu-source-control")).toHaveAttribute("tabindex", "-1");
    expect(screen.getByTestId("rail-menu-documents")).toHaveAttribute("tabindex", "-1");
  });

  it("moves focus and the tab stop with the arrows", async () => {
    setRail({ open: true, activeMenu: "source-control" });
    render(<RightRail menus={menus()} />);
    const first = screen.getByTestId("rail-menu-source-control");
    first.focus();

    await userEvent.keyboard("{ArrowDown}");
    const second = screen.getByTestId("rail-menu-checkpoints");
    expect(second).toHaveFocus();
    expect(second).toHaveAttribute("tabindex", "0");
    expect(first).toHaveAttribute("tabindex", "-1");

    await userEvent.keyboard("{End}");
    expect(screen.getByTestId("rail-menu-documents")).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(first).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    // Clamped at the top rather than wrapping.
    expect(first).toHaveFocus();
  });

  it("follows the strip order after a reorder", () => {
    setRail({
      open: true,
      activeMenu: "checkpoints",
      order: ["checkpoints", "source-control", "documents"],
    });
    render(<RightRail menus={menus()} />);
    const strip = screen.getByTestId("rail-strip");
    const order = [...strip.querySelectorAll<HTMLElement>("[data-rail-menu]")].map((node) =>
      node.getAttribute("data-rail-menu"),
    );
    expect(order).toEqual(["checkpoints", "source-control", "documents"]);
  });

  it("is a vertical toolbar", () => {
    render(<RightRail menus={menus()} />);
    const strip = screen.getByTestId("rail-strip");
    expect(strip).toHaveAttribute("role", "toolbar");
    expect(strip).toHaveAttribute("aria-orientation", "vertical");
    expect(strip).toHaveAttribute("aria-label", "Panels");
  });
});

describe("scrolling model", () => {
  it("keeps the collapsed strip outside any scroll container", () => {
    render(<RightRail menus={menus()} />);
    const strip = screen.getByTestId("rail-strip");
    // The strip is a sibling of the panel, so a scrolled body can never hide it.
    expect(strip.parentElement).toBe(screen.getByTestId("right-rail"));
  });

  it("only wraps the active body", async () => {
    setRail({ open: true, activeMenu: "source-control" });
    render(<RightRail menus={menus()} />);
    const scrollers = document.querySelectorAll('[data-testid="rail-panel"] .overflow-y-auto');
    expect(scrollers).toHaveLength(1);
    await userEvent.click(screen.getByTestId("rail-menu-checkpoints"));
    expect(document.querySelectorAll('[data-testid="rail-panel"] .overflow-y-auto')).toHaveLength(
      1,
    );
  });
});

describe("keyboard focus of a collapsed strip", () => {
  it("reaches every entry without the panel being open", () => {
    render(<RightRail menus={menus()} />);
    // Scoped to the entries themselves: each one also renders a reorder trigger.
    const entries = [
      ...screen.getByTestId("rail-strip").querySelectorAll<HTMLElement>("[data-rail-menu]"),
    ];
    expect(entries).toHaveLength(3);
    // The first entry is the tab stop while nothing is active.
    expect(entries.filter((entry) => entry.getAttribute("tabindex") === "0")).toHaveLength(1);
    entries[0]!.focus();
    expect(entries[0]).toHaveFocus();
  });
});
