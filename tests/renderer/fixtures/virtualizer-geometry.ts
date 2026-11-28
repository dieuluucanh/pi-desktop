import { vi } from "vitest";

/**
 * A layout for the transcript virtualizer (2026-11-25 plan step 3).
 *
 * jsdom has no layout engine: every element reports `offsetHeight` 0, which is
 * exactly the size `@tanstack/virtual-core` reads for the scroller (`getRect`)
 * and for each measured row (`measureElement`). With a zero-sized viewport the
 * virtual window is empty, so a test that asserts the virtualized branch needs
 * to give the scroller a height and the rows the 96 px the transcript estimates.
 *
 * The overrides are scoped to one call (the getter is restored in `finally`), so
 * a test that does not opt in keeps jsdom's zero geometry.
 */

/** The scroller's height while the shim is installed (`data-testid="transcript"`). */
export const VIRTUALIZED_VIEWPORT_PX = 400;
/** A measured row's height while the shim is installed (`data-index` rows). */
export const VIRTUALIZED_ROW_PX = 96;

export function withVirtualizedGeometry<T>(run: () => T): T {
  const spy = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ): number {
    if (this.dataset["testid"] === "transcript") return VIRTUALIZED_VIEWPORT_PX;
    if (this.dataset["index"] !== undefined) return VIRTUALIZED_ROW_PX;
    return 0;
  });
  try {
    return run();
  } finally {
    spy.mockRestore();
  }
}
