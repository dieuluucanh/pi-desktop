import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SourceControlPanel } from "../../src/renderer/src/rail/SourceControlPanel";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { emptyGitSnapshot, type GitRepoInfo, type GitSnapshot } from "../../src/shared/git";
import { DEFAULT_RAIL_SPLIT, MIN_BLOCK_PX } from "../../src/shared/rail";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * The Source Control menu body.
 *
 * The composition is the contract here, not the git behaviour (that lives in
 * `rail-git`/`rail-changes`/`rail-commit`/`rail-history`). Three blocks, three
 * independent scrollers, two splitters between them — so a long change list and a
 * long commit log can no longer evict each other, and the user can trade height
 * between them.
 *
 * jsdom has no layout, so the split assertions read the inline `flex` weights the
 * panel renders rather than measuring heights.
 */

const PROJECT = "/work/app";

function repo(overrides: Partial<GitRepoInfo> = {}): GitRepoInfo {
  return {
    root: PROJECT,
    gitDir: `${PROJECT}/.git`,
    branch: "main",
    head: "abc1234",
    detached: false,
    empty: false,
    upstream: "origin/main",
    ahead: 1,
    behind: 0,
    remotes: ["origin"],
    identity: { name: "Ada", email: "ada@example.com", source: "global" },
    ...overrides,
  };
}

function snapshot(overrides: Partial<GitSnapshot> = {}): GitSnapshot {
  return {
    ...emptyGitSnapshot(PROJECT),
    available: true,
    repo: repo(),
    ...overrides,
  };
}

function seed(value: GitSnapshot, split = DEFAULT_RAIL_SPLIT): void {
  installBridge({ git: value });
  useAppStore.setState({
    prefs: {
      ...DEFAULT_PREFS,
      drafts: {},
      rail: { ...DEFAULT_PREFS.rail, split: { ...split } },
    },
    git: { [PROJECT]: value },
    gitError: null,
    gitLog: {},
    gitConsentGranted: true,
  });
}

/** The rendered `flex` weight of a block, as a number of shares. */
function flexOf(id: string): number {
  const style = screen.getByTestId(id).style.flex;
  return Number.parseFloat(style.split(" ")[0] ?? "0");
}

beforeEach(() => {
  seed(snapshot());
});

describe("the three blocks", () => {
  it("stacks block 1, splitter, changes, splitter, history in that order", () => {
    render(<SourceControlPanel projectPath={PROJECT} />);

    const order = [
      "source-control-block",
      "rail-splitter-top",
      "changes-block",
      "rail-splitter-middle",
      "history-block",
    ];
    const nodes = order.map((id) => screen.getByTestId(id));
    for (let i = 0; i < nodes.length - 1; i += 1) {
      const before = nodes[i]!;
      const after = nodes[i + 1]!;
      expect(
        before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING,
        `${order[i]} must precede ${order[i + 1]}`,
      ).toBeTruthy();
    }
  });

  it("gives each block exactly its own sections", () => {
    render(<SourceControlPanel projectPath={PROJECT} />);

    const sourceControl = screen.getByTestId("source-control-block");
    for (const id of ["git-section", "commit-box", "git-sync", "git-stashes-section"]) {
      expect(within(sourceControl).getByTestId(id), id).toBeInTheDocument();
    }

    const changes = screen.getByTestId("changes-block");
    expect(within(changes).getByTestId("changes-section")).toBeInTheDocument();
    // The other blocks' bodies must not leak into this one.
    expect(within(changes).queryByTestId("history-section")).not.toBeInTheDocument();
    expect(within(changes).queryByTestId("commit-box")).not.toBeInTheDocument();

    const history = screen.getByTestId("history-block");
    expect(within(history).getByTestId("history-section")).toBeInTheDocument();
    expect(within(history).queryByTestId("changes-section")).not.toBeInTheDocument();
  });

  it("names the panel for tests and for assistive technology", () => {
    render(<SourceControlPanel projectPath={PROJECT} />);
    const panel = screen.getByTestId("source-control-panel");
    expect(panel).toBeInTheDocument();
    // The rail host labels the section from the menu id, not from this body.
    expect(panel).toHaveClass("min-h-0", "flex-1");
  });

  it("no longer keeps a single pinned/scrolling split", () => {
    render(<SourceControlPanel projectPath={PROJECT} />);
    expect(screen.queryByTestId("source-control-scroll")).not.toBeInTheDocument();
  });
});

