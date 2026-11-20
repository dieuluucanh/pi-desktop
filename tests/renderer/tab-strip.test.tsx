import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import { SessionTabStrip } from "../../src/renderer/src/layout/SessionTabStrip";
import { tabMenuItems } from "../../src/renderer/src/layout/tab-menu";
import { TAB_DRAG_MIME, TAB_DRAG_VERSION } from "../../src/shared/tab-drag";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { isTabDragActive } from "../../src/renderer/src/state/tab-drag-session";
import { installBridge } from "./fixtures";

/**
 * Tab strip lifecycle (plan step 11).
 *
 * The strip is the session's cockpit: every lifecycle action (rename, duplicate,
 * clone, fork, export, reveal, close, close others) is reachable from a tab's
 * right-click menu, and tab reordering is persisted by the session service.
 *
 * The menu's *contents* are asserted against the pure `tabMenuItems()` list so
 * the contract is pinned without opening a Radix menu in jsdom; one interaction
 * test then proves the menu is wired to the store.
 */

const WORK = "C:\\work\\pi-desktop";

const originalClipboard = navigator.clipboard;

function stubClipboard(writeText: ((text: string) => Promise<void>) | null): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: originalClipboard,
  });
});

/** jsdom has no `DataTransfer`; the strip only needs these members. */
function fakeTransfer() {
  const data = new Map<string, string>();
  return {
    types: [] as string[],
    effectAllowed: "none",
    setData(type: string, value: string): void {
      data.set(type, value);
      if (!this.types.includes(type)) this.types.push(type);
    },
    getData(type: string): string {
      return data.get(type) ?? "";
    },
  };
}

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
      "copy-session-path",
      "pin",
      "close",
      "close-others",
      "close-all",
    ]);
    expect(items.map((item) => item.label)).toEqual([
      "Rename…",
      "Duplicate in this project",
      "Browse history tree…",
      "Fork from a message…",
      "Clone session",
      "Export to HTML",
      "Reveal session file",
      "Copy Path",
      "Pin",
      "Close",
      "Close others",
      "Close all sessions",
    ]);
    expect(items.find((item) => item.id === "close-others")?.destructive).toBe(true);
    expect(items.find((item) => item.id === "close-all")?.destructive).toBe(true);
  });

  it("offers absolute/relative paths, pin and kind-scoped close on editor tabs", () => {
    const items = tabMenuItems("editor");
    expect(items.map((item) => item.id)).toEqual([
      "save",
      "copy-absolute-path",
      "copy-relative-path",
      "reveal",
      "pin",
      "close",
      "close-others",
      "close-all",
    ]);
    expect(items.find((item) => item.id === "close-all")?.label).toBe("Close all editor tabs");
    expect(tabMenuItems("editor", true).map((item) => item.id)).toContain("unpin");
  });

  it("enables Copy Path only once the session has a file", () => {
    const withFile = tabMenuItems("session", false, { sessionFile: `${WORK}\\s1.jsonl` });
    expect(withFile.find((item) => item.id === "copy-session-path")).toMatchObject({
      label: "Copy Path",
      disabled: false,
    });

    const withoutFile = tabMenuItems("session", false, { sessionFile: null });
    expect(withoutFile.find((item) => item.id === "copy-session-path")?.disabled).toBe(true);
  });
});

