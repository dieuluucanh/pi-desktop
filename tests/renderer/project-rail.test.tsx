import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { ProjectRail } from "../../src/renderer/src/layout/ProjectRail";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_RAIL_PREFS } from "../../src/shared/rail";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import { emptyGitSnapshot } from "../../src/shared/git";
import { documentsViewFixture, installBridge } from "./fixtures";

/**
 * The rail as app chrome (2026-10-30 project-scoped rail plan).
 *
 * Three behaviours are the point of the move, and each has its own way to break:
 *
 *  - it follows the **selected project**, not the tab that happens to be active
 *    (otherwise clicking a project with no session moves nothing);
 *  - it survives with **no active session at all** (Welcome), which is why it
 *    cannot live inside `SessionView`;
 *  - it is **absent on the product views**, so Settings and Diagnostics keep the
 *    full width.
 */

const APP = "C:/work/app";
const OTHER = "C:/work/other";

function tab(id: string, cwd: string, overrides: Partial<TabRecord> = {}): TabRecord {
  return {
    id,
    kind: "session",
    cwd,
    title: id,
    sessionFile: null,
    status: "idle",
    createdAt: 1,
    lastActiveAt: 1,
    model: null,
    ...overrides,
  };
}

function resetStore(): void {
  useAppStore.setState({
    view: "session",
    project: { path: APP, name: "app" },
    projects: [],
    projectsLoaded: true,
    tabs: [tab("t1", APP)],
    activeTabId: "t1",
    transcripts: {},
    sessionStates: {},
    git: {},
    checkpoints: {},
    gitWatched: null,
    officeDocuments: null,
    prefs: {
      ...DEFAULT_PREFS,
      drafts: {},
      rail: { ...DEFAULT_RAIL_PREFS, open: true, activeMenu: "source-control" },
    },
  });
}

beforeEach(() => {
  resetStore();
});

describe("where the rail appears", () => {
  it("renders beside a session and beside Welcome", () => {
    installBridge();
    render(<ProjectRail />);
    expect(screen.getByTestId("right-rail")).toBeInTheDocument();

    act(() => {
      useAppStore.setState({ view: "welcome", activeTabId: null, tabs: [] });
    });
    // Welcome keeps the rail: a project with no open session still owns it.
    expect(screen.getByTestId("right-rail")).toBeInTheDocument();
    expect(screen.getByTestId("rail-strip")).toBeInTheDocument();
  });

  it("is absent on the product views, which get the full width", () => {
    installBridge();
    for (const view of [
      "settings",
      "diagnostics",
      "extensions",
      "connections",
      "skills",
    ] as const) {
      act(() => {
        useAppStore.setState({ view });
      });
      const { container } = render(<ProjectRail />);
      expect(container, view).toBeEmptyDOMElement();
    }
  });

  it("renders nothing when there is no folder to scope to", () => {
    installBridge();
    act(() => {
      useAppStore.setState({ project: null, activeTabId: null, tabs: [] });
    });
    const { container } = render(<ProjectRail />);
    expect(container).toBeEmptyDOMElement();
  });

  it("still renders the strip with the panel collapsed", () => {
    installBridge();
    act(() => {
      useAppStore.setState({
        prefs: { ...useAppStore.getState().prefs, rail: { ...DEFAULT_RAIL_PREFS, open: false } },
      });
    });
    render(<ProjectRail />);
    expect(screen.queryByTestId("rail-panel")).not.toBeInTheDocument();
    expect(screen.getByTestId("rail-strip")).toBeInTheDocument();
  });
});