describe("scrolling", () => {
  it("has exactly three scroll containers, and they are siblings", () => {
    render(<SourceControlPanel projectPath={PROJECT} />);
    const panel = screen.getByTestId("source-control-panel");
    const scrollers = Array.from(panel.querySelectorAll(".overflow-y-auto"));

    expect(scrollers).toHaveLength(3);
    // No nesting: each block scrolls its own content only.
    for (const outer of scrollers) {
      for (const inner of scrollers) {
        if (outer === inner) continue;
        expect(outer.contains(inner)).toBe(false);
      }
    }
    expect(scrollers.map((node) => node.getAttribute("data-testid"))).toEqual([
      "source-control-block",
      "changes-block",
      "history-block",
    ]);
  });

  it("keeps the composer inside block 1, which scrolls on its own", () => {
    render(<SourceControlPanel projectPath={PROJECT} />);
    const block = screen.getByTestId("source-control-block");
    expect(block).toHaveClass("overflow-y-auto");
    expect(within(block).getByTestId("commit-box")).toBeInTheDocument();
  });
});

describe("the persisted split", () => {
  it("renders the default weights", () => {
    render(<SourceControlPanel projectPath={PROJECT} />);
    expect(flexOf("source-control-block")).toBeCloseTo(0.34, 6);
    expect(flexOf("changes-block")).toBeCloseTo(0.4, 6);
    expect(flexOf("history-block")).toBeCloseTo(0.26, 6);
  });

  it("renders a persisted split instead of the default", () => {
    seed(snapshot(), { top: 0.5, middle: 0.25 });
    render(<SourceControlPanel projectPath={PROJECT} />);
    expect(flexOf("source-control-block")).toBeCloseTo(0.5, 6);
    expect(flexOf("changes-block")).toBeCloseTo(0.25, 6);
    expect(flexOf("history-block")).toBeCloseTo(0.25, 6);
  });

  it("keeps every block visible even for a hostile persisted split", () => {
    seed(snapshot(), { top: 5, middle: -1 });
    render(<SourceControlPanel projectPath={PROJECT} />);
    for (const id of ["source-control-block", "changes-block", "history-block"]) {
      expect(flexOf(id), id).toBeGreaterThan(0);
    }
  });
});

