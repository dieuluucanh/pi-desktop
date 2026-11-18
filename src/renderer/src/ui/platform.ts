/**
 * The renderer's platform, in the shape the input policies use.
 *
 * `navigator.platform` is deprecated, but it is the only **synchronous** source
 * the renderer has: a keydown handler must decide whether a chord is Cmd+V or
 * Ctrl+V before the event returns, and `getAppInfo()` is async. The app already
 * derived this value in the terminal runtime and again in the terminal settings;
 * one helper keeps those from drifting as the TUI surface starts using it.
 */

export type AppPlatform = "darwin" | "win32" | "linux";

/** Maps a `navigator.platform`-style string; anything unrecognised is Linux. */
export function platformFromNavigator(value: string | null | undefined): AppPlatform {
  if (value && /Mac/i.test(value)) return "darwin";
  if (value && /Win/i.test(value)) return "win32";
  return "linux";
}

/** The current renderer's platform. */
export function appPlatform(): AppPlatform {
  return platformFromNavigator(typeof navigator === "undefined" ? null : navigator.platform);
}
