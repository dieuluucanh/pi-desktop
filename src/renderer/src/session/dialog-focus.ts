/**
 * When may a background tab's extension dialog take the window? (2026-11-06
 * tab-switch plan, step 8.)
 *
 * An extension in tab B can raise a dialog while the user works in tab A — the
 * workflow questionnaire, a review gate, a Plannotator prompt. The app used to
 * call `activateTab(B)` unconditionally, which is indistinguishable from the app
 * "jumping to another project by itself" when A and B are different sessions.
 *
 * The decision is pure so it is testable without a DOM; the two DOM questions
 * (`composerHasFocus`) live here too so the store does not grow markup
 * knowledge.
 */

export interface DialogFocusInput {
  /** `prefs.dialogs.autoFocus`. */
  policy: "blocking" | "never";
  /** The dialog waits for the user (no extension timeout). */
  blocking: boolean;
  /** The app window has OS focus; a background window must never self-select. */
  windowFocused: boolean;
  /** The user is typing in a composer right now. */
  composerFocused: boolean;
  /** The active tab is streaming; stealing focus hides its Stop button. */
  streaming: boolean;
}

export function shouldFocusDialog(input: DialogFocusInput): boolean {
  if (input.policy === "never") return false;
  if (!input.blocking) return false;
  if (!input.windowFocused) return false;
  if (input.composerFocused) return false;
  return !input.streaming;
}

/**
 * True when focus is in a session composer. The composer is the only surface
 * where an unexpected tab switch loses typed text, so it is the one that blocks
 * the switch.
 */
export function composerHasFocus(): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement as HTMLElement | null;
  if (!active) return false;
  return (
    active.getAttribute("aria-label") === "Prompt" || active.closest("[data-composer]") !== null
  );
}