describe("SessionTabStrip", () => {
  it("renders a tab per session and shows its status", () => {
    installBridge();
    render(<SessionTabStrip />);

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
    expect(screen.getByRole("tab", { name: /pi-desktop/ })).toHaveAttribute(
      "aria-keyshortcuts",
      "Shift+F10",
    );
  });

  it("keeps editor tabs out of the session strip", () => {
    installBridge();
    useAppStore.setState({
      tabs: [
        tab(),
        tab({
          id: "editor-1",
          kind: "editor",
          title: "a.ts",
          filePath: "a.ts",
          sessionFile: null,
        }),
      ],
    });
    render(<SessionTabStrip />);

    expect(screen.queryByTestId("tab-editor-1")).toBeNull();
    expect(screen.getByRole("tab", { name: /pi-desktop/ })).toBeInTheDocument();
  });

  it("shows the sidebar expand control only while the sidebar is collapsed", async () => {
    installBridge();
    expect(screen.queryByRole("button", { name: "Show sidebar" })).toBeNull();
    useAppStore.setState({ prefs: { ...DEFAULT_PREFS, sidebarCollapsed: true } });
    render(<SessionTabStrip />);
    await userEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
    expect(useAppStore.getState().prefs.sidebarCollapsed).toBe(false);
  });

  it("activates a tab when clicked", () => {
    const { bridge } = installBridge();
    const activate = vi.fn(async () => ({ tabs: [], activeTabId: "tab-2" }));
    (bridge.sessions as unknown as { activate: unknown }).activate = activate;

    render(<SessionTabStrip />);
    fireEvent.click(screen.getByRole("tab", { name: /second/ }));

    expect(activate).toHaveBeenCalledWith("tab-2");
  });

  it("closes a tab from its X", async () => {
    const { bridge } = installBridge();
    const close = vi.fn(async () => ({ tabs: [], activeTabId: null }));
    (bridge.sessions as unknown as { close: unknown }).close = close;

    render(<SessionTabStrip />);
    fireEvent.click(screen.getByRole("button", { name: "Close pi-desktop" }));

    await waitFor(() => expect(close).toHaveBeenCalledWith("tab-1"));
  });

  it("reorders tabs by drag and drop", () => {
    const { bridge } = installBridge();
    const reorder = vi.fn(async () => ({ tabs: [], activeTabId: null }));
    (bridge.sessions as unknown as { reorder: unknown }).reorder = reorder;

    render(<SessionTabStrip />);
    const first = screen.getByTestId("tab-tab-1");
    const second = screen.getByTestId("tab-tab-2");
    fireEvent.dragStart(first);
    fireEvent.dragOver(second);
    fireEvent.drop(second);

    expect(reorder).toHaveBeenCalledWith("tab-1", 1);
  });

  it("publishes the typed tab payload so a grid pane can accept the drag", () => {
    // One gesture, two consumers (2026-11-03 grid plan): the strip reorders from
    // its own `dragId`, and a pane reads this MIME on drop.
    installBridge();
    render(<SessionTabStrip />);

    const transfer = fakeTransfer();
    fireEvent.dragStart(screen.getByTestId("tab-tab-2"), { dataTransfer: transfer });

    expect(transfer.getData(TAB_DRAG_MIME)).toBe(
      JSON.stringify({ version: TAB_DRAG_VERSION, tabId: "tab-2" }),
    );
    expect(transfer.effectAllowed).toBe("move");
    expect(isTabDragActive()).toBe(true);

    fireEvent.dragEnd(screen.getByTestId("tab-tab-2"), { dataTransfer: transfer });
    expect(isTabDragActive()).toBe(false);
  });

  it("closes other tabs through the service", async () => {
    const { bridge } = installBridge();
    const closeOthers = vi.fn(async () => ({ tabs: [tab()], activeTabId: "tab-1" }));
    (bridge.sessions as unknown as { closeOthers: unknown }).closeOthers = closeOthers;

    render(<SessionTabStrip />);
    fireEvent.contextMenu(screen.getByTestId("tab-tab-1"));
    await waitFor(() => expect(screen.getByText("Close others")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Close others"));

    await waitFor(() => expect(closeOthers).toHaveBeenCalledWith("tab-1"));
  });

  it("copies the session path from its context menu", async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboard(writeText);
    installBridge();
    render(<SessionTabStrip />);

    fireEvent.contextMenu(screen.getByTestId("tab-tab-1"));
    await waitFor(() => expect(screen.getByText("Copy Path")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Copy Path"));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${WORK}\\sessions\\s1.jsonl`));
    expect(useAppStore.getState().hint).toMatch(/Session path copied/);
  });

  it("renders no per-tab overflow trigger", () => {
    installBridge();
    render(<SessionTabStrip />);

    // The right-click menu replaced the ⋯ button (2026-11-03 plan): a chip is
    // its tab button plus the close ×, never a third control.
    expect(screen.queryByRole("button", { name: /^Actions for / })).toBeNull();
    const chip = screen.getByTestId("tab-tab-1");
    expect(within(chip).getAllByRole("tab")).toHaveLength(1);
    expect(
      within(chip)
        .getAllByRole("button")
        .map((node) => node.getAttribute("aria-label")),
    ).toEqual(["Close pi-desktop"]);
  });

  it("keeps a pinned chip to its tab button only", () => {
    installBridge();
    useAppStore.setState({ tabs: [{ ...tab(), pinned: true }], activeTabId: "tab-1" });
    render(<SessionTabStrip />);

    expect(screen.queryByRole("button", { name: /^Actions for / })).toBeNull();
    const chip = screen.getByTestId("tab-tab-1");
    expect(within(chip).getAllByRole("tab")).toHaveLength(1);
    expect(within(chip).queryAllByRole("button")).toHaveLength(0);
  });

  it("opens the lifecycle menu from a right-click", async () => {
    installBridge();
    render(<SessionTabStrip />);

    fireEvent.contextMenu(screen.getByTestId("tab-tab-1"));

    expect(await screen.findByText("Close all sessions")).toBeInTheDocument();
  });

  it("opens the same menu from Shift+F10", async () => {
    installBridge();
    render(<SessionTabStrip />);

    const tabButton = screen.getByRole("tab", { name: /pi-desktop/ });
    tabButton.focus();
    // `false` means the keydown was default-prevented, so Chromium's own
    // Shift+F10 context menu cannot open a second time.
    expect(fireEvent.keyDown(tabButton, { key: "F10", shiftKey: true })).toBe(false);

    expect(await screen.findByText("Close others")).toBeInTheDocument();
  });

  it("treats the Menu key as the same shortcut", async () => {
    installBridge();
    render(<SessionTabStrip />);

    fireEvent.keyDown(screen.getByRole("tab", { name: /pi-desktop/ }), { key: "ContextMenu" });

    expect(await screen.findByText("Close others")).toBeInTheDocument();
  });

  it("returns focus to the tab when Escape closes the keyboard menu", async () => {
    installBridge();
    render(<SessionTabStrip />);

    const tabButton = screen.getByRole("tab", { name: /pi-desktop/ });
    tabButton.focus();
    fireEvent.keyDown(tabButton, { key: "F10", shiftKey: true });
    await screen.findByText("Close others");

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    await waitFor(() => expect(screen.queryByText("Close others")).toBeNull());
    expect(document.activeElement).toBe(tabButton);
  });

  it("leaves the inline rename input alone when the menu key is pressed", () => {
    installBridge();
    render(<SessionTabStrip />);

    fireEvent.doubleClick(screen.getByRole("tab", { name: /pi-desktop/ }));
    const input = screen.getByRole("textbox", { name: "Rename pi-desktop" });
    fireEvent.keyDown(input, { key: "F10", shiftKey: true });

    expect(screen.queryByText("Close others")).toBeNull();
  });

  it("renames a tab inline by double-click", async () => {
    const { bridge } = installBridge();
    const request = vi.fn(async () => ({ name: "Renamed" }));
    (bridge.sessions as unknown as { request: unknown }).request = request;
    render(<SessionTabStrip />);

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
