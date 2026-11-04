/**
 * OS light/dark resolution for follow-system appearance (2026-10-30 theme pass).
 *
 * Electron's renderer implements `prefers-color-scheme` from the OS setting (it
 * follows `nativeTheme` unless the app forces a source), so the renderer can
 * follow Windows/macOS without an IPC channel. The guard keeps the store and
 * tests usable when `matchMedia` is missing; dark is the historical default.
 */

export type SystemThemeName = "dark" | "light";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** The OS appearance as a built-in Pi theme name. */
export function systemThemeName(): SystemThemeName {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/**
 * Calls `listener` when the OS appearance changes and returns the unsubscribe
 * function. A missing `matchMedia` (jsdom without a stub, an old webview) is a
 * no-op, not an error.
 */
export function watchSystemTheme(listener: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
