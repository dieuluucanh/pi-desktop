import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import type { WebTabState } from "../../src/shared/web-tabs";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { installBridge } from "./fixtures";

/**
 * The renderer's web-tab slice (plan step 21): it applies the state pushes from
 * main, opens a page once per URL, forwards the chrome commands, reports the
 * native view's rectangle, and answers a refused navigation.
 */

function state(overrides: Partial<WebTabState> = {}): WebTabState {
  return {
    tabId: "w1",
    url: "http://localhost:19432/review",
    title: "Review",
    favicon: null,
    status: "ready",
    canGoBack: false,
    canGoForward: false,
    zoom: 1,
    error: null,
    sessionTabId: "s1",
    loadedAt: 1,
    ...overrides,
  };
}

function webRecord(overrides: Partial<TabRecord> = {}): TabRecord {
  return {
    id: "w1",
    kind: "web",
    cwd: "",
    title: "localhost:19432",
    sessionFile: null,
    status: "idle",
    createdAt: 0,
    lastActiveAt: 0,
    model: null,
    url: "http://localhost:19432/review",
    sessionTabId: "s1",
    ...overrides,
  };
}

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    view: "session",
    prefs: { ...DEFAULT_PREFS },
    hint: null,
    tabs: [],
    activeTabId: null,
    webTabStates: {},
    webNavigationPrompt: null,
    webUrlDialogOpen: false,
  });
});

describe("web tab state", () => {
  it("applies a pushed state per tab", () => {
    useAppStore.getState().applyWebTabState(state());
    expect(useAppStore.getState().webTabStates["w1"]).toMatchObject({
      url: "http://localhost:19432/review",
      status: "ready",
    });
    useAppStore.getState().applyWebTabState(state({ tabId: "w2", url: "http://localhost:2/" }));
    expect(Object.keys(useAppStore.getState().webTabStates).sort()).toEqual(["w1", "w2"]);
  });

  it("drops a closed tab's state and its pending navigation prompt", () => {
    useAppStore.setState({
      tabs: [webRecord()],
      activeTabId: "w1",
      webTabStates: { w1: state() },
      webNavigationPrompt: { tabId: "w1", url: "https://example.com", disposition: "link", at: 1 },
    });

    useAppStore.getState().applyTabs({ tabs: [], activeTabId: null });

    expect(useAppStore.getState().webTabStates).toEqual({});
    expect(useAppStore.getState().webNavigationPrompt).toBeNull();
  });
});

describe("openWebTab", () => {
  it("opens a new tab through the bridge", async () => {
    const handles = installBridge();
    await useAppStore.getState().openWebTab({ url: "http://localhost:19432/review" });

    expect(handles.webOpened).toEqual([{ url: "http://localhost:19432/review" }]);
    expect(useAppStore.getState().view).toBe("session");
  });

  it("focuses an existing tab for the same URL instead of opening a second", async () => {
    const handles = installBridge();
    const existing = webRecord();
    useAppStore.setState({
      tabs: [existing, webRecord({ id: "w2", url: "http://localhost:2/" })],
      activeTabId: "w2",
    });
    // The fixture's sessions bridge is a stub; activation must echo the tab
    // table the way main does, or `applyTabs` would clear the active id.
    const activate = async (tabId: string) => ({
      tabs: [existing, webRecord({ id: "w2", url: "http://localhost:2/" })],
      activeTabId: tabId,
    });
    (window.pi as unknown as { sessions: { activate: unknown } }).sessions.activate = activate;

    await useAppStore.getState().openWebTab({ url: "http://localhost:19432/review" });

    expect(handles.webOpened).toEqual([]);
    expect(useAppStore.getState().activeTabId).toBe("w1");
  });

  it("reports a bridge without a web surface", async () => {
    const handles = installBridge();
    (window.pi as unknown as { web?: unknown }).web = undefined;
    const opened = await useAppStore.getState().openWebTab({ url: "http://localhost:1/" });
    expect(opened).toBe(false);
    expect(useAppStore.getState().hint).toMatch(/preload bridge/i);
    expect(handles.webOpened).toEqual([]);
  });
});

describe("chrome commands and bounds", () => {
  it("forwards commands and bounds to main", () => {
    const handles = installBridge();
    useAppStore.getState().webCommand("w1", { command: "reload" });
    useAppStore.getState().setWebTabBounds("w1", {
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      visible: true,
    });
    expect(handles.webCommands).toEqual([{ tabId: "w1", command: { command: "reload" } }]);
    expect(handles.webBounds).toEqual([
      { tabId: "w1", bounds: { x: 1, y: 2, width: 3, height: 4, visible: true } },
    ]);
  });
});

