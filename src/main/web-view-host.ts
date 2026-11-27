import {
  WebContentsView,
  session as electronSession,
  type BrowserWindow,
  type Session,
} from "electron";
import { WEB_TAB_PARTITION, webTabWebPreferences } from "./security";
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
 * app's own preload ran, and it never runs here. The preferences come from
 * `./security.ts` (plan step 23), so the posture is asserted by a unit test.
 */

/** Electron's ERR_ABORTED, which a deliberately prevented navigation produces. */
const ERR_ABORTED = -3;

/**
 * The page-side half of the close bridge.
 *
 * A `WebContentsView` has no window of its own, so a page's `window.close()`
 * does not remove the desktop tab: Electron destroys the webContents and leaves
 * the tab record behind. Replacing `window.close` with a promise that resolves
 * in main turns the page's request into a normal tab close. The script is
 * injected through `executeJavaScript`; it runs in the page's main world and
 * exposes no Node, IPC or `window.pi` surface.
 *
 * If the page already saved the native `close` reference, or the property cannot
 * be replaced, the returned marker tells the adapter to rely on the
 * `destroyed` fallback instead.
 */
const CLOSE_BRIDGE_SCRIPT = `(() => {
  if (window.__piDesktopCloseBridge) return Promise.resolve("already");
  let resolveClose;
  const closed = new Promise((resolve) => {
    resolveClose = resolve;
  });
  const request = () => {
    resolveClose("close");
  };
  let installed = false;
  try {
    window.close = request;
    installed = window.close === request;
    if (!installed) {
      Object.defineProperty(window, "close", {
        configurable: true,
        writable: true,
        value: request,
      });
      installed = window.close === request;
    }
  } catch {
    installed = false;
  }
  if (!installed) return Promise.resolve("unsupported");
  window.__piDesktopCloseBridge = "installed";
  return closed;
})()`;

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
        webPreferences: webTabWebPreferences(),
      });
      options.window()?.contentView.addChildView(view);

      const contents = view.webContents;
      const listeners = new Map<WebViewEvent, Set<(payload?: unknown) => void>>();
      const emit = (event: WebViewEvent, payload?: unknown): void => {
        for (const listener of listeners.get(event) ?? []) listener(payload);
      };
      // Set before our own `contents.close()` so the resulting `destroyed` event
      // is not mistaken for a page-initiated close.
      let internalClose = false;

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
      contents.on("dom-ready", () => {
        void contents
          .executeJavaScript(CLOSE_BRIDGE_SCRIPT)
          .then((result) => {
            if (result === "close") emit("close-requested");
          })
          .catch(() => {
            // A navigation or destroyed page rejects the pending promise; the
            // `destroyed` fallback still closes the tab if the page closed.
          });
      });
      contents.on("destroyed", () => {
        // The native window.close() path: CloseContents() emits no documented
        // event before Destroy(), so the destroyed webContents is the signal.
        if (!internalClose) emit("close-requested");
        emit("destroyed");
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
          loadURL: (target: string) =>
            contents.isDestroyed() ? undefined : contents.loadURL(target),
          getURL: () => (contents.isDestroyed() ? "" : contents.getURL()),
          canGoBack: () => !contents.isDestroyed() && contents.navigationHistory.canGoBack(),
          canGoForward: () => !contents.isDestroyed() && contents.navigationHistory.canGoForward(),
          goBack: () => {
            if (!contents.isDestroyed()) contents.navigationHistory.goBack();
          },
          goForward: () => {
            if (!contents.isDestroyed()) contents.navigationHistory.goForward();
          },
          reload: () => {
            if (!contents.isDestroyed()) contents.reload();
          },
          stop: () => {
            if (!contents.isDestroyed()) contents.stop();
          },
          setZoomFactor: (factor: number) => {
            if (!contents.isDestroyed()) contents.setZoomFactor(factor);
          },
          isDestroyed: () => contents.isDestroyed(),
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
          internalClose = true;
          listeners.clear();
          try {
            options.window()?.contentView.removeChildView(view);
          } catch {
            // The window may already be gone during teardown.
          }
          if (!contents.isDestroyed()) contents.close();
        },
      };
      return viewLike;
    },
  };
}
