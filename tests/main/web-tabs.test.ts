import { describe, expect, it } from "vitest";
import {
  createWebTabManager,
  type WebViewEvent,
  type WebViewLike,
  type WebViewNavigationRequest,
} from "../../src/main/web-tabs";
import type { SessionTabsEnvelope, TabRecord } from "../../src/shared/session-ipc";
import type { WebTabState } from "../../src/shared/web-tabs";

/**
 * The web-tab service (plan step 21) is driven against a fake view: no Electron,
 * no window. What is pinned here is the reconciliation with the tab table, the
 * chrome commands, and the navigation policy that keeps an unrelated link from
 * silently replacing a review.
 */

function webTab(id: string, url: string, sessionTabId: string | null = null): TabRecord {
  return {
    id,
    kind: "web",
    cwd: "",
    title: url,
    sessionFile: null,
    status: "idle",
    createdAt: 0,
    lastActiveAt: 0,
    model: null,
    url,
    sessionTabId,
  };
}

function sessionTab(id: string): TabRecord {
  return {
    id,
    kind: "session",
    cwd: "C:\\work\\app",
    title: "app",
    sessionFile: null,
    status: "idle",
    createdAt: 0,
    lastActiveAt: 0,
    model: null,
  };
}

function envelope(tabs: TabRecord[], activeTabId: string | null): SessionTabsEnvelope {
  return { tabs, activeTabId };
}

/** The normalized view: `emit` fires exactly what `src/main/web-view-host.ts` would. */
class FakeView implements WebViewLike {
  url = "";
  zoom = 1;
  back = false;
  forward = false;
  readonly loaded: string[] = [];
  goBackCount = 0;
  goForwardCount = 0;
  reloadCount = 0;
  stopCount = 0;
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  visible = false;
  closed = false;
  private readonly listeners = new Map<WebViewEvent, Set<(payload?: unknown) => void>>();

  readonly webContents = {
    loadURL: (url: string): Promise<void> => {
      this.loaded.push(url);
      this.url = url;
      return Promise.resolve();
    },
    getURL: (): string => this.url,
    canGoBack: (): boolean => this.back,
    canGoForward: (): boolean => this.forward,
    goBack: (): void => {
      this.goBackCount += 1;
    },
    goForward: (): void => {
      this.goForwardCount += 1;
    },
    reload: (): void => {
      this.reloadCount += 1;
    },
    stop: (): void => {
      this.stopCount += 1;
    },
    setZoomFactor: (factor: number): void => {
      this.zoom = factor;
    },
  };

  on(event: WebViewEvent, listener: (payload?: unknown) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return () => set.delete(listener);
  }

  emit(event: WebViewEvent, payload?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = bounds;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
  }

  close(): void {
    this.closed = true;
  }
}

function harness(): {
  manager: ReturnType<typeof createWebTabManager>;
  views: Map<string, FakeView>;
  closed: Set<string>;
  states: WebTabState[];
  requests: Array<{ tabId: string; url: string; disposition: string }>;
} {
  const views = new Map<string, FakeView>();
  const closed = new Set<string>();
  const states: WebTabState[] = [];
  const requests: Array<{ tabId: string; url: string; disposition: string }> = [];
  const manager = createWebTabManager({
    createView: {
      create: ({ tabId, url }) => {
        const view = new FakeView();
        view.url = url;
        view.close = () => {
          view.closed = true;
          closed.add(tabId);
        };
        views.set(tabId, view);
        return view;
      },
    },
    emitState: (state) => states.push(state),
    emitNavigationRequest: (request) => requests.push(request),
    now: () => 1_000,
  });
  return { manager, views, closed, states, requests };
}

