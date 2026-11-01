import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import { TabStrip } from "../../src/renderer/src/layout/TabStrip";
import { tabMenuItems } from "../../src/renderer/src/layout/tab-menu";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { installBridge } from "./fixtures";

/**
 * Tab strip lifecycle (plan step 11).
 *
 * The strip is the session's cockpit: every lifecycle action (rename, duplicate,
 * clone, fork, export, reveal, close, close others) is reachable from a tab's
 * overflow menu, and tab reordering is persisted by the session service.
 *
 * The menu's *contents* are asserted against the pure `tabMenuItems()` list so
 * the contract is pinned without opening a Radix menu in jsdom; one interaction
 * test then proves the menu is wired to the store.
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

function resetStore(): void {
  useAppStore.setState({
    view: "session",
    project: { path: WORK, name: "pi-desktop" },
    projects: [],
    projectsLoaded: true,
    prefs: { ...DEFAULT_PREFS },
    hint: null,
    tabs: [tab(), tab({ id: "tab-2", title: "second" })],
    activeTabId: "tab-1",
    transcripts: {},
    sessionStates: {},
  });
}

beforeEach(() => {
  resetStore();
  vi.restoreAllMocks();
});

describe("tabMenuItems", () => {
  it("covers the whole session lifecycle exactly once", () => {
    const items = tabMenuItems();
    expect(items.map((item) => item.id)).toEqual([
      "rename",
      "duplicate",
      "tree",
      "fork",
      "clone",
      "export",
      "reveal",
      "close",
      "close-others",
    ]);
    expect(items.map((item) => item.label)).toEqual([
      "Rename…",
      "Duplicate in this project",
      "Browse history tree…",
      "Fork from a message…",
      "Clone session",
      "Export to HTML",
      "Reveal session file",
      "Close",
      "Close others",
    ]);
    expect(items.find((item) => item.id === "close-others")?.destructive).toBe(true);
  });
});

describe("TabStrip", () => {
  it("renders a tab per session and shows its status", () => {
    installBridge();
    render(<TabStrip />);

    expect(screen.getByRole("tab", { name: /pi-desktop/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /second/ })).toBeInTheDocument();
    expect(screen.getByTestId("tab-tab-1").querySelector("[data-status]")).toHaveAttribute(
      "data-status",
      "idle",
    );
    // The persisted lifecycle value stays `idle`; the tooltip speaks `ready`.
    expect(screen.getByRole("tab", { name: /pi-desktop/ })).toHaveAttribute(
      "title",
      expect.stringContaining("ready"),
    );
  });

  it("shows the sidebar expand control only while the sidebar is collapsed", async () => {
    installBridge();
    expect(screen.queryByRole("button", { name: "Show sidebar" })).toBeNull();
    useAppStore.setState({ prefs: { ...DEFAULT_PREFS, sidebarCollapsed: true } });
    render(<TabStrip />);
    await userEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
    expect(useAppStore.getState().prefs.sidebarCollapsed).toBe(false);
  });

  it("activates a tab when clicked", () => {
    const { bridge } = installBridge();
    const activate = vi.fn(async () => ({ tabs: [], activeTabId: "tab-2" }));
    (bridge.sessions as unknown as { activate: unknown }).activate = activate;

    render(<TabStrip />);
    fireEvent.click(screen.getByRole("tab", { name: /second/ }));

    expect(activate).toHaveBeenCalledWith("tab-2");
  });

  it("closes a tab from its X", () => {
    const { bridge } = installBridge();
    const close = vi.fn(async () => ({ tabs: [], activeTabId: null }));
    (bridge.sessions as unknown as { close: unknown }).close = close;

    render(<TabStrip />);
    fireEvent.click(screen.getByRole("button", { name: "Close pi-desktop" }));

    expect(close).toHaveBeenCalledWith("tab-1");
  });

  it("reorders tabs by drag and drop", () => {
    const { bridge } = installBridge();
    const reorder = vi.fn(async () => ({ tabs: [], activeTabId: null }));
    (bridge.sessions as unknown as { reorder: unknown }).reorder = reorder;

    render(<TabStrip />);
    const first = screen.getByTestId("tab-tab-1");
    const second = screen.getByTestId("tab-tab-2");
    fireEvent.dragStart(first);
    fireEvent.dragOver(second);
    fireEvent.drop(second);

    expect(reorder).toHaveBeenCalledWith("tab-1", 1);
  });

  it("closes other tabs through the service", async () => {
    const { bridge } = installBridge();
    const closeOthers = vi.fn(async () => ({ tabs: [tab()], activeTabId: "tab-1" }));
    (bridge.sessions as unknown as { closeOthers: unknown }).closeOthers = closeOthers;

    render(<TabStrip />);
    openTabMenu("pi-desktop");
    await waitFor(() => expect(screen.getByText("Close others")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Close others"));

    await waitFor(() => expect(closeOthers).toHaveBeenCalledWith("tab-1"));
  });

  it("renames a tab inline by double-click", async () => {
    const { bridge } = installBridge();
    const request = vi.fn(async () => ({ name: "Renamed" }));
    (bridge.sessions as unknown as { request: unknown }).request = request;
    render(<TabStrip />);

    fireEvent.doubleClick(screen.getByRole("tab", { name: /pi-desktop/ }));
    const input = screen.getByRole("textbox", { name: "Rename pi-desktop" });
    await userEvent.clear(input);
    await userEvent.type(input, "Renamed{Enter}");

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "session.rename", params: { name: "Renamed" } }),
    );
    expect(screen.queryByRole("textbox", { name: /Rename pi-desktop/ })).toBeNull();
  });
});

/**
 * Open the lifecycle menu through its keyboard path. jsdom's synthetic
 * pointerdown can be swallowed by a previous test's focus/pointer state; the
 * trigger's Enter path is the same Radix menu and is deterministic.
 */
function openTabMenu(title: string): void {
  const trigger = screen.getByRole("button", { name: `Actions for ${title}` });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
}
