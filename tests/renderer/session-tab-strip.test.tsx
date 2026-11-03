import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
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
});
