import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { RightRail, type RailSectionSpec } from "../../src/renderer/src/rail/RightRail";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import {
  DEFAULT_RAIL_PREFS,
  MAX_RAIL_WIDTH,
  MIN_RAIL_WIDTH,
  type RailPrefs,
} from "../../src/shared/rail";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * The right rail host (git-checkpoint plan step 10).
 *
 * The host owns chrome only — header, resize handle, per-section collapse — so
 * these tests are about interaction and persistence rather than git: a closed
 * rail costs nothing, one section collapsing leaves the rest alone, and the
 * width a user drags is the width that is persisted.
 */

function sections(): RailSectionSpec[] {
  return [
    { id: "git", content: <p>branch line</p> },
    { id: "changes", count: 3, content: <p>changes body</p> },
    { id: "documents", content: <p>documents body</p> },
  ];
}

function setRail(overrides: Partial<RailPrefs> = {}): void {
  const rail: RailPrefs = {
    ...DEFAULT_RAIL_PREFS,
    open: true,
    ...overrides,
    sections: { ...DEFAULT_RAIL_PREFS.sections, ...(overrides.sections ?? {}) },
  };
  useAppStore.setState({ prefs: { ...DEFAULT_PREFS, drafts: {}, rail } });
}

beforeEach(() => {
  installBridge();
  setRail({ open: false });
});

describe("visibility", () => {
  it("renders nothing while closed", () => {
    render(<RightRail sections={sections()} />);
    expect(screen.queryByTestId("right-rail")).not.toBeInTheDocument();
  });

  it("renders the sections when open", () => {
    setRail();
    render(<RightRail sections={sections()} />);
    expect(screen.getByTestId("right-rail")).toBeInTheDocument();
    expect(screen.getByTestId("rail-section-git")).toBeInTheDocument();
    expect(screen.getByTestId("rail-section-changes")).toBeInTheDocument();
    expect(screen.getByText("branch line")).toBeInTheDocument();
    expect(screen.getByText("changes body")).toBeInTheDocument();
  });

  it("renders only the sections it is given", () => {
    setRail();
    render(<RightRail sections={[{ id: "documents", content: <p>docs</p> }]} />);
    expect(screen.getByTestId("rail-section-documents")).toBeInTheDocument();
    expect(screen.queryByTestId("rail-section-git")).not.toBeInTheDocument();
    expect(screen.queryByTestId("rail-section-checkpoints")).not.toBeInTheDocument();
  });

  it("shows a count badge only when it is non-zero", () => {
    setRail();
    render(<RightRail sections={sections()} />);
    expect(screen.getByTestId("rail-section-changes")).toHaveTextContent("3");
    // `git` has no count; nothing to badge.
    expect(screen.getByTestId("rail-section-git")).not.toHaveTextContent(/\d/);
  });

  it("closes from the header button", async () => {
    setRail();
    render(<RightRail sections={sections()} />);
    await userEvent.click(screen.getByRole("button", { name: /close panel/i }));
    expect(useAppStore.getState().prefs.rail.open).toBe(false);
  });
});

describe("section collapse", () => {
  it("starts expanded and collapses on click", async () => {
    setRail();
    render(<RightRail sections={sections()} />);
    const header = screen.getByRole("button", { name: /changes/i });
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("changes body")).toBeInTheDocument();

    await userEvent.click(header);

    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("changes body")).not.toBeInTheDocument();
    // The other sections are untouched.
    expect(screen.getByText("branch line")).toBeInTheDocument();
  });

  it("persists the collapsed state in prefs", async () => {
    setRail();
    render(<RightRail sections={sections()} />);
    await userEvent.click(screen.getByRole("button", { name: /git/i }));
    expect(useAppStore.getState().prefs.rail.sections.git).toBe(false);
    expect(useAppStore.getState().prefs.rail.sections.changes).toBe(true);
  });

  it("honours a section that starts collapsed", () => {
    setRail({ sections: { ...DEFAULT_RAIL_PREFS.sections, documents: false } });
    render(<RightRail sections={sections()} />);
    const header = screen.getByRole("button", { name: /documents/i });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("documents body")).not.toBeInTheDocument();
  });

  it("links the header to its body for assistive technology", () => {
    setRail();
    render(<RightRail sections={sections()} />);
    const header = screen.getByRole("button", { name: /git/i });
    const bodyId = header.getAttribute("aria-controls");
    expect(bodyId).toBe("rail-body-git");
    expect(document.getElementById(bodyId ?? "")).toBeInTheDocument();
  });
});

