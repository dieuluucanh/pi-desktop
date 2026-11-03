import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "../../src/renderer/src/state/app-store";
import { TabSurface } from "../../src/renderer/src/views/TabSurface";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import { installBridge } from "./fixtures";

/**
 * The tab-kind dispatcher (2026-11-03 grid plan step 9).
 *
 * `TabSurface` used to live inside `ActiveTabView`, which read the selection.
 * The grid mounts several surfaces at once, so the dispatcher takes a **tab id**
 * — these tests pin that it renders what it is told, not what is selected.
 */

const WORK = "C:/work/app";

function tab(overrides: Partial<TabRecord> = {}): TabRecord {
  return {
    id: "tab-1",
    kind: "session",
    cwd: WORK,
    title: "First session",
    sessionFile: null,
    status: "idle",
    createdAt: 1,
    lastActiveAt: 1,
    model: null,
    ...overrides,
  };
}

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    view: "session",
    project: { path: WORK, name: "app" },
    projects: [],
    projectsLoaded: true,
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    tabs: [tab(), tab({ id: "tab-2", title: "Second session", lastActiveAt: 2 })],
    activeTabId: "tab-1",
    transcripts: {},
    sessionStates: {},
    extensionUi: {},
    tuiSurfaces: {},
    hint: null,
  });
});

describe("TabSurface", () => {
  it("renders the tab it is given, not the selected one", () => {
    render(<TabSurface tabId="tab-2" />);

    expect(screen.getByTestId("session-view")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Second session" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "First session" })).toBeNull();
  });

  it("falls back to Welcome when the id is null", () => {
    render(<TabSurface tabId={null} />);

    expect(screen.queryByTestId("session-view")).toBeNull();
    expect(screen.getByRole("heading", { name: "Pi Desktop" })).toBeInTheDocument();
  });

  it("falls back to Welcome for a tab that closed between render and read", () => {
    render(<TabSurface tabId="ghost" />);

    expect(screen.queryByTestId("session-view")).toBeNull();
    expect(screen.getByRole("heading", { name: "Pi Desktop" })).toBeInTheDocument();
  });
});
