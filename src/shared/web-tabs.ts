/**
 * The web-tab wire model (plan step 21: "Web tabs — Plannotator and localhost
 * UIs").
 *
 * A **web tab** is a tab in the same strip as a session, but its content is a
 * page the app did not write: a Plannotator review served on a random loopback
 * port, or any localhost UI an extension points at. The renderer never touches
 * the page directly — main owns an isolated `WebContentsView` and the renderer
 * draws only the chrome around it — so this file is the single description of
 * what crosses that boundary: the URL policy, the per-tab state snapshot, the
 * chrome commands, the bounds the renderer reports, and the navigation decision
 * main asks the renderer for before it leaves a review.
 *
 * Everything here is pure, so it is unit tested in the node project and shared
 * by main, the preload and the renderer.
 */

/** The only schemes a web tab may load; `file:`, `data:` and friends are refused. */
export const WEB_TAB_SCHEMES = ["http:", "https:"] as const;

/** How a web tab is doing, as the chrome shows it. */
export type WebTabStatus = "loading" | "ready" | "failed";

/** One web tab's live state, pushed from main after every change. */
export interface WebTabState {
  tabId: string;
  /** The page currently displayed (may differ from the URL the tab was opened with). */
  url: string;
  /** Page title, or the URL's host until the page reports one. */
  title: string;
  favicon: string | null;
  status: WebTabStatus;
  canGoBack: boolean;
  canGoForward: boolean;
  zoom: number;
  /** Why the last load failed, when `status` is `failed`. */
  error: string | null;
  /** The session tab whose notification opened this web tab (Plannotator). */
  sessionTabId: string | null;
  /** When the page last reached `ready`. */
  loadedAt: number | null;
}

/** The chrome actions the renderer can ask main to run. */
export type WebCommand =
  | { command: "back" }
  | { command: "forward" }
  | { command: "reload" }
  | { command: "stop" }
  | { command: "zoom"; factor: number }
  | { command: "navigate"; url: string };

/** A rectangle in the window's content area; the native view is placed there. */
export interface WebTabBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  /** False hides the native view (another tab is active, or an overlay is up). */
  visible: boolean;
}

/** How far the renderer may zoom a web tab. */
export const WEB_TAB_MIN_ZOOM = 0.25;
export const WEB_TAB_MAX_ZOOM = 3;

/** Why main is asking before it navigates a web tab. */
export type WebNavigationDisposition = "link" | "new-window" | "redirect";

/**
 * A navigation main refused to perform on its own because it leaves the review
 * (a non-loopback target). The renderer answers by opening the URL in a new web
 * tab, handing it to the system browser, or dropping it.
 */
export interface WebNavigationRequest {
  tabId: string;
  url: string;
  disposition: WebNavigationDisposition;
  at: number;
}

/** Hosts that count as "this machine" and therefore load without a prompt. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  // Any 127.0.0.0/8 address is loopback (`127.0.0.1` is the common case).
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Normalizes a URL string to an `http(s)` URL, or null when it is not one. The
 * renderer and main both run this: a page the user did not ask for can never be
 * reached by handing the app a `javascript:` or `file:` string.
 */
export function parseWebUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length === 0) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!(WEB_TAB_SCHEMES as readonly string[]).includes(url.protocol)) return null;
  return url;
}

/** The normalized `href` of an allowed URL, or null. */
export function sanitizeWebUrl(value: unknown): string | null {
  return parseWebUrl(value)?.toString() ?? null;
}

/** True when the URL is a loopback address the app may open without asking. */
export function isLoopbackUrl(value: unknown): boolean {
  const url = parseWebUrl(value);
  return url ? isLoopbackHost(url.hostname) : false;
}

/**
 * True when `value` has the same origin as `origin`.
 *
 * A browser tab pointed at Pi Desktop's own renderer dev server is the same
 * origin as this page; a project's dev server is a different port. Used to tell
 * the two apart when someone pastes a localhost URL (2026-11-05 port plan).
 */