describe("resizing", () => {
  it("applies the persisted width", () => {
    setRail({ width: 400 });
    render(<RightRail sections={sections()} />);
    expect(screen.getByTestId("right-rail")).toHaveStyle({ width: "400px" });
  });

  it("widens with ArrowLeft and narrows with ArrowRight", async () => {
    setRail({ width: 320 });
    render(<RightRail sections={sections()} />);
    const handle = screen.getByRole("separator", { name: /resize panel/i });

    handle.focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(useAppStore.getState().prefs.rail.width).toBe(340);

    await userEvent.keyboard("{ArrowRight}");
    expect(useAppStore.getState().prefs.rail.width).toBe(320);
  });

  it("clamps a keyboard resize to the supported range", async () => {
    setRail({ width: MAX_RAIL_WIDTH });
    render(<RightRail sections={sections()} />);
    const handle = screen.getByRole("separator", { name: /resize panel/i });
    handle.focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(useAppStore.getState().prefs.rail.width).toBe(MAX_RAIL_WIDTH);

    setRail({ width: MIN_RAIL_WIDTH });
    await userEvent.keyboard("{ArrowRight}");
    expect(useAppStore.getState().prefs.rail.width).toBe(MIN_RAIL_WIDTH);
  });

  it("exposes the current width on the separator", () => {
    setRail({ width: 360 });
    render(<RightRail sections={sections()} />);
    expect(screen.getByRole("separator", { name: /resize panel/i })).toHaveAttribute(
      "aria-valuenow",
      "360",
    );
  });

  it("persists a dragged width on release", async () => {
    setRail({ width: 320 });
    render(<RightRail sections={sections()} />);
    const handle = screen.getByTestId("right-rail-resize");

    // Drag 40px to the left: the rail is anchored right, so it widens.
    handle.dispatchEvent(new PointerEvent("pointerdown", { clientX: 500, bubbles: true }));
    handle.dispatchEvent(new PointerEvent("pointermove", { clientX: 460, bubbles: true }));
    handle.dispatchEvent(new PointerEvent("pointerup", { clientX: 460, bubbles: true }));

    expect(useAppStore.getState().prefs.rail.width).toBe(360);
  });

  it("does not commit a width that never moved", async () => {
    setRail({ width: 320 });
    render(<RightRail sections={sections()} />);
    const handle = screen.getByTestId("right-rail-resize");
    handle.dispatchEvent(new PointerEvent("pointerdown", { clientX: 500, bubbles: true }));
    handle.dispatchEvent(new PointerEvent("pointerup", { clientX: 500, bubbles: true }));
    expect(useAppStore.getState().prefs.rail.width).toBe(320);
  });
});

describe("accessibility", () => {
  it("exposes each section as a labelled region", () => {
    setRail();
    render(<RightRail sections={sections()} />);
    const regions = screen.getAllByRole("region");
    expect(regions).toHaveLength(3);
    expect(regions[0]).toHaveAccessibleName("Git");
    expect(regions[1]).toHaveAccessibleName("Changes");
  });

  it("roves focus between section headers with the arrow keys", async () => {
    setRail();
    render(<RightRail sections={sections()} />);
    const git = screen.getByRole("button", { name: /^git$/i });
    const changes = screen.getByRole("button", { name: /^changes/i });

    git.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(changes).toHaveFocus();

    await userEvent.keyboard("{ArrowUp}");
    expect(git).toHaveFocus();
  });

  it("jumps to the first and last header with Home and End", async () => {
    setRail();
    render(<RightRail sections={sections()} />);
    const git = screen.getByRole("button", { name: /^git$/i });
    const documents = screen.getByRole("button", { name: /^documents/i });

    git.focus();
    await userEvent.keyboard("{End}");
    expect(documents).toHaveFocus();

    await userEvent.keyboard("{Home}");
    expect(git).toHaveFocus();
  });

  it("explains itself when it has no sections", () => {
    setRail();
    render(<RightRail sections={[]} />);
    expect(screen.getByTestId("rail-empty")).toHaveTextContent(/Nothing to show/i);
    expect(screen.queryAllByRole("region")).toHaveLength(0);
  });
});
