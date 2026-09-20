import {
  WebContentsView,
  session as electronSession,
  type BrowserWindow,
  type Session,
} from "electron";
import type {
  WebViewEvent,
  WebViewFactory,
  WebViewLike,
  WebViewNavigationRequest,
} from "./web-tabs";

/**
 * The Electron half of the web-tab service (plan step 21).
 *
 * `src/main/web-tabs.ts` is Electron-free and owns the policy; this adapter only
 * turns a real `WebContentsView` into the small `WebViewLike` port it expects and
 * normalizes Electron's `(event, …)` signatures into the named events the
 * service handles. Keeping the boundary here means the policy is unit tested
 * without a window, and the Electron surface is a single, auditable file.
 *
 * Security: every web tab lives in one dedicated partition with **no preload**,
 * `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false` and every
 * permission request denied. That is what makes "a web tab cannot reach the Pi
 * bridge" structural rather than a convention — `window.pi` only exists where the
 * app's own preload ran, and it never runs here.
 */

/** The partition every web tab shares; isolated from the app's cookies and storage. */
export const WEB_TAB_PARTITION = "persist:pi-web-tabs";

/** Electron's ERR_ABORTED, which a deliberately prevented navigation produces. */
const ERR_ABORTED = -3;

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export interface ElectronWebViewHostOptions {
  /** The window whose `contentView` hosts the tab views. */
  window: () => BrowserWindow | null;
}

export function createElectronWebViewHost(options: ElectronWebViewHostOptions): WebViewFactory {
  let configured: Session | null = null;

  const webSession = (): Session => {
    const partition = electronSession.fromPartition(WEB_TAB_PARTITION);
    if (configured !== partition) {
      configured = partition;
      // Deny every permission by default: a review page has no reason to reach
      // the camera, the microphone, geolocation or the clipboard.
      partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      partition.setPermissionCheckHandler(() => false);
    }
    return partition;
  };

  return {
    create() {
      // Touch the partition first so its handlers exist before the first load.
      webSession();

      const view = new WebContentsView({
        webPreferences: {
          partition: WEB_TAB_PARTITION,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webviewTag: false,
          spellcheck: false,
          // No `preload`: this is what keeps `window.pi` out of the page.
        },
      });
      options.window()?.contentView.addChildView(view);

      const contents = view.webContents;
      const listeners = new Map<WebViewEvent, Set<(payload?: unknown) => void>>();
      const emit = (event: WebViewEvent, payload?: unknown): void => {
        for (const listener of listeners.get(event) ?? []) listener(payload);
      };

      contents.on("did-start-loading", () => emit("loading"));
      contents.on("did-stop-loading", () => emit("loaded"));
      contents.on("did-navigate", () => emit("navigated"));
      contents.on("did-navigate-in-page", () => emit("navigated"));
      contents.on("page-title-updated", (_event, title) => emit("title", title));
      contents.on("page-favicon-updated", (_event, favicons) => emit("favicon", favicons));
      contents.on("did-fail-load", (_event, errorCode, errorDescription) => {
        if (errorCode === ERR_ABORTED) return;
        emit("failed", { errorDescription: isString(errorDescription) ? errorDescription : "" });
      });

      const forward = (
        target: string,
        disposition: WebViewNavigationRequest["disposition"],
        prevent: () => void,
      ): void => {
        emit("navigation-request", { url: target, disposition, prevent });
      };
      contents.on("will-navigate", (event, target) =>
        forward(target, "link", () => event.preventDefault()),
      );
      contents.on("will-redirect", (event, target) =>
        forward(target, "redirect", () => event.preventDefault()),
      );
      contents.setWindowOpenHandler((details) => {
        // A `target=_blank` link never gets its own window; the renderer decides
        // whether it becomes a new web tab or an external browser visit.
        forward(details.url, "new-window", () => undefined);
        return { action: "deny" };
      });

      const viewLike: WebViewLike = {
        webContents: {
          loadURL: (target: string) => contents.loadURL(target),
          getURL: () => contents.getURL(),
          canGoBack: () => contents.navigationHistory.canGoBack(),
          canGoForward: () => contents.navigationHistory.canGoForward(),
          goBack: () => contents.navigationHistory.goBack(),
          goForward: () => contents.navigationHistory.goForward(),
          reload: () => contents.reload(),
          stop: () => contents.stop(),
          setZoomFactor: (factor: number) => contents.setZoomFactor(factor),
        },
        on(event, listener) {
          const set = listeners.get(event) ?? new Set();
          set.add(listener);
          listeners.set(event, set);
          return () => set.delete(listener);
        },
        setBounds: (bounds) => view.setBounds(bounds),
        setVisible: (visible) => view.setVisible(visible),
        close: () => {
          listeners.clear();
          try {
            options.window()?.contentView.removeChildView(view);
          } catch {
            // The window may already be gone during teardown.
          }
          contents.close();
        },
      };
      return viewLike;
    },
  };
}
