/**
 * Paste intake (2026-11-14 terminal paste plan, step 4).
 *
 * A clipboard gesture can reach the terminal through more than one mechanism:
 * the app's own chord/button path (clipboard API → `term.paste`) and the DOM
 * `paste` event the browser fires for the same gesture (Edit ▸ Paste, the
 * context menu, middle-click, or a macOS menu accelerator racing the renderer's
 * keydown). Both are legitimate; the *pair* is not — the clipboard text must be
 * written to the PTY once.
 *
 * This module is the single decision point. It records the text of the last
 * **accepted** write and drops an identical text that arrives from a *different*
 * source within a short window. Same-source repeats are always accepted, so
 * holding Ctrl+V (key repeat) and two quick intentional pastes still work, and a
 * rejected duplicate does not refresh the window.
 */

/** Where a paste attempt came from: the app's own path, or a DOM `paste` event. */
export type PasteSource = "app" | "native";

/**
 * How long after an accepted write an identical text from the other source is
 * treated as the same gesture. Short enough that two deliberate pastes are never
 * collapsed; long enough to cover a menu accelerator and the renderer keydown
 * arriving in either order.
 */
export const PASTE_DUPLICATE_WINDOW_MS = 200;

export interface PasteIntake {
  /** True when the caller should write `text`; false when it is a duplicate delivery. */
  accept(text: string, source: PasteSource): boolean;
}

export interface PasteIntakeOptions {
  /** Defaults to `PASTE_DUPLICATE_WINDOW_MS`. */
  windowMs?: number;
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
}

export function createPasteIntake(options: PasteIntakeOptions = {}): PasteIntake {
  const windowMs = options.windowMs ?? PASTE_DUPLICATE_WINDOW_MS;
  const now = options.now ?? Date.now;
  let last: { text: string; source: PasteSource; at: number } | null = null;

  return {
    accept(text, source) {
      // An empty clipboard is not a delivery: it must not reset the record.
      if (text.length === 0) return false;
      const at = now();
      const duplicate =
        last !== null && last.source !== source && last.text === text && at - last.at < windowMs;
      // Only an accepted write becomes the reference, so a rejected duplicate
      // cannot make the next delivery look like a same-source repeat.
      if (!duplicate) last = { text, source, at };
      return !duplicate;
    },
  };
}