describe("createWebTabManager", () => {
  it("opens a view for a web tab and ignores host-backed tabs", () => {
    const { manager, views, states } = harness();
    manager.sync(envelope([sessionTab("s1"), webTab("w1", "http://localhost:19432/review")], "w1"));

    expect([...views.keys()]).toEqual(["w1"]);
    expect(views.get("w1")!.loaded).toEqual(["http://localhost:19432/review"]);
    expect(states[0]).toMatchObject({
      tabId: "w1",
      url: "http://localhost:19432/review",
      status: "loading",
      sessionTabId: null,
    });
  });

  it("shows only the active tab's view", () => {
    const { manager, views } = harness();
    const both = [webTab("w1", "http://localhost:1/"), webTab("w2", "http://localhost:2/")];
    manager.sync(envelope(both, "w1"));
    expect(views.get("w1")!.visible).toBe(true);
    expect(views.get("w2")!.visible).toBe(false);

    manager.sync(envelope(both, "w2"));
    expect(views.get("w1")!.visible).toBe(false);
    expect(views.get("w2")!.visible).toBe(true);
  });

  it("closes a view when its tab is closed or stops being a web tab", () => {
    const { manager, views, closed } = harness();
    manager.sync(envelope([webTab("w1", "http://localhost:1/")], "w1"));
    expect(views.get("w1")!.closed).toBe(false);

    manager.sync(envelope([], null));
    expect(views.get("w1")!.closed).toBe(true);
    expect(closed.has("w1")).toBe(true);
    expect(manager.states()).toEqual([]);
  });

  it("keeps the recorded bounds and hides the view when the renderer says so", () => {
    const { manager, views } = harness();
    manager.sync(envelope([webTab("w1", "http://localhost:1/")], "w1"));

    manager.setBounds("w1", { x: 200.4, y: 40.6, width: 800.2, height: 600.9, visible: false });
    expect(views.get("w1")!.bounds).toEqual({ x: 200, y: 41, width: 800, height: 601 });
    expect(views.get("w1")!.visible).toBe(false);

    manager.setBounds("w1", { x: 0, y: 0, width: 10, height: 10 });
    expect(views.get("w1")!.visible).toBe(true);
  });

  it("ignores bounds for a tab it does not own", () => {
    const { manager } = harness();
    expect(() => manager.setBounds("nope", { x: 0, y: 0, width: 1, height: 1 })).not.toThrow();
  });

  it("runs the chrome commands", () => {
    const { manager, views } = harness();
    manager.sync(envelope([webTab("w1", "http://localhost:1/")], "w1"));
    const view = views.get("w1")!;
    view.back = true;
    view.forward = true;

    manager.command("w1", { command: "back" });
    manager.command("w1", { command: "forward" });
    manager.command("w1", { command: "reload" });
    manager.command("w1", { command: "stop" });
    manager.command("w1", { command: "zoom", factor: 1.5 });
    manager.command("w1", { command: "navigate", url: "http://localhost:2/next" });
    manager.command("w1", { command: "unknown" });

    expect(view.goBackCount).toBe(1);
    expect(view.goForwardCount).toBe(1);
    expect(view.reloadCount).toBe(1);
    expect(view.stopCount).toBe(1);
    expect(view.zoom).toBe(1.5);
    expect(view.loaded.at(-1)).toBe("http://localhost:2/next");
  });

  it("navigates only to permitted URLs in existing tabs", () => {
    const { manager, views } = harness();
    manager.sync(envelope([webTab("w1", "http://localhost:1/")], "w1"));

    expect(manager.navigate("w1", "http://localhost:2/")).toBe(true);
    expect(views.get("w1")!.loaded.at(-1)).toBe("http://localhost:2/");
    expect(manager.navigate("w1", "file:///etc/passwd")).toBe(false);
    expect(manager.navigate("missing", "http://localhost:2/")).toBe(false);
    expect(manager.navigate("w1", "not a url")).toBe(false);
  });

  it("loads loopback navigations without asking and asks for anything else", () => {
    const { manager, views, requests } = harness();
    manager.sync(envelope([webTab("w1", "http://localhost:19432/review")], "w1"));
    const view = views.get("w1")!;

    let prevented = false;
    view.emit("navigation-request", {
      url: "http://127.0.0.1:19432/other",
      disposition: "link",
      prevent: () => {
        prevented = true;
      },
    } satisfies WebViewNavigationRequest);
    expect(prevented).toBe(false);
    expect(requests).toEqual([]);

    view.emit("navigation-request", {
      url: "https://example.com/leave",
      disposition: "link",
      prevent: () => {
        prevented = true;
      },
    } satisfies WebViewNavigationRequest);
    expect(prevented).toBe(true);
    expect(requests).toEqual([
      { tabId: "w1", url: "https://example.com/leave", disposition: "link", at: 1_000 },
    ]);
  });

  it("refuses an unsupported navigation URL outright", () => {
    const { manager, views, requests } = harness();
    manager.sync(envelope([webTab("w1", "http://localhost:1/")], "w1"));
    let prevented = false;
    views.get("w1")!.emit("navigation-request", {
      url: "javascript:alert(1)",
      disposition: "link",
      prevent: () => {
        prevented = true;
      },
    } satisfies WebViewNavigationRequest);
    expect(prevented).toBe(true);
    expect(requests).toEqual([]);
  });

  it("projects load, title, favicon, navigation and failure events", () => {
    const { manager, views, states } = harness();
    manager.sync(envelope([webTab("w1", "http://localhost:1/")], "w1"));
    const view = views.get("w1")!;

    view.emit("title", "Plannotator review");
    view.emit("favicon", ["file:///nope", "http://localhost:1/favicon.ico"]);
    view.url = "http://localhost:1/review/2";
    view.back = true;
    view.emit("navigated");
    view.emit("loaded");

    const last = states.at(-1)!;
    expect(last).toMatchObject({
      title: "Plannotator review",
      favicon: "http://localhost:1/favicon.ico",
      url: "http://localhost:1/review/2",
      canGoBack: true,
      status: "ready",
      loadedAt: 1_000,
    });

    view.emit("failed", { errorDescription: "ERR_CONNECTION_REFUSED" });
    expect(states.at(-1)).toMatchObject({
      status: "failed",
      error: "ERR_CONNECTION_REFUSED",
    });
  });

  it("reports state and every state, then tears everything down", () => {
    const { manager, views, closed } = harness();
    manager.sync(envelope([webTab("w1", "http://localhost:1/")], "w1"));
    expect(manager.state("w1")?.tabId).toBe("w1");
    expect(manager.state("missing")).toBeNull();
    expect(manager.states().map((state) => state.tabId)).toEqual(["w1"]);

    manager.dispose();
    expect(views.get("w1")!.closed).toBe(true);
    expect(closed.has("w1")).toBe(true);
    expect(manager.states()).toEqual([]);
  });

  it("re-emits a restored tab's state after a relaunch", () => {
    const { manager, views } = harness();
    // `restoreTabs` republishes the persisted table; sync rebuilds the view.
    manager.sync(envelope([webTab("w1", "http://localhost:19432/review", "s1")], "w1"));
    expect(views.get("w1")!.loaded).toEqual(["http://localhost:19432/review"]);
    expect(manager.state("w1")?.sessionTabId).toBe("s1");
  });
});
