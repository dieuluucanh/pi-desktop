import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import type { WebTabState } from "../../src/shared/web-tabs";
import { tabMenuItems } from "../../src/renderer/src/layout/tab-menu";
import { WebTabView } from "../../src/renderer/src/web/WebTabView";
import { WebNavigationDialog } from "../../src/renderer/src/web/WebNavigationDialog";
import { WebUrlDialog } from "../../src/renderer/src/web/WebUrlDialog";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { installBridge } from "./fixtures";

/**
 * The web tab's chrome (plan step 21). The page itself is native and untestable
 * in jsdom, so what is pinned is exactly the part this component owns: the
 * toolbar commands, the retry affordance, the rectangle it reports to main, and
 * the two dialogs that open and answer a web tab.
 */

const URL = "http://127.0.0.1:19432/review/abc";

function tab(overrides: Partial<TabRecord> = {}): TabRecord {
  return {
    id: "w1",
    kind: "web",
    cwd: "",
    title: "127.0.0.1:19432",
    sessionFile: null,
    status: "idle",
    createdAt: 0,
    lastActiveAt: 0,
    model: null,
    url: URL,
    sessionTabId: "s1",
    ...overrides,
  };
}

function state(overrides: Partial<WebTabState> = {}): WebTabState {
  return {
    tabId: "w1",
    url: URL,
    title: "Plannotator review",
    favicon: null,
    status: "ready",
    canGoBack: true,
    canGoForward: false,
    zoom: 1,
    error: null,
    sessionTabId: "s1",
    loadedAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    view: "session",
    prefs: { ...DEFAULT_PREFS },
    hint: null,
    tabs: [tab()],
    activeTabId: "w1",
    webTabStates: { w1: state() },
    webNavigationPrompt: null,
    webUrlDialogOpen: false,
  });
});

describe("web tab menu", () => {
  it("offers the chrome commands, not session lifecycle", () => {
    expect(tabMenuItems("web").map((item) => item.id)).toEqual([
      "reload",
      "copy-url",
      "open-browser",
      "pin",
      "close",
      "close-others",
      "close-all",
    ]);
  });
});

describe("WebTabView", () => {
  it("renders the address, title and zoom controls", () => {
    render(<WebTabView tab={tab()} />);
    expect(screen.getByLabelText("Web address")).toHaveValue(URL);
    expect(screen.getByText("Plannotator review")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Forward" })).toBeDisabled();
  });

  it("forwards chrome clicks as commands", () => {
    const handles = installBridge();
    render(<WebTabView tab={tab()} />);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(handles.webCommands.map((entry) => entry.command)).toEqual([
      { command: "back" },
      { command: "reload" },
      { command: "zoom", factor: 1.1 },
    ]);
  });

  it("navigates to a typed address and refuses a non-http one", () => {
    const handles = installBridge();
    render(<WebTabView tab={tab()} />);
    const field = screen.getByLabelText("Web address");

    fireEvent.change(field, { target: { value: "http://localhost:5173/app" } });
    fireEvent.submit(field.closest("form")!);
    expect(handles.webCommands.at(-1)).toEqual({
      tabId: "w1",
      command: { command: "navigate", url: "http://localhost:5173/app" },
    });

    fireEvent.change(field, { target: { value: "javascript:alert(1)" } });
    fireEvent.submit(field.closest("form")!);
    expect(useAppStore.getState().hint).toMatch(/not an http/i);
  });

  it("reports a rectangle to main on mount and hides the view on unmount", async () => {
    const handles = installBridge();
    const view = render(<WebTabView tab={tab()} />);
    await waitFor(() => expect(handles.webBounds.length).toBeGreaterThan(0));
    expect(handles.webBounds[0]).toMatchObject({ tabId: "w1", bounds: { visible: true } });

    const before = handles.webBounds.length;
    view.unmount();
    expect(handles.webBounds.length).toBeGreaterThan(before);
    expect(handles.webBounds.at(-1)?.bounds.visible).toBe(false);
  });

  it("shows a retry affordance when the page failed", () => {
    useAppStore.setState({
      webTabStates: { w1: state({ status: "failed", error: "ERR_CONNECTION_REFUSED" }) },
    });
    const handles = installBridge();
    render(<WebTabView tab={tab()} />);

    expect(screen.getByText("This page could not be reached.")).toBeInTheDocument();
    expect(screen.getByText("ERR_CONNECTION_REFUSED")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(handles.webCommands.at(-1)?.command).toEqual({ command: "reload" });
  });
});

describe("WebNavigationDialog", () => {
  it("answers with the chosen action", async () => {
    const handles = installBridge();
    useAppStore.setState({
      webNavigationPrompt: {
        tabId: "w1",
        url: "https://example.com/leave",
        disposition: "link",
        at: 1,
      },
    });
    render(<WebNavigationDialog />);

    expect(screen.getByText("Open this link?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open in browser" }));

    await waitFor(() => expect(handles.webDecisions.at(-1)).toMatchObject({ action: "external" }));
    expect(useAppStore.getState().webNavigationPrompt).toBeNull();
  });

  it("renders nothing with no pending request", () => {
    const { container } = render(<WebNavigationDialog />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("WebUrlDialog", () => {
  it("opens the typed URL in a web tab", async () => {
    const handles = installBridge();
    useAppStore.setState({ webUrlDialogOpen: true });
    render(<WebUrlDialog />);

    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "http://localhost:5173/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() => expect(handles.webOpened).toEqual([{ url: "http://localhost:5173/" }]));
    expect(useAppStore.getState().webUrlDialogOpen).toBe(false);
  });

  it("refuses a non-http URL with a hint", () => {
    installBridge();
    useAppStore.setState({ webUrlDialogOpen: true });
    render(<WebUrlDialog />);

    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "file:///etc/passwd" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(useAppStore.getState().hint).toMatch(/http/i);
    expect(useAppStore.getState().webUrlDialogOpen).toBe(true);
  });
});
