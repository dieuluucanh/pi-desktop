import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionTabStrip } from "../../src/renderer/src/layout/SessionTabStrip";
import { useEditorStore } from "../../src/renderer/src/editor/editor-store";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import { installBridge } from "./fixtures";

/**
 * The session strip must render the whole restored table. The old eight-tab
 * cap lived in main, but a renderer test makes sure a change cannot quietly
 * filter tabs down again.
 */

const tab = (index: number): TabRecord => ({
  id: `tab-${index}`,
  kind: "session",
  cwd: `C:\\work\\project-${index}`,
  title: `project-${index}`,
  sessionFile: null,
  status: "idle",
  createdAt: index,
  lastActiveAt: index,
  model: null,
});

beforeEach(() => {
  installBridge();
  useEditorStore.getState().clearExcept(new Set());
  useAppStore.setState({
    view: "session",
    project: { path: "C:\\work", name: "work" },
    prefs: { ...DEFAULT_PREFS },
    tabs: [],
    activeTabId: null,
    hint: null,
    sessionBrowserOpen: false,
  });
});

describe("SessionTabStrip", () => {
  it("renders more than the old eight-tab cap", () => {
    const tabs = Array.from({ length: 12 }, (_, index) => tab(index));
    useAppStore.setState({ tabs, activeTabId: tabs[11]!.id });

    render(<SessionTabStrip />);

    expect(screen.getAllByRole("tab")).toHaveLength(12);
    expect(screen.getByTestId("tab-tab-11")).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Session tabs" })).toBeInTheDocument();
  });

  it("puts a Session history button between terminal and grid layout", () => {
    render(<SessionTabStrip />);
    const labels = screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"));
    const history = labels.indexOf("Session history");
    expect(history).toBeGreaterThan(labels.indexOf("New terminal"));
    expect(history).toBeLessThan(labels.indexOf("Grid layout"));
  });

  it("opens the session history dialog from the strip", async () => {
    const { bridge } = installBridge();
    const request = vi.fn(async () => ({
      sessions: [],
      total: 0,
      matched: 0,
      truncated: false,
      error: null,
    }));
    (bridge.sessions as unknown as { request: unknown }).request = request;
    render(<SessionTabStrip />);

    fireEvent.click(screen.getByRole("button", { name: "Session history" }));

    await waitFor(() => expect(useAppStore.getState().sessionBrowserOpen).toBe(true));
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: "session.list" }));
  });
});
