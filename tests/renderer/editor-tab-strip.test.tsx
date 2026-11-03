import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EditorTabStrip } from "../../src/renderer/src/layout/EditorTabStrip";
import { useEditorStore } from "../../src/renderer/src/editor/editor-store";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import { installBridge } from "./fixtures";

/**
 * The editor strip (2026-11-02 plan step 5).
 *
 * It must show only editor tabs, disappear when the last file closes, activate
 * through the shared `activeTabId` without issuing host RPCs, and translate a
 * drag inside its filtered list back to the global tab index.
 */

const WORK = "C:\\work\\pi-desktop";

function tab(overrides: Partial<TabRecord> = {}): TabRecord {
  return {
    id: "tab-1",
    kind: "session",
    cwd: WORK,
    title: "pi-desktop",
    sessionFile: `${WORK}\\sessions\\s1.jsonl`,
    status: "idle",
    createdAt: 1,
    lastActiveAt: 1,
    model: null,
    ...overrides,
  };
}

function editor(id: string, title: string): TabRecord {
  return tab({
    id,
    kind: "editor",
    title,
    filePath: title,
    sessionFile: null,
    status: "idle",
  });
}

beforeEach(() => {
  installBridge();
  useEditorStore.getState().clearExcept(new Set());
  useEditorStore.setState({ pendingClose: null });
  useAppStore.setState({
    view: "session",
    project: { path: WORK, name: "pi-desktop" },
    prefs: { ...DEFAULT_PREFS },
    hint: null,
    tabs: [],
    activeTabId: null,
    transcripts: {},
    sessionStates: {},
  });
});

describe("EditorTabStrip", () => {
  it("renders more than the old sixteen-tab cap", () => {
    const tabs = Array.from({ length: 18 }, (_, index) =>
      editor(`editor-${index}`, `file-${index}.ts`),
    );
    useAppStore.setState({ tabs, activeTabId: "editor-0" });

    render(<EditorTabStrip />);

    expect(screen.getAllByRole("tab")).toHaveLength(18);
    expect(screen.getByTestId("tab-editor-17")).toBeInTheDocument();
  });

  it("renders nothing while no file is open", () => {
    useAppStore.setState({ tabs: [tab()] });
    const { container } = render(<EditorTabStrip />);
    expect(container.firstChild).toBeNull();
  });

  it("shows editor tabs and excludes session tabs", () => {
    useAppStore.setState({ tabs: [tab(), editor("editor-1", "a.ts")], activeTabId: "tab-1" });
    render(<EditorTabStrip />);

    expect(screen.getByTestId("editor-tab-strip")).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Editor tabs" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /a\.ts/ })).toBeInTheDocument();
    expect(screen.queryByTestId("tab-tab-1")).toBeNull();
    // The row is identified by its position and the language badge; the
    // redundant "Editors" label and per-tab file glyph were removed.
    expect(screen.queryByText("Editors")).toBeNull();
    expect(screen.getByText("TS")).toBeInTheDocument();
  });

  it("activates a file through the shared active tab without host RPCs", async () => {
    const { bridge } = installBridge();
    const activate = vi.fn(async () => ({
      tabs: [editor("editor-1", "a.ts")],
      activeTabId: "editor-1",
    }));
    const request = vi.fn();
    (bridge.sessions as unknown as { activate: unknown }).activate = activate;
    (bridge.sessions as unknown as { request: unknown }).request = request;
    useAppStore.setState({ tabs: [editor("editor-1", "a.ts")], activeTabId: null });

    render(<EditorTabStrip />);
    fireEvent.click(screen.getByRole("tab", { name: /a\.ts/ }));

    await waitFor(() => expect(activate).toHaveBeenCalledWith("editor-1"));
    // Editor tabs have no Pi host: no `oi.state`/`tui.state` follow-up.
    expect(request).not.toHaveBeenCalled();
  });

  it("closes a file from its X", async () => {
    const { bridge } = installBridge();
    const close = vi.fn(async () => ({ tabs: [], activeTabId: null }));
    (bridge.sessions as unknown as { close: unknown }).close = close;
    useAppStore.setState({ tabs: [editor("editor-1", "a.ts")], activeTabId: "editor-1" });

    render(<EditorTabStrip />);
    fireEvent.click(screen.getByRole("button", { name: "Close a.ts" }));

    await waitFor(() => expect(close).toHaveBeenCalledWith("editor-1"));
  });

  it("maps a filtered drop back to the global tab index", async () => {
    const { bridge } = installBridge();
    const reorder = vi.fn(async () => ({ tabs: [], activeTabId: null }));
    (bridge.sessions as unknown as { reorder: unknown }).reorder = reorder;
    useAppStore.setState({
      tabs: [tab(), editor("editor-1", "a.ts"), tab({ id: "tab-2" }), editor("editor-2", "b.ts")],
      activeTabId: "tab-1",
    });

    render(<EditorTabStrip />);
    const first = screen.getByTestId("tab-editor-1");
    const second = screen.getByTestId("tab-editor-2");
    fireEvent.dragStart(first);
    fireEvent.dragOver(second);
    fireEvent.drop(second);

    // editor-2 is at global index 3; the filtered local index would be 1.
    await waitFor(() => expect(reorder).toHaveBeenCalledWith("editor-1", 3));
  });

  it("marks a pinned tab and hides its close button", () => {
    useAppStore.setState({
      tabs: [{ ...editor("editor-1", "a.ts"), pinned: true }],
      activeTabId: "editor-1",
    });

    render(<EditorTabStrip />);

    expect(screen.getByTestId("tab-editor-1")).toHaveAttribute("data-pinned", "true");
    expect(screen.queryByRole("button", { name: "Close a.ts" })).toBeNull();
  });

  it("opens the same actions from a right-click", async () => {
    useAppStore.setState({
      tabs: [editor("editor-1", "a.ts")],
      activeTabId: "editor-1",
    });

    render(<EditorTabStrip />);
    fireEvent.contextMenu(screen.getByTestId("tab-editor-1"));

    expect(await screen.findByText("Close all editor tabs")).toBeInTheDocument();
    expect(screen.getByText("Copy Relative Path")).toBeInTheDocument();
  });

  it("marks a dirty file tab", () => {
    useAppStore.setState({ tabs: [editor("editor-1", "a.ts")], activeTabId: "editor-1" });
    useEditorStore.setState((state) => ({
      meta: {
        ...state.meta,
        "editor-1": {
          tabId: "editor-1",
          projectPath: WORK,
          path: "a.ts",
          languageId: "typescript",
          loading: false,
          error: null,
          dirty: true,
          readOnly: false,
          binary: false,
          encoding: "utf8",
          eol: "lf",
          bom: false,
          size: 1,
          mtimeMs: 1,
          line: 1,
          column: 1,
          selectionLength: 0,
          externalChange: null,
          recovered: false,
        },
      },
    }));

    render(<EditorTabStrip />);
    expect(screen.getByTestId("tab-editor-1")).toHaveAttribute("data-dirty", "true");
  });
});