describe("the scope the rail uses", () => {
  it("follows the selected project rather than a session in another folder", () => {
    installBridge();
    act(() => {
      useAppStore.setState({ tabs: [tab("t1", OTHER)], activeTabId: "t1" });
    });
    render(<ProjectRail />);

    // The header names the project folder, not the tab's cwd.
    expect(screen.getByRole("heading", { name: "Source Control" })).toHaveAttribute("title", APP);
  });

  it("falls back to the session's folder when no project is selected", () => {
    installBridge();
    act(() => {
      useAppStore.setState({ project: null, tabs: [tab("t1", OTHER)], activeTabId: "t1" });
    });
    render(<ProjectRail />);

    expect(screen.getByRole("heading", { name: "Source Control" })).toHaveAttribute("title", OTHER);
  });

  it("never scopes to a web tab's cwd", () => {
    installBridge();
    act(() => {
      useAppStore.setState({
        project: null,
        tabs: [tab("w1", OTHER, { kind: "web" })],
        activeTabId: "w1",
      });
    });
    const { container } = render(<ProjectRail />);
    expect(container).toBeEmptyDOMElement();
  });

  it("counts the scoped folder's changes, not the active tab's", () => {
    installBridge();
    act(() => {
      useAppStore.setState({
        tabs: [tab("t1", OTHER)],
        activeTabId: "t1",
        git: {
          [APP]: {
            ...emptyGitSnapshot(APP),
            available: true,
            staged: [],
            changed: [
              { path: "a.ts", origPath: null, status: "modified", staged: false, unstaged: true },
              { path: "b.ts", origPath: null, status: "modified", staged: false, unstaged: true },
            ],
          },
        },
      });
    });
    render(<ProjectRail />);

    expect(screen.getByTestId("rail-menu-count-source-control")).toHaveTextContent("2");
  });
});

describe("the Documents menu", () => {
  it("is absent while the bridge is not available", () => {
    installBridge();
    render(<ProjectRail />);
    expect(screen.queryByTestId("rail-menu-documents")).not.toBeInTheDocument();
  });

  it("appears once the bridge answers, and names a host in another project", () => {
    installBridge();
    act(() => {
      useAppStore.setState({
        prefs: {
          ...useAppStore.getState().prefs,
          rail: { ...DEFAULT_RAIL_PREFS, open: true, activeMenu: "documents" },
        },
        officeDocuments: documentsViewFixture({ available: true, status: "ok", panes: [] }),
        tabs: [tab("t1", APP), tab("office-1", OTHER, { kind: "office", title: "Office" })],
        activeTabId: "t1",
      });
    });
    render(<ProjectRail />);

    expect(screen.getByTestId("rail-menu-documents")).toBeInTheDocument();
    // The note is derived from the rail's folder, so it cannot go stale: the
    // host is in another project, so its path is named.
    expect(screen.getByTestId("documents-scope-host")).toHaveTextContent(OTHER);
  });

  it("is present while the bridge is configured but not answering", () => {
    // The 2026-10-30 rail-headers plan: one failed probe during a host restart
    // must not remove the entry. The install fact keeps it while the port is
    // being re-bound.
    installBridge();
    act(() => {
      useAppStore.setState({
        officeDocuments: documentsViewFixture({
          available: false,
          configured: true,
          status: "unreachable",
          error: "connect ECONNREFUSED",
        }),
      });
    });
    render(<ProjectRail />);

    expect(screen.getByTestId("rail-menu-documents")).toBeInTheDocument();
  });

  it("is present while an Office tab exists, before the first probe", () => {
    // Promotion makes the tab `office` immediately; the host then needs seconds
    // to bind the port. The menu must not blink out in that window.
    installBridge();
    act(() => {
      useAppStore.setState({
        tabs: [tab("t1", APP), tab("office-1", APP, { kind: "office", title: "Office" })],
        officeDocuments: null,
      });
    });
    render(<ProjectRail />);

    expect(screen.getByTestId("rail-menu-documents")).toBeInTheDocument();
  });

  it("keeps the entry when a later probe says the bridge stopped answering", () => {
    installBridge();
    act(() => {
      useAppStore.setState({
        officeDocuments: documentsViewFixture({ available: true, status: "ok", panes: [] }),
      });
    });
    render(<ProjectRail />);
    expect(screen.getByTestId("rail-menu-documents")).toBeInTheDocument();

    // The advertised restart window: the strip must not lose the entry.
    act(() => {
      useAppStore.setState({
        officeDocuments: documentsViewFixture({
          available: false,
          configured: true,
          status: "unreachable",
        }),
      });
    });
    expect(screen.getByTestId("rail-menu-documents")).toBeInTheDocument();
  });
});