export function isSameOriginUrl(value: unknown, origin: string): boolean {
  const url = parseWebUrl(value);
  if (!url) return false;
  try {
    return url.origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/** Trailing punctuation a sentence may attach to a URL. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>"']+$/;

/**
 * Extracts every loopback URL from arbitrary text — a notification message, a
 * tool result, a shell line. Plannotator's review URL arrives this way, so this
 * is how the app knows to open it in a tab instead of the system browser.
 */
export function loopbackUrlsIn(text: unknown): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const matches = text.match(/https?:\/\/[^\s<>"'`]+/gi) ?? [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const raw of matches) {
    const trimmed = raw.replace(TRAILING_PUNCTUATION, "");
    const url = parseWebUrl(trimmed);
    if (!url || !isLoopbackHost(url.hostname)) continue;
    const href = url.toString();
    if (seen.has(href)) continue;
    seen.add(href);
    urls.push(href);
  }
  return urls;
}

/** The first loopback URL in the text, or null. */
export function firstLoopbackUrl(text: unknown): string | null {
  return loopbackUrlsIn(text)[0] ?? null;
}

/** Default tab/window title for a URL: its host (with port), never the path. */
export function webTabTitle(value: unknown): string {
  const url = parseWebUrl(value);
  if (!url) return "Web";
  return url.host || url.hostname || "Web";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A web tab's state before the page has reported anything. */
export function emptyWebTabState(
  tabId: string,
  url: string,
  sessionTabId: string | null = null,
): WebTabState {
  return {
    tabId,
    url,
    title: webTabTitle(url),
    favicon: null,
    status: "loading",
    canGoBack: false,
    canGoForward: false,
    zoom: 1,
    error: null,
    sessionTabId,
    loadedAt: null,
  };
}

const WEB_STATUSES: readonly WebTabStatus[] = ["loading", "ready", "failed"];

/** Coerces one untrusted state snapshot into a `WebTabState`, or null. */
export function sanitizeWebTabState(value: unknown): WebTabState | null {
  const record = asRecord(value);
  const tabId = asString(record.tabId);
  const url = sanitizeWebUrl(record.url);
  if (!tabId || !url) return null;
  const status = record.status;
  const zoom = typeof record.zoom === "number" && Number.isFinite(record.zoom) ? record.zoom : 1;
  return {
    tabId,
    url,
    title: asString(record.title) ?? webTabTitle(url),
    favicon: asString(record.favicon),
    status: WEB_STATUSES.includes(status as WebTabStatus) ? (status as WebTabStatus) : "loading",
    canGoBack: record.canGoBack === true,
    canGoForward: record.canGoForward === true,
    zoom: Math.min(WEB_TAB_MAX_ZOOM, Math.max(WEB_TAB_MIN_ZOOM, zoom)),
    error: asString(record.error),
    sessionTabId: asString(record.sessionTabId),
    loadedAt:
      typeof record.loadedAt === "number" && Number.isFinite(record.loadedAt)
        ? record.loadedAt
        : null,
  };
}

/** Parses a chrome command from the renderer; unknown shapes are dropped. */
export function parseWebCommand(value: unknown): WebCommand | null {
  const record = asRecord(value);
  switch (record.command) {
    case "back":
      return { command: "back" };
    case "forward":
      return { command: "forward" };
    case "reload":
      return { command: "reload" };
    case "stop":
      return { command: "stop" };
    case "zoom": {
      const factor = record.factor;
      if (typeof factor !== "number" || !Number.isFinite(factor)) return null;
      return {
        command: "zoom",
        factor: Math.min(WEB_TAB_MAX_ZOOM, Math.max(WEB_TAB_MIN_ZOOM, factor)),
      };
    }
    case "navigate": {
      const url = sanitizeWebUrl(record.url);
      return url ? { command: "navigate", url } : null;
    }
    default:
      return null;
  }
}

/** Sanitizes the rectangle the renderer reports for the native view. */
export function sanitizeWebTabBounds(value: unknown): WebTabBounds | null {
  const record = asRecord(value);
  const numbers = ["x", "y", "width", "height"] as const;
  for (const key of numbers) {
    const entry = record[key];
    if (typeof entry !== "number" || !Number.isFinite(entry)) return null;
  }
  return {
    x: Math.round(record.x as number),
    y: Math.round(record.y as number),
    width: Math.max(0, Math.round(record.width as number)),
    height: Math.max(0, Math.round(record.height as number)),
    visible: record.visible !== false,
  };
}

const DISPOSITIONS: readonly WebNavigationDisposition[] = ["link", "new-window", "redirect"];

/** Sanitizes a navigation request pushed from main. */
export function sanitizeWebNavigationRequest(value: unknown): WebNavigationRequest | null {
  const record = asRecord(value);
  const tabId = asString(record.tabId);
  const url = sanitizeWebUrl(record.url);
  if (!tabId || !url) return null;
  const disposition = record.disposition;
  return {
    tabId,
    url,
    disposition: DISPOSITIONS.includes(disposition as WebNavigationDisposition)
      ? (disposition as WebNavigationDisposition)
      : "link",
    at: typeof record.at === "number" && Number.isFinite(record.at) ? record.at : 0,
  };
}

const WEB_ACTIONS = ["current-tab", "new-tab", "external", "dismiss"] as const;

/** What the renderer decided about a navigation main asked about. */
export type WebNavigationAction = (typeof WEB_ACTIONS)[number];

export interface WebNavigationDecision {
  tabId: string;
  url: string;
  action: WebNavigationAction;
  /** The session the new tab should link back to, when `action` is `new-tab`. */
  sessionTabId?: string | null;
}

/** Sanitizes the renderer's navigation answer, or null when unusable. */
export function sanitizeWebNavigationDecision(value: unknown): WebNavigationDecision | null {
  const record = asRecord(value);
  const tabId = asString(record.tabId);
  const url = sanitizeWebUrl(record.url);
  const action = record.action;
  if (!tabId || !url || !(WEB_ACTIONS as readonly string[]).includes(action as string)) return null;
  return {
    tabId,
    url,
    action: action as WebNavigationAction,
    sessionTabId: asString(record.sessionTabId),
  };
}

/** A review outcome Plannotator reports on stdout. */
export type ReviewDecision = "approved" | "annotated" | "dismissed";

const REVIEW_DECISIONS: readonly ReviewDecision[] = ["approved", "annotated", "dismissed"];

/**
 * Recognizes a Plannotator decision in a tool result so the transcript can show
 * the review outcome next to the tool card rather than making the user read the
 * raw JSON. Both the `--json` record and the default plaintext are understood.
 */
export function parseReviewDecision(text: unknown): ReviewDecision | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const match = text.match(/"decision"\s*:\s*"(approved|annotated|dismissed)"/i);
  if (match?.[1]) return match[1].toLowerCase() as ReviewDecision;
  if (/The user approved\./i.test(text)) return "approved";
  // Guard against a bare word appearing in prose: only a whole-line marker counts.
  const line = text.trim().toLowerCase();
  return (REVIEW_DECISIONS as readonly string[]).includes(line) ? (line as ReviewDecision) : null;
}
