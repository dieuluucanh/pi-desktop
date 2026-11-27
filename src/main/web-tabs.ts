import type { SessionTabsEnvelope, TabRecord } from "../shared/session-ipc";
import {
  emptyWebTabState,
  isLoopbackUrl,
  parseWebCommand,
  sanitizeWebTabBounds,
  sanitizeWebUrl,
  type WebCommand,
  type WebNavigationDisposition,
  type WebNavigationRequest,
  type WebTabState,
} from "../shared/web-tabs";

/**
 * The web-tab service (plan step 21): the app's tab table knows *that* a web tab
 * exists, and this service owns the `WebContentsView` behind it.
 *
 * It is deliberately Electron-free. The native view is injected as a small
 * `WebViewLike` port whose events are already normalized away from Electron's
 * `(event, …)` signatures, so the reconciliation, the chrome commands, the
 * navigation policy (loopback loads without a prompt, everything else asks
 * first) and the state projection are unit testable with a fake view and no
 * window at all. The Electron adapter lives in `src/main/web-view-host.ts`.
 *
 * The service never creates or deletes tabs — the session service does that.
 * `sync()` reconciles the views to whatever tab table was last published, which
 * is also how a web tab survives an app restart: the restored tab table
 * republishes and the view is rebuilt.
 */

/** A navigation the app did not author; the renderer decides what to do. */
export interface WebViewNavigationRequest {
  url: string;
  disposition: WebNavigationDisposition;
  /** Refuses an in-page navigation; a no-op for `new-window`. */
  prevent(): void;
}

/** Normalized events the service consumes (never Electron's own signatures). */
export type WebViewEvent =
  | "loading"
  | "loaded"
  | "navigated"
  | "title"
  | "favicon"
  | "failed"
  | "navigation-request"
  // The page called window.close() (the browser-like close request).
  | "close-requested"
  // The webContents is gone (the page closed itself or the view was torn down).
  | "destroyed";