describe("dragging a splitter", () => {
  function stubCapture(handle: HTMLElement): void {
    (handle as HTMLElement & { setPointerCapture?: unknown }).setPointerCapture = () => {};
    (handle as HTMLElement & { releasePointerCapture?: unknown }).releasePointerCapture = () => {};
  }

  function stubBodyHeight(px: number): void {
    Object.defineProperty(screen.getByTestId("source-control-panel"), "clientHeight", {
      configurable: true,
      value: px,
    });
  }

  /** The split the store now holds — the real outcome of the gesture. */
  function persistedSplit(): { top: number; middle: number } {
    return { ...useAppStore.getState().prefs.rail.split };
  }

  it("persists a dragged top split and leaves history's weight alone", () => {
    const setRailSplit = vi.spyOn(useAppStore.getState(), "setRailSplit");
    render(<SourceControlPanel projectPath={PROJECT} />);
    stubBodyHeight(500);
    const handle = screen.getByTestId("rail-splitter-top");
    stubCapture(handle);

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 130 });
    // Nothing is written mid-drag: the display follows local state.
    expect(setRailSplit).not.toHaveBeenCalled();
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 130 });

    expect(setRailSplit).toHaveBeenCalledTimes(1);
    const split = persistedSplit();
    expect(split.top).toBeCloseTo(0.34 + 30 / 500, 6);
    // Top and Changes trade height; History keeps its 26 %.
    expect(flexOf("source-control-block")).toBeCloseTo(split.top, 6);
    expect(flexOf("changes-block")).toBeCloseTo(0.4 - 30 / 500, 6);
    expect(flexOf("history-block")).toBeCloseTo(0.26, 6);
  });

  it("persists a dragged middle split and leaves the top weight alone", () => {
    render(<SourceControlPanel projectPath={PROJECT} />);
    stubBodyHeight(500);
    const handle = screen.getByTestId("rail-splitter-middle");
    stubCapture(handle);

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 200 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 170 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 170 });

    const split = persistedSplit();
    expect(split.top).toBe(0.34);
    // Changes shrinks; History (the remainder) grows by the same amount.
    expect(split.middle).toBeCloseTo(0.4 - 30 / 500, 6);
    expect(flexOf("source-control-block")).toBeCloseTo(0.34, 6);
    expect(flexOf("history-block")).toBeCloseTo(0.26 + 30 / 500, 6);
  });

  it("stops a drag at the px floor, not at zero", () => {
    render(<SourceControlPanel projectPath={PROJECT} />);
    stubBodyHeight(500);
    const handle = screen.getByTestId("rail-splitter-top");
    stubCapture(handle);

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 200 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: -2_000 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: -2_000 });

    const split = persistedSplit();
    expect(split.top * 500).toBeCloseTo(MIN_BLOCK_PX, 6);
    // The neighbour dragged against its own floor too, never past it.
    expect(split.middle * 500).toBeGreaterThanOrEqual(MIN_BLOCK_PX - 1e-6);
  });

  it("resets to the default split on double-click", () => {
    seed(snapshot(), { top: 0.5, middle: 0.25 });
    const setRailSplit = vi.spyOn(useAppStore.getState(), "setRailSplit");
    render(<SourceControlPanel projectPath={PROJECT} />);
    fireEvent.doubleClick(screen.getByTestId("rail-splitter-top"));
    expect(setRailSplit).toHaveBeenCalledWith(DEFAULT_RAIL_SPLIT);
    expect(persistedSplit()).toEqual(DEFAULT_RAIL_SPLIT);
  });

  it("applies a keyboard nudge to the store", () => {
    render(<SourceControlPanel projectPath={PROJECT} />);
    stubBodyHeight(500);
    fireEvent.keyDown(screen.getByTestId("rail-splitter-top"), { key: "ArrowDown" });
    const split = persistedSplit();
    expect(split.top).toBeCloseTo(0.34 + 16 / 500, 6);
    expect(flexOf("source-control-block")).toBeCloseTo(split.top, 6);
  });
});

describe("degraded repositories", () => {
  it("still renders the three blocks when git cannot read the folder", () => {
    seed(emptyGitSnapshot(PROJECT, "not_a_repo"));
    render(<SourceControlPanel projectPath={PROJECT} />);
    // The shell stays so the menu is never a blank column; the bodies explain.
    expect(screen.getByTestId("source-control-panel")).toBeInTheDocument();
    expect(screen.getByTestId("source-control-block")).toBeInTheDocument();
    expect(screen.getByTestId("changes-block")).toBeInTheDocument();
    expect(screen.getByTestId("history-block")).toBeInTheDocument();
    expect(screen.getByTestId("changes-empty")).toBeInTheDocument();
    // The git facts that need a repository are absent.
    expect(screen.queryByTestId("git-section")).not.toBeInTheDocument();
    expect(screen.queryByTestId("git-sync")).not.toBeInTheDocument();
  });

  it("keeps the commit box usable but blocked when no identity is configured", () => {
    seed(
      snapshot({
        // `identity` is `| null`: an empty object is still truthy, and only a
        // null identity makes the box say who git needs.
        repo: repo({ identity: null }),
        // Readiness checks the tree, then the message, then the identity — so the
        // fixture needs a change *and* a typed message to reach this reason.
        changed: [
          { path: "a.ts", origPath: null, status: "modified", staged: false, unstaged: true },
        ],
      }),
    );
    render(<SourceControlPanel projectPath={PROJECT} />);
    fireEvent.change(screen.getByLabelText("Commit message"), { target: { value: "fix: x" } });
    // No warning row is spent on it (2026-10-30 plan); the blocker is announced on
    // the button and explained on the press.
    expect(screen.queryByTestId("commit-reason")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stage all and commit" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("keeps the splitters operable with no repository at all", () => {
    seed(emptyGitSnapshot(PROJECT, "not_a_repo"));
    render(<SourceControlPanel projectPath={PROJECT} />);
    // The split is a layout fact, not a git one: losing the repository must not
    // strand the user with an unsplittable column.
    expect(screen.getByTestId("rail-splitter-top")).toHaveAttribute("tabIndex", "0");
    expect(screen.getByTestId("rail-splitter-middle")).toHaveAttribute("tabIndex", "0");
  });
});
