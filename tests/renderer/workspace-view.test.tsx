import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useAppStore, type AppStateShape } from "../../src/renderer/src/state/app-store";
import { beginTabDrag } from "../../src/renderer/src/state/tab-drag-session";
import { WorkspaceView } from "../../src/renderer/src/views/WorkspaceView";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { GridLayout } from "../../src/shared/session-grid";
import type { TabRecord } from "../../src/shared/session-ipc";
import { installBridge } from "./fixtures";

/**
 * The session view: grid or solo (2026-11-03 plan step 11).
 *
 * This is the shell's `session` view, so it owns two decisions:
 *
 *  - **which surface** — the remembered grid, or the one tab full-size when the
 *    user opened something no pane holds (`gridMode`, unit tested in shared);
 *  - **what main is told is visible** — the push that keeps a pane's Pi host
 *    awake. One push per actual change, exactly the pane set.
 */

const WORK = "C:/work/app";

function tab(id: string, title: string, lastActiveAt: number): TabRecord {
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

/**
 * Each test uses its own id prefix.
 *
 * `syncVisibleTabs` dedupes against the last set it pushed, and that key is
 * module state (the store is a singleton, as it is in the app). Distinct ids keep
 * every mount push observable instead of depending on test order.
 */
function setup(
  layout: GridLayout,
  panes: (string | null)[],
  options: { prefix?: string; extra?: Partial<AppStateShape> } = {},
): ReturnType<typeof installBridge> {
  const prefix = options.prefix ?? "tab";
  const handles = installBridge();
  useAppStore.setState({
    view: "session",
    project: { path: WORK, name: "app" },
    projects: [],
    projectsLoaded: true,
    prefs: {
      ...DEFAULT_PREFS,
      drafts: {},
      grid: { layout, lastMultiLayout: layout === "single" ? "two" : layout, panes },
    },
    tabs: [
      tab(`${prefix}-1`, "first", 1),
      tab(`${prefix}-2`, "second", 2),
      tab(`${prefix}-3`, "third", 3),
    ],
    activeTabId: `${prefix}-1`,
    panePickerTarget: null,
    transcripts: {},
    sessionStates: {},
    extensionUi: {},
    tuiSurfaces: {},
    hint: null,
    ...options.extra,
  });
  return handles;
}

beforeEach(() => {
  installBridge();
});

describe("workspace view", () => {
  it("is the solo surface for the single layout", () => {
    setup("single", ["solo-1"], { prefix: "solo" });
    render(<WorkspaceView />);

    expect(screen.getByTestId("workspace-view")).toHaveAttribute("data-grid-mode", "solo");
    expect(screen.queryByTestId("pane-grid")).toBeNull();
    expect(screen.getByTestId("session-view")).toBeInTheDocument();
  });

  it("reveals the last multi layout at reduced opacity while dragging from Single", () => {
    setup("single", [null, null, null, null], { prefix: "drag" });
    useAppStore.setState({
      prefs: {
        ...useAppStore.getState().prefs,
        grid: {
          layout: "single",
          lastMultiLayout: "four",
          panes: ["drag-1", "drag-2", null, null],
        },
      },
    });
    beginTabDrag();

    render(<WorkspaceView />);

    const workspace = screen.getByTestId("workspace-view");
    expect(workspace).toHaveAttribute("data-grid-mode", "grid");
    expect(workspace).toHaveAttribute("data-drag-reveal", "true");
    expect(workspace).toHaveAttribute("data-layout", "four");
    expect(workspace.className).toContain("opacity-80");
    expect(screen.getByTestId("pane-grid")).toHaveAttribute("data-layout", "four");
    expect(screen.getByTestId("pane-1")).toBeInTheDocument();
  });

  it("restores solo when the drag ends without a drop", async () => {
    setup("single", [null, null, null, null], { prefix: "cancel" });
    useAppStore.setState({
      prefs: {
        ...useAppStore.getState().prefs,
        grid: {
          layout: "single",
          lastMultiLayout: "four",
          panes: ["cancel-1", "cancel-2", null, null],
        },
      },
    });
    beginTabDrag();

    render(<WorkspaceView />);
    expect(screen.getByTestId("workspace-view")).toHaveAttribute("data-grid-mode", "grid");

    fireEvent.dragEnd(window);

    await waitFor(() =>
      expect(screen.getByTestId("workspace-view")).toHaveAttribute("data-grid-mode", "solo"),
    );
    expect(screen.queryByTestId("pane-grid")).toBeNull();
  });

  it("shows the remembered grid when a pane holds the active tab", () => {
    setup("two", ["grid-1", "grid-2"], { prefix: "grid" });
    render(<WorkspaceView />);

    expect(screen.getByTestId("workspace-view")).toHaveAttribute("data-grid-mode", "grid");
    expect(screen.getByTestId("pane-grid")).toBeInTheDocument();
    expect(screen.getByTestId("pane-1")).toBeInTheDocument();
  });

  it("goes solo — without forgetting the layout — for a tab no pane holds", () => {
    setup("two", ["keep-1", "keep-2"], {
      prefix: "keep",
      extra: { activeTabId: "keep-3" },
    });
    render(<WorkspaceView />);

    expect(screen.getByTestId("workspace-view")).toHaveAttribute("data-grid-mode", "solo");
    expect(screen.queryByTestId("pane-grid")).toBeNull();
    // The layout and its assignments survive; clicking a pane's tab returns to it.
    expect(useAppStore.getState().prefs.grid).toEqual({
      layout: "two",
      lastMultiLayout: "two",
      panes: ["keep-1", "keep-2"],
    });
  });

  it("returns to the grid when a pane's tab is activated", async () => {
    setup("two", ["back-1", "back-2"], {
      prefix: "back",
      extra: { activeTabId: "back-3" },
    });
    const { rerender } = render(<WorkspaceView />);
    expect(screen.getByTestId("workspace-view")).toHaveAttribute("data-grid-mode", "solo");

    await useAppStore.getState().activateTab("back-2");
    rerender(<WorkspaceView />);

    await waitFor(() =>
      expect(screen.getByTestId("workspace-view")).toHaveAttribute("data-grid-mode", "grid"),
    );
  });

  it("renders Welcome when nothing is open", () => {
    setup("single", [], { prefix: "none", extra: { tabs: [], activeTabId: null } });
    render(<WorkspaceView />);

    expect(screen.queryByTestId("session-view")).toBeNull();
    expect(screen.getByRole("heading", { name: "Pi Desktop" })).toBeInTheDocument();
  });
});

describe("the visible-set push", () => {
  it("sends every pane's tab once, after mount", async () => {
    const { visibleTabPushes } = setup("two", ["push1-a", "push1-b"], {
      prefix: "push1",
      extra: { activeTabId: "push1-a" },
    });

    render(<WorkspaceView />);

    await waitFor(() => expect(visibleTabPushes.at(-1)).toEqual(["push1-a", "push1-b"]));
  });

  it("sends the revealed panes while dragging and narrows again on cancel", async () => {
    const { visibleTabPushes } = setup("single", [null, null, null, null], {
      prefix: "push-drag",
    });
    useAppStore.setState({
      prefs: {
        ...useAppStore.getState().prefs,
        grid: {
          layout: "single",
          lastMultiLayout: "two",
          panes: ["push-drag-1", "push-drag-2", null, null],
        },
      },
    });
    beginTabDrag();

    render(<WorkspaceView />);

    await waitFor(() => expect(visibleTabPushes.at(-1)).toEqual(["push-drag-1", "push-drag-2"]));

    fireEvent.dragEnd(window);

    await waitFor(() => expect(visibleTabPushes.at(-1)).toEqual(["push-drag-1"]));
  });

  it("sends only the active tab in solo", async () => {
    const { visibleTabPushes } = setup("two", ["push2-a", "push2-b"], {
      prefix: "push2",
      extra: { activeTabId: "push2-c" },
    });

    render(<WorkspaceView />);

    await waitFor(() => expect(visibleTabPushes.at(-1)).toEqual(["push2-c"]));
  });

  it("sends nothing again for an unchanged set", async () => {
    const { visibleTabPushes } = setup("two", ["push3-a", "push3-b"], {
      prefix: "push3",
      extra: { activeTabId: "push3-a" },
    });
    const { rerender } = render(<WorkspaceView />);
    await waitFor(() => expect(visibleTabPushes.at(-1)).toEqual(["push3-a", "push3-b"]));
    const count = visibleTabPushes.length;

    rerender(<WorkspaceView />);

    expect(visibleTabPushes.length).toBe(count);
  });

  it("follows a pane change", async () => {
    const { visibleTabPushes } = setup("two", ["push4-a", "push4-b"], {
      prefix: "push4",
      extra: { activeTabId: "push4-a" },
    });
    render(<WorkspaceView />);
    await waitFor(() => expect(visibleTabPushes.at(-1)).toEqual(["push4-a", "push4-b"]));

    // The focused tab comes first, then the other panes.
    await useAppStore.getState().assignPaneTab(1, "push4-c");

    await waitFor(() => expect(visibleTabPushes.at(-1)).toEqual(["push4-c", "push4-a"]));
  });
});
