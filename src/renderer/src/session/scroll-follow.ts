/**
 * The transcript follow arithmetic (2026-11-25 transcript follow plan).
 *
 * Step 1 extracted the historical 80 px distance test unchanged; step 2 replaced
 * it with the model the plan chose: following is a **state**, not a distance
 * guess. The viewport is pinned to the tail or it is not, and a scroll event may
 * detach only when it proves the reader moved above the baseline the last pin
 * recorded. Content that grows under a pinned viewport is answered by the next
 * pin, never by a detach — a coalesced delta can add far more than any threshold
 * (`src/main/session-service.ts` batches `message_update`s).
 *
 * Explicit gestures are the intent evidence: wheel up, an upward touch drag and
 * PageUp/Home/ArrowUp. Their predicates live here so the hook can stay a thin
 * DOM adapter and the decision table stays node-testable.
 */

/** How far above the pinned baseline still counts as "the same position". */
export const PIN_EPSILON_PX = 1;

/**
 * How long a smooth jump may keep scroll events from being read as intent. It is
 * cleared earlier by the landing scroll; the deadline only bounds a jump that
 * never lands (an interrupted animation, a detached scroller).
 */
export const SMOOTH_GUARD_MS = 500;

/** Finger travel (px) before a touch drag counts as an upward scroll. */
export const TOUCH_SLOP_PX = 4;

/** The scroll metrics the follow test reads from a scroller. */
export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

/** Where the follow state sits: pinned to the tail, and the baseline it pins to. */
export interface FollowState {
  pinned: boolean;
  /** The `scrollTop` the last pin recorded; a detach must beat it by an epsilon. */
  pinnedTop: number;
}

/**
 * How far the viewport's bottom edge sits above the content's bottom edge.
 *
 * An overscroll (rubber-banding) yields a negative number; the caller's
 * comparison treats it as "at the bottom", which is the pre-hook behaviour.
 */
export function distanceFromBottom(metrics: ScrollMetrics): number {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
}

/**
 * The `scrollTop` a browser lands on when it is scrolled to `scrollHeight`.
 *
 * Recording the baseline from here (rather than from a raw `scrollTop`) is what
 * makes the two clamp cases self-healing: a content shrink parks the viewport on
 * the new tail, and an overscroll bounce settles back onto it.
 */
export function bottomScrollTop(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight);
}

/** True within `PIN_EPSILON_PX` of the tail (an overscroll counts as the tail). */
export function isAtBottom(metrics: ScrollMetrics, epsilon = PIN_EPSILON_PX): boolean {
  return distanceFromBottom(metrics) <= epsilon;
}

/**
 * What a `scroll` event means for the follow state.
 *
 * - `pin` re-records the baseline: the reader reached the tail (unpinned), is
 *   still sitting on it (pinned), or the content shrank and the browser clamped
 *   `scrollTop` to the new tail.
 * - `stay` keeps the viewport pinned and the baseline unchanged: the content
 *   grew (or moved down), which is not intent.
 * - `detach` is the only outcome that stops following: `scrollTop` is provably
 *   above the baseline and the viewport is not at the tail (a scrollbar drag, a
 *   programmatic jump by something that did not call `detachForJump`).
 * - `ignore` leaves an unpinned viewport unpinned (the pill is the way back).
 */
export type ScrollFollowDecision =
  | { kind: "ignore" }
  | { kind: "stay"; pinnedTop: number }
  | { kind: "pin"; pinnedTop: number }
  | { kind: "detach" };

export function decideScrollFollow({
  pinned,
  pinnedTop,
  ...metrics
}: FollowState & ScrollMetrics): ScrollFollowDecision {
  if (!pinned) {
    // Coming back to the tail re-attaches and clears the pill; anything else
    // leaves the reader where they are.
    return isAtBottom(metrics)
      ? { kind: "pin", pinnedTop: bottomScrollTop(metrics) }
      : { kind: "ignore" };
  }
  // Sitting on the tail is always a valid pin: it re-records the baseline after
  // a shrink (the browser clamped `scrollTop` down) and after an overscroll.
  if (isAtBottom(metrics)) return { kind: "pin", pinnedTop: bottomScrollTop(metrics) };
  // Growth leaves `scrollTop` where it was; only a move *above* the baseline is
  // evidence of intent, and the epsilon keeps a sub-pixel clamp from detaching.
  if (metrics.scrollTop >= pinnedTop - PIN_EPSILON_PX) {
    return { kind: "stay", pinnedTop };
  }
  return { kind: "detach" };
}

/** A wheel gesture that asks for earlier content. */
export function isScrollUpWheel(deltaY: number): boolean {
  return deltaY < 0;
}

/**
 * A touch drag that reveals earlier content. The finger moves *down* the screen
 * to scroll up, so the delta is positive; small jitters stay inside the slop so
 * a tap is not an intent to stop following.
 */
export function isScrollUpTouch(fromClientY: number, toClientY: number): boolean {
  return toClientY - fromClientY > TOUCH_SLOP_PX;
}

const DETACH_KEYS = new Set(["PageUp", "Home", "ArrowUp"]);

/** Keys that scroll the viewport up, i.e. the keyboard half of "stop following". */
export function isDetachKey(key: string): boolean {
  return DETACH_KEYS.has(key);
}
