/**
 * Mouse wheel policy for the integrated terminal.
 *
 * xterm.js keeps xterm's `alternateScroll` compatibility rule: while the
 * **alternate screen** is active and the running program has not enabled a mouse
 * protocol that reports the wheel, a wheel event is written to the PTY as
 * `ESC[A` / `ESC[B` (`CoreBrowserTerminal`'s wheel listener). Inside a
 * full-screen TUI those are arrow keys, so scrolling the Pi agent's transcript
 * recalled previous prompts instead of scrolling anything.
 *
 * This module is the pure policy behind the renderer's custom wheel handler
 * (`term.attachCustomWheelEventHandler`). It takes over exactly the state xterm
 * would turn into arrows — alternate buffer, no wheel reporting — and answers
 * with a **page** (PageUp/PageDown, which Pi's alt-screen viewport, pagers and
 * editors all scroll with) or a **swallow**. Every other state stays `native`,
 * so a program that reports the wheel keeps xterm's line-by-line SGR path and a
 * normal shell keeps its scrollback.
 *
 * A page is emitted once per **gesture**: a burst of same-direction wheel events
 * separated by at most {@link WHEEL_GESTURE_GAP_MS}. A trackpad or a spun wheel
 * therefore scrolls one screenful, not dozens.
 *
 * No DOM and no xterm import, so the node test project covers it directly.
 */

export type TerminalWheelBuffer = "normal" | "alternate";

export interface TerminalWheelContext {
  /** The active xterm buffer, i.e. `term.buffer.active.type`. */
  buffer: TerminalWheelBuffer;
  /**
   * True when the program enabled a protocol that reports the wheel
   * (`term.modes.mouseTrackingMode` is `vt200`, `drag` or `any` — `x10` has no
   * wheel report and must count as false).
   */
  mouseWheelReports: boolean;
}

export interface TerminalWheelGesture {
  deltaY: number;
  /** Horizontal component; a horizontal-dominant wheel is not a transcript scroll. */
  deltaX?: number;
  /** Ctrl/Cmd wheel is the browser/OS zoom gesture, never a key. */
  ctrlKey?: boolean;
  metaKey?: boolean;
}

export interface TerminalWheelState {
  /** Direction of the burst in progress: -1 up, 1 down, 0 idle. */
  direction: -1 | 0 | 1;
  /** Timestamp of the last event that belonged to the current burst. */
  at: number;
}

export type TerminalWheelDecision =
  /** Let xterm handle it (scrollback, or the program's own SGR wheel report). */
  | { kind: "native" }
  /** Cancel the event without sending anything (no arrow, no page). */
  | { kind: "swallow" }
  /** Send one page key: -1 is PageUp, 1 is PageDown. */
  | { kind: "page"; page: -1 | 1 };

export interface TerminalWheelStep {
  decision: TerminalWheelDecision;
  /** The state to keep for the next event. */
  state: TerminalWheelState;
}

export const TERMINAL_PAGE_UP = "\x1b[5~";
export const TERMINAL_PAGE_DOWN = "\x1b[6~";

/**
 * Two events in the same direction closer than this are one gesture. Long
 * enough to cover one trackpad flick or a spun wheel, short enough that two
 * deliberate notches each page.
 */
export const WHEEL_GESTURE_GAP_MS = 180;

/** The state before the first event of a terminal's life. */
export const IDLE_TERMINAL_WHEEL: TerminalWheelState = { direction: 0, at: 0 };

/** The key bytes for one page step. */
export function pageSequence(page: -1 | 1): string {
  return page < 0 ? TERMINAL_PAGE_UP : TERMINAL_PAGE_DOWN;
}

/**
 * Decides one wheel event.
 *
 * `now` is injected (the view passes `performance.now()`) so the gesture window
 * is testable without timers.
 */
export function stepTerminalWheel(
  gesture: TerminalWheelGesture,
  context: TerminalWheelContext,
  state: TerminalWheelState,
  now: number,
  gapMs: number = WHEEL_GESTURE_GAP_MS,
): TerminalWheelStep {
  // A normal buffer scrolls xterm's scrollback, and a program that reports the
  // wheel scrolls itself: xterm's own handling is right in both.
  if (context.buffer === "normal" || context.mouseWheelReports) {
    return { decision: { kind: "native" }, state };
  }

  const deltaY = Number.isFinite(gesture.deltaY) ? gesture.deltaY : 0;
  const deltaX = Number.isFinite(gesture.deltaX) ? (gesture.deltaX ?? 0) : 0;

  // Alternate screen without wheel reporting: never let xterm encode an arrow.
  // Zoom chords, a purely horizontal wheel and a zero delta are swallowed.
  if (gesture.ctrlKey || gesture.metaKey || deltaY === 0 || Math.abs(deltaX) >= Math.abs(deltaY)) {
    return { decision: { kind: "swallow" }, state };
  }

  const direction: -1 | 1 = deltaY < 0 ? -1 : 1;
  const continuing = state.direction === direction && now - state.at <= gapMs;
  const decision: TerminalWheelDecision = continuing
    ? { kind: "swallow" }
    : { kind: "page", page: direction };
  return { decision, state: { direction, at: now } };
}
