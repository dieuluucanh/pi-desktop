/**
 * Geometry helpers for the tab strips.
 *
 * Kept pure so the wheel normalization and reveal math can be tested without a
 * browser layout. The hook in `use-tab-scroll.ts` only binds these to a DOM
 * element; it never re-implements the arithmetic.
 */

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

export interface ScrollMetrics {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
}

export interface TabMetrics {
  /** Offset inside the (relatively positioned) tablist. */
  left: number;
  width: number;
}

/**
 * The horizontal distance one wheel event should move a tab strip.
 *
 * - Ctrl/Cmd + wheel is pinch-to-zoom, not tab scrolling.
 * - The dominant axis wins, so a trackpad's horizontal gesture works and a
 *   normal vertical wheel scrolls the strip like VS Code.
 * - `deltaMode` 1 is lines (DOM_DELTA_LINE), 2 is pages (DOM_DELTA_PAGE).
 *
 * Returns `null` when the event carries no usable delta.
 */
export function wheelScrollDelta(event: WheelLike, viewportWidth: number): number | null {
  if (event.ctrlKey || event.metaKey) return null;
  const dominant = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (!Number.isFinite(dominant) || dominant === 0) return null;
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? Math.max(1, viewportWidth) : 1;
  return dominant * unit;
}

/** Clamp a proposed `scrollLeft` to the strip's real scroll range. */
export function clampScrollLeft(value: number, scrollWidth: number, clientWidth: number): number {
  const max = Math.max(0, scrollWidth - clientWidth);
  return Math.min(max, Math.max(0, value));
}

/**
 * The `scrollLeft` that brings `tab` fully into view with the least movement.
 *
 * Already-visible tabs keep the current offset; a tab to the left aligns its
 * start with the viewport; a tab to the right aligns its end. The result is
 * clamped so the strip never over-scrolls into empty space.
 */
export function revealScrollLeft(container: ScrollMetrics, tab: TabMetrics): number {
  let next = container.scrollLeft;
  if (tab.left < next) {
    next = tab.left;
  } else if (tab.left + tab.width > next + container.clientWidth) {
    next = tab.left + tab.width - container.clientWidth;
  }
  return clampScrollLeft(next, container.scrollWidth, container.clientWidth);
}