describe("navigation decisions", () => {
  it("answers with the chosen action and clears the prompt", async () => {
    const handles = installBridge();
    useAppStore.setState({
      webTabStates: { w1: state() },
      webNavigationPrompt: {
        tabId: "w1",
        url: "https://example.com/leave",
        disposition: "link",
        at: 1,
      },
    });

    await useAppStore.getState().answerWebNavigation("external");

    expect(handles.webDecisions).toEqual([
      { tabId: "w1", url: "https://example.com/leave", action: "external" },
    ]);
    expect(useAppStore.getState().webNavigationPrompt).toBeNull();
  });

  it("carries the session link when opening in a new tab", async () => {
    const handles = installBridge();
    useAppStore.setState({
      webTabStates: { w1: state() },
      webNavigationPrompt: {
        tabId: "w1",
        url: "https://example.com/leave",
        disposition: "link",
        at: 1,
      },
    });

    await useAppStore.getState().answerWebNavigation("new-tab");

    expect(handles.webDecisions[0]).toMatchObject({ action: "new-tab", sessionTabId: "s1" });
  });

  it("drops a dismissed prompt without calling main", () => {
    const handles = installBridge();
    useAppStore.setState({
      webNavigationPrompt: {
        tabId: "w1",
        url: "https://example.com",
        disposition: "link",
        at: 1,
      },
    });
    useAppStore.getState().dismissWebNavigation();
    expect(useAppStore.getState().webNavigationPrompt).toBeNull();
    expect(handles.webDecisions).toEqual([]);
  });
});

describe("the manual URL dialog", () => {
  it("opens and closes", () => {
    useAppStore.getState().openWebUrlDialog();
    expect(useAppStore.getState().webUrlDialogOpen).toBe(true);
    useAppStore.getState().closeWebUrlDialog();
    expect(useAppStore.getState().webUrlDialogOpen).toBe(false);
  });
});

describe("automatic loopback detection (plan step 21)", () => {
  it("opens a review URL that arrives in an extension notification", async () => {
    const handles = installBridge();
    useAppStore.setState({ tabs: [], activeTabId: null, webTabStates: {}, transcripts: {} });

    useAppStore.getState().handleExtensionUiEvent("s1", {
      event: "oi.notify",
      payload: { message: "Review ready at http://127.0.0.1:19432/review/abc" },
    });

    await vi.waitFor(() =>
      expect(handles.webOpened).toEqual([
        { url: "http://127.0.0.1:19432/review/abc", sessionTabId: "s1" },
      ]),
    );
  });

  it("ignores a notification with no loopback URL", async () => {
    const handles = installBridge();
    useAppStore.setState({ tabs: [], activeTabId: null, webTabStates: {}, transcripts: {} });

    useAppStore.getState().handleExtensionUiEvent("s1", {
      event: "oi.notify",
      payload: { message: "See https://example.com/docs for details" },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handles.webOpened).toEqual([]);
  });

  it("opens a loopback URL found in a tool result", async () => {
    const handles = installBridge();
    useAppStore.setState({
      tabs: [
        {
          id: "s1",
          kind: "session",
          cwd: "C:/work/app",
          title: "app",
          sessionFile: "C:/profile/s1.jsonl",
          status: "idle",
          createdAt: 1,
          lastActiveAt: 1,
          model: null,
        },
      ],
      activeTabId: "s1",
      webTabStates: {},
      transcripts: {},
    });

    useAppStore.getState().applySessionEvents({
      tabId: "s1",
      seq: 1,
      events: [
        {
          event: "tool_execution_end",
          payload: {
            toolCallId: "t1",
            result: { content: [{ type: "text", text: "open http://localhost:5173/app" }] },
          },
        },
      ],
    });

    await vi.waitFor(() =>
      expect(handles.webOpened).toEqual([{ url: "http://localhost:5173/app", sessionTabId: "s1" }]),
    );
  });

  it("does not steal focus for a loopback URL already open", async () => {
    const handles = installBridge();
    useAppStore.setState({
      tabs: [webRecord()],
      activeTabId: "w1",
      webTabStates: { w1: state() },
      transcripts: {},
    });

    useAppStore.getState().handleExtensionUiEvent("s1", {
      event: "oi.notify",
      payload: { message: "Still at http://localhost:19432/review" },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handles.webOpened).toEqual([]);
  });
});
