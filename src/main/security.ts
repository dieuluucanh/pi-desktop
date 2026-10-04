/**
 * Renderer and web-tab security policy (plan step 23).
 *
 * Everything the app promises about its own window — a strict Content Security
 * Policy, `contextIsolation`, `sandbox`, no Node integration, no `<webview>` —
 * is *declared here* and consumed by the two Electron call sites
 * (`src/main/index.ts` for the app window, `src/main/web-view-host.ts` for web
 * tabs). Nothing is re-declared in prose: `tests/main/security.test.ts` reads
 * these values, so weakening one is a failing test, not a silent regression.
 *
 * Electron-free on purpose (AGENTS.md rule 1): it can be unit tested and it can
 * be imported by `electron.vite.config.ts` to inject the CSP into the renderer's
 * HTML at build time.
 */

/** Where the build plugin (and `index.html`) expects the policy to be spliced in. */
export const CSP_PLACEHOLDER = "__PI_RENDERER_CSP__";

/**
 * The production renderer policy.
 *
 * `default-src 'none'` makes every fetch family opt-in. Scripts are only the
 * bundled bundle (`'self'`); styles allow inline because Tailwind/Radix set
 * `style` attributes, which is not a script-execution risk. `object-src`,
 * `base-uri`, `form-action` and `frame-ancestors` are closed because the app
 * never uses plugins, a `<base>`, forms or framing.
 */
export const RENDERER_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * The development policy. Vite serves the page over `http://localhost`, and
 * `@vitejs/plugin-react` injects an inline refresh preamble, so dev needs
 * `'unsafe-inline'` (and Vite's HMR client needs a websocket). The packaged app
 * never sees this: the build plugin injects `RENDERER_CSP`.
 */
export const DEV_RENDERER_CSP = RENDERER_CSP.replace(
  "script-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
).replace("connect-src 'self'", "connect-src 'self' ws: wss:");

/** Picks the policy for the Vite command the plugin is running under. */
export function rendererCspFor(dev: boolean): string {
  return dev ? DEV_RENDERER_CSP : RENDERER_CSP;
}

/**
 * The `webPreferences` every app-owned window starts from. `sandbox: true` plus
 * `contextIsolation: true` plus `nodeIntegration: false` is what makes the
 * preload the only bridge; `webviewTag: false` keeps a page from embedding a
 * second, less-guarded renderer.
 */
export interface SecureWebPreferences {
  contextIsolation: true;
  nodeIntegration: false;
  sandbox: true;
  webviewTag: false;
  spellcheck: false;
  preload?: string;
  partition?: string;
}

export const SECURE_WEB_PREFERENCES: SecureWebPreferences = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webviewTag: false,
  spellcheck: false,
};

/** The app window's preferences: the secure base plus the preload bridge. */
export function rendererWebPreferences(preloadPath: string): SecureWebPreferences {
  return { ...SECURE_WEB_PREFERENCES, preload: preloadPath };
}

/**
 * The options `src/main/index.ts` hands to `new BrowserWindow`. Kept here (and
 * not inline) so the security test can assert them without an Electron runtime.
 */
export interface RendererWindowOptions {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  show: boolean;
  backgroundColor: string;
  title: string;
  autoHideMenuBar: boolean;
  webPreferences: SecureWebPreferences;
  /** Brand icon path; absent when the caller has none, which keeps this a pure string. */
  icon?: string;
}

/**
 * `branding.icon` is a plain path (plan step 28), not an `Electron.NativeImage`:
 * this module stays Electron-free so the security test can assert the window's
 * posture without a runtime. The key is omitted rather than set to `undefined`
 * when absent, so `toMatchObject` pins on the other options keep exact meaning.
 */
export function rendererWindowOptions(
  preloadPath: string,
  branding?: { icon?: string },
): RendererWindowOptions {
  return {
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: "#0f1115",
    title: "Pi Desktop",
    autoHideMenuBar: true,
    webPreferences: rendererWebPreferences(preloadPath),
    ...(branding?.icon ? { icon: branding.icon } : {}),
  };
}

/** The partition every web tab shares; isolated from the app's cookies and storage. */
export const WEB_TAB_PARTITION = "persist:pi-web-tabs";

/**
 * The web-tab preferences: the secure base, one shared partition, and **no
 * `preload`** — that absence is what keeps `window.pi` out of an arbitrary
 * localhost page (plan step 21, asserted in step 23).
 */
export function webTabWebPreferences(): SecureWebPreferences {
  return { ...SECURE_WEB_PREFERENCES, partition: WEB_TAB_PARTITION };
}

/** Schemes the OS may be asked to open; everything else is refused. */
export const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * Normalises a caller-supplied URL and returns it only when its scheme is safe
 * to hand to the OS. Null for anything malformed or unsupported, so a caller
 * never needs a `new URL` it would have to guard.
 */
export function sanitizeExternalUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const url = new URL(raw);
    return EXTERNAL_PROTOCOLS.has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

/** True when `raw` is a string URL whose scheme is safe to hand to the OS. */
export function isAllowedExternalUrl(raw: unknown): boolean {
  return sanitizeExternalUrl(raw) !== null;
}