/** The slice of `WebContentsView`'s webContents the service drives. */
export interface WebViewContentsLike {
  loadURL(url: string): Promise<void> | void;
  /** The real current URL; used after a prevented navigation. */
  getURL(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  setZoomFactor(factor: number): void;
  /** Optional so the manager policy can land before the Electron adapter. */
  isDestroyed?(): boolean;
}

/** The slice of `WebContentsView` the service drives. */
export interface WebViewLike {
  readonly webContents: WebViewContentsLike;
  /** Subscribes to a normalized event; returns an unsubscriber. */
  on(event: WebViewEvent, listener: (payload?: unknown) => void): () => void;
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  setVisible(visible: boolean): void;
  close?(): void;
}

export interface WebViewFactory {
  create(input: { tabId: string; url: string }): WebViewLike;
}

export interface WebTabManagerDeps {
  createView: WebViewFactory;
  /** Pushes one tab's state to the renderer after every change. */
  emitState: (state: WebTabState) => void;
  /** Asks the renderer what to do about a navigation the app did not author. */
  emitNavigationRequest: (request: WebNavigationRequest) => void;
  /**
   * Closes the tab after the page asked to close itself. Optional so the policy
   * can land before the main wiring; unknown tabs are the caller's concern.
   */
  requestClose?: (tabId: string) => void;
  now?: () => number;
}

export interface WebTabManager {
  /** Reconciles views with the published tab table. */
  sync(envelope: SessionTabsEnvelope): void;
  /** Records the rectangle the renderer reserved for the active view. */
  setBounds(tabId: string, bounds: unknown): void;
  /** Runs a chrome command; unknown commands are ignored. */
  command(tabId: string, command: unknown): void;
  /** Loads a URL in an existing web tab (the "open in this tab" answer). */
  navigate(tabId: string, url: unknown): boolean;
  /** The current state for one tab, or null when it is not an open web tab. */
  state(tabId: string): WebTabState | null;
  /** Every open web tab's state. */
  states(): WebTabState[];
  /** Number of live `WebContentsView`s (Diagnostics/backpressure). */
  liveViewCount(): number;
  /** The live-view cap (Diagnostics/backpressure). */
  webViewLimit(): number;
  /** Tears every view down (window close / quit). */
  dispose(): void;
}

interface ManagedView {
  tabId: string;
  view: WebViewLike;
  state: WebTabState;
  bounds: { x: number; y: number; width: number; height: number };
  visible: boolean;
  detach: Array<() => void>;
  /** The webContents is gone; never project through it again. */
  gone: boolean;
  /** The page already asked to close this tab; request it once. */
  closeRequested: boolean;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * A web tab is a URL record; a `WebContentsView` is a full Chromium renderer.
 *
 * Six live views: a grid can show four web panes at once (2026-11-03 plan), and a
 * **visible** view is never evicted, so the bound must exceed the largest pane
 * count or a fifth web tab could not be reached while four are on screen. An
 * evicted view's last state is kept and the page reloads from its URL when it is
 * shown again.
 */
export const MAX_LIVE_WEB_VIEWS = 6;

export function createWebTabManager(deps: WebTabManagerDeps): WebTabManager {
  const now = deps.now ?? ((): number => Date.now());
  const views = new Map<string, ManagedView>();
  /** Last projected state of web tabs whose view was evicted. */
  const parkedStates = new Map<string, WebTabState>();
  /** The tab whose view should be shown; others stay hidden. */
  let activeTabId: string | null = null;

  const project = (managed: ManagedView): WebTabState => {
    if (managed.gone) return managed.state;
    const contents = managed.view.webContents;
    let raw = "";
    try {
      if (contents.isDestroyed?.() !== true) raw = contents.getURL();
    } catch {
      // A view that died between events keeps its last projected state.
    }
    const url = sanitizeWebUrl(raw) ?? managed.state.url;
    return { ...managed.state, url };
  };

  const applyVisibility = (managed: ManagedView): void => {
    // Each pane reports its own rectangle, and the grid may show several at
    // once, so the renderer's `visible` flag is authoritative. It used to be
    // ANDed with `tabId === activeTabId`, which allowed exactly one web view on
    // screen; a view the renderer has not reported yet stays hidden, so an
    // unmounted tab can never become un-evictable.
    managed.view.setVisible(managed.visible);
  };

  const applyBounds = (managed: ManagedView): void => {
    managed.view.setBounds(managed.bounds);
  };

  const update = (managed: ManagedView, patch: Partial<WebTabState>): void => {
    managed.state = { ...managed.state, ...patch };
    deps.emitState(managed.state);
  };

  const onNavigation = (managed: ManagedView, request: WebViewNavigationRequest): void => {
    const url = sanitizeWebUrl(request.url);
    if (!url) {
      request.prevent();
      return;
    }
    // Loopback pages belong to this machine, so they load without a prompt — a
    // Plannotator review is the common case. Anything else leaves the review and
    // the renderer decides (a new tab, the system browser, or nothing).
    if (isLoopbackUrl(url)) return;
    request.prevent();
    deps.emitNavigationRequest({
      tabId: managed.tabId,
      url,
      disposition: request.disposition,
      at: now(),
    });
  };

  const attach = (managed: ManagedView): void => {
    const view = managed.view;
    const contents = view.webContents;
    const on = (event: WebViewEvent, listener: (payload?: unknown) => void): void => {
      managed.detach.push(view.on(event, listener));
    };

    on("loading", () => update(managed, { status: "loading", error: null }));
    on("loaded", () =>
      update(managed, {
        status: "ready",
        error: null,
        canGoBack: contents.canGoBack(),
        canGoForward: contents.canGoForward(),
        loadedAt: now(),
      }),
    );
    on("navigated", () =>
      update(managed, {
        url: sanitizeWebUrl(contents.getURL()) ?? managed.state.url,
        canGoBack: contents.canGoBack(),
        canGoForward: contents.canGoForward(),
      }),
    );
    on("title", (payload) => {
      if (isString(payload) && payload.length > 0) update(managed, { title: payload });
    });
    on("favicon", (payload) => {
      const urls = Array.isArray(payload) ? payload.filter(isString) : [];
      const favicon = urls.find((entry) => sanitizeWebUrl(entry) !== null) ?? null;
      if (favicon) update(managed, { favicon });
    });
    on("failed", (payload) => {
      const record = (payload ?? {}) as { errorDescription?: unknown };
      update(managed, {
        status: "failed",
        error: isString(record.errorDescription) ? record.errorDescription : "load failed",
        canGoBack: contents.canGoBack(),
        canGoForward: contents.canGoForward(),
      });
    });
    on("navigation-request", (payload) => {
      const request = payload as WebViewNavigationRequest | undefined;
      if (request && isString(request.url) && typeof request.prevent === "function") {
        onNavigation(managed, request);
      }
    });
    on("close-requested", () => {
      if (managed.closeRequested) return;
      managed.closeRequested = true;
      try {
        deps.requestClose?.(managed.tabId);
      } catch {
        // A close callback must never break the manager; the user can still
        // close the tab from the strip.
      }
    });
    on("destroyed", () => {
      managed.gone = true;
    });
  };

  const create = (tab: TabRecord & { url: string }): ManagedView => {
    const parked = parkedStates.get(tab.id);
    const url = sanitizeWebUrl(parked?.url ?? tab.url) ?? tab.url;
    const view = deps.createView.create({ tabId: tab.id, url });
    const managed: ManagedView = {
      tabId: tab.id,
      view,
      state: parked ?? emptyWebTabState(tab.id, url, tab.sessionTabId ?? null),
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      // Hidden until the renderer reports a rectangle. A fresh view that claimed
      // to be visible would paint at 0×0 (a flash) and, worse, could never be
      // evicted because eviction only takes hidden views.
      visible: false,
      detach: [],
      gone: false,
      closeRequested: false,
    };
    parkedStates.delete(tab.id);
    attach(managed);
    void view.webContents.loadURL(url);
    views.set(tab.id, managed);
    deps.emitState(project(managed));
    return managed;
  };

  const teardown = (managed: ManagedView): void => {
    // Keep the last URL/title/favicon so the tab strip does not go blank while
    // the view is parked. A closed tab deletes its parked entry separately.
    parkedStates.set(managed.tabId, project(managed));
    for (const off of managed.detach.splice(0)) off();
    try {
      managed.view.close?.();
    } catch {
      // Closing an already-gone view is not an error for the user.
    }
    views.delete(managed.tabId);
  };

  return {
    sync(envelope) {
      const webTabs = new Map<string, TabRecord & { url: string }>();
      for (const tab of envelope.tabs) {
        if (tab.kind === "web" && isString(tab.url) && tab.url.length > 0) {
          webTabs.set(tab.id, tab as TabRecord & { url: string });
        }
      }

      // Close views whose tab is gone or is no longer a web tab. A closed tab
      // must not leave a parked state behind forever.
      const goneIds = new Set<string>();
      for (const managed of [...views.values()]) {
        if (!webTabs.has(managed.tabId)) {
          teardown(managed);
          parkedStates.delete(managed.tabId);
        }
      }
      // A page that closed itself left a dead view. Tear it down now, and keep
      // it out of this pass's creation list while the close request lands: a
      // tab-table update may still carry the tab for a frame.
      for (const managed of [...views.values()]) {
        if (!managed.gone) continue;
        goneIds.add(managed.tabId);
        teardown(managed);
      }
      for (const tabId of [...parkedStates.keys()]) {
        if (!webTabs.has(tabId)) parkedStates.delete(tabId);
      }

      // The tab table is the authority for a web tab's owner: a reused review
      // URL can be re-pointed to a new session. Live views emit the change;
      // parked states are updated in place for the next creation.
      for (const tab of webTabs.values()) {
        const link = tab.sessionTabId ?? null;
        const managed = views.get(tab.id);
        if (managed && managed.state.sessionTabId !== link) {
          update(managed, { sessionTabId: link });
        }
        const parked = parkedStates.get(tab.id);
        if (parked && parked.sessionTabId !== link) {
          parkedStates.set(tab.id, { ...parked, sessionTabId: link });
        }
      }

      activeTabId =
        isString(envelope.activeTabId) && webTabs.has(envelope.activeTabId)
          ? envelope.activeTabId
          : null;

      /**
       * Parks the least-recently-active **hidden** view.
       *
       * Visibility is per pane now, so a visible view is on screen somewhere and
       * must never be torn down under the user — even to make room for another
       * tab. When every live view is visible, eviction simply stops and the extra
       * tab stays parked (its URL is kept and it loads when first shown).
       */
      const evictHidden = (): boolean => {
        const victims = [...views.values()]
          .filter((managed) => !managed.visible && managed.tabId !== activeTabId)
          .sort(
            (left, right) =>
              (webTabs.get(left.tabId)?.lastActiveAt ?? 0) -
              (webTabs.get(right.tabId)?.lastActiveAt ?? 0),
          );
        const victim = victims[0];
        if (!victim) return false;
        teardown(victim);
        return true;
      };

      // The active tab always gets a view. If the limit is reached, park the
      // least-recently-active hidden view first (never a visible or active tab).
      const activeTab = activeTabId ? webTabs.get(activeTabId) : undefined;
      if (activeTab && !views.has(activeTab.id) && !goneIds.has(activeTab.id)) {
        while (views.size >= MAX_LIVE_WEB_VIEWS && evictHidden()) {
          // keep evicting until there is a slot or nothing else can go
        }
        if (views.size < MAX_LIVE_WEB_VIEWS) create(activeTab);
      }

      // Restore/open other web tabs only while there is a slot, newest first.
      const candidates = [...webTabs.values()]
        .filter((tab) => !views.has(tab.id) && !goneIds.has(tab.id))
        .sort((left, right) => right.lastActiveAt - left.lastActiveAt);
      for (const tab of candidates) {
        if (views.size >= MAX_LIVE_WEB_VIEWS) break;
        create(tab);
      }

      // A limit change or a tab-list edit can leave an extra hidden view.
      while (views.size > MAX_LIVE_WEB_VIEWS) {
        if (!evictHidden()) break;
      }

      for (const managed of views.values()) {
        applyBounds(managed);
        applyVisibility(managed);
      }
    },

    setBounds(tabId, bounds) {
      const managed = views.get(tabId);
      if (!managed || managed.gone) return;
      const parsed = sanitizeWebTabBounds(bounds);
      if (!parsed) return;
      managed.bounds = { x: parsed.x, y: parsed.y, width: parsed.width, height: parsed.height };
      managed.visible = parsed.visible;
      applyBounds(managed);
      applyVisibility(managed);
    },

    command(tabId, command) {
      const managed = views.get(tabId);
      if (!managed || managed.gone) return;
      const parsed: WebCommand | null = parseWebCommand(command);
      if (!parsed) return;
      const contents = managed.view.webContents;
      switch (parsed.command) {
        case "back":
          if (contents.canGoBack()) contents.goBack();
          break;
        case "forward":
          if (contents.canGoForward()) contents.goForward();
          break;
        case "reload":
          contents.reload();
          break;
        case "stop":
          contents.stop();
          break;
        case "zoom":
          contents.setZoomFactor(parsed.factor);
          update(managed, { zoom: parsed.factor });
          break;
        case "navigate":
          void contents.loadURL(parsed.url);
          update(managed, { url: parsed.url, status: "loading", error: null });
          break;
        default:
          break;
      }
    },

    navigate(tabId, url) {
      const managed = views.get(tabId);
      const target = sanitizeWebUrl(url);
      if (!managed || managed.gone || !target) return false;
      void managed.view.webContents.loadURL(target);
      update(managed, { url: target, status: "loading", error: null });
      return true;
    },

    state: (tabId) => {
      const managed = views.get(tabId);
      return managed ? project(managed) : (parkedStates.get(tabId) ?? null);
    },

    states: () => [
      ...[...views.values()].map(project),
      ...[...parkedStates.entries()]
        .filter(([tabId]) => !views.has(tabId))
        .map(([, state]) => state),
    ],

    liveViewCount: () => views.size,
    webViewLimit: () => MAX_LIVE_WEB_VIEWS,

    dispose() {
      for (const managed of [...views.values()]) teardown(managed);
      parkedStates.clear();
      activeTabId = null;
    },
  };
}
