import { describe, expect, it } from "vitest";
import {
  PIN_EPSILON_PX,
  bottomScrollTop,
  decideScrollFollow,
  distanceFromBottom,
  isAtBottom,
  isDetachKey,
  isScrollUpTouch,
  isScrollUpWheel,
} from "../../src/renderer/src/session/scroll-follow";

/**
 * The follow arithmetic (2026-11-25 transcript follow plan step 2).
 *
 * Following is a state, not a distance: the viewport is pinned to the tail and a
 * scroll event may only detach when it proves the reader moved above the
 * baseline the last pin recorded. These cases are the decision table
 * (`pinned × grew × moved`), including the content-shrink clamp.
 */

/** The default geometry: a 2 000 px transcript in a 400 px viewport, on its tail. */
function atTail(scrollTop: number, scrollHeight = 2_000) {
  return { scrollTop, scrollHeight, clientHeight: 400 };
}

const pinnedAt = (pinnedTop: number) => ({ pinned: true, pinnedTop });
const unpinned = { pinned: false, pinnedTop: 0 } as const;

describe("distanceFromBottom", () => {
  it("is zero when the viewport sits exactly at the bottom", () => {
    expect(distanceFromBottom(atTail(1_600))).toBe(0);
  });

  it("is the pixels of content still hidden below the viewport", () => {
    expect(distanceFromBottom(atTail(600))).toBe(1_000);
  });

  it("is negative while the scroller overscrolls", () => {
    expect(distanceFromBottom(atTail(1_700))).toBe(-100);
  });
});

describe("bottomScrollTop", () => {
  it("is the offset a scroll to `scrollHeight` lands on", () => {
    expect(bottomScrollTop(atTail(0))).toBe(1_600);
    expect(bottomScrollTop({ scrollHeight: 2_400, scrollTop: 0, clientHeight: 400 })).toBe(2_000);
  });

  it("never goes negative for content shorter than the viewport", () => {
    expect(bottomScrollTop({ scrollHeight: 120, scrollTop: 0, clientHeight: 400 })).toBe(0);
  });
});

describe("isAtBottom", () => {
  it("accepts an exact landing and a one-pixel clamp", () => {
    expect(isAtBottom(atTail(1_600))).toBe(true);
    expect(isAtBottom(atTail(1_599))).toBe(true);
  });

  it("rejects anything more than an epsilon above the tail", () => {
    expect(isAtBottom(atTail(1_598))).toBe(false);
    expect(isAtBottom(atTail(900))).toBe(false);
  });

  it("treats an overscroll as the tail", () => {
    expect(isAtBottom(atTail(1_700))).toBe(true);
  });

  it("takes the epsilon from the caller", () => {
    expect(isAtBottom(atTail(1_595), 5)).toBe(true);
    expect(isAtBottom(atTail(1_594), 5)).toBe(false);
  });
});

describe("decideScrollFollow — pinned", () => {
  it("stays pinned when the content grew and the viewport did not move", () => {
    // A coalesced delta added 400 px: five times the retired 80 px threshold.
    expect(decideScrollFollow({ ...pinnedAt(1_600), ...atTail(1_600, 2_400) })).toEqual({
      kind: "stay",
      pinnedTop: 1_600,
    });
  });

  it("stays pinned through a very large burst", () => {
    expect(decideScrollFollow({ ...pinnedAt(1_600), ...atTail(1_600, 20_000) })).toEqual({
      kind: "stay",
      pinnedTop: 1_600,
    });
  });

  it("stays pinned when the browser overscrolls the tail", () => {
    // At the tail already: re-records the same baseline instead of detaching.
    expect(decideScrollFollow({ ...pinnedAt(1_600), ...atTail(1_750) })).toEqual({
      kind: "pin",
      pinnedTop: 1_600,
    });
  });

  it("tolerates a sub-pixel clamp above the baseline", () => {
    expect(decideScrollFollow({ ...pinnedAt(1_600), ...atTail(1_599, 2_400) })).toEqual({
      kind: "stay",
      pinnedTop: 1_600,
    });
  });

  it("detaches when a scrollbar drag moves above the baseline", () => {
    expect(decideScrollFollow({ ...pinnedAt(1_600), ...atTail(900) })).toEqual({
      kind: "detach",
    });
  });

  it("detaches a two-pixel move, i.e. beyond the epsilon", () => {
    expect(decideScrollFollow({ ...pinnedAt(1_600), ...atTail(1_598, 2_400) })).toEqual({
      kind: "detach",
    });
  });

  it("re-records the baseline when a shrink clamps the viewport to the new tail", () => {
    // The content shrank to 1 000 px; the browser clamped `scrollTop` from
    // 1 600 to 600, which is the new bottom. That is not an upward move.
    expect(decideScrollFollow({ ...pinnedAt(1_600), ...atTail(600, 1_000) })).toEqual({
      kind: "pin",
      pinnedTop: 600,
    });
  });

  it("re-records the baseline when a shrink lands the viewport at the bottom", () => {
    expect(decideScrollFollow({ ...pinnedAt(1_600), ...atTail(1_200, 1_600) })).toEqual({
      kind: "pin",
      pinnedTop: 1_200,
    });
  });

  it("still detaches when a shrink moves the reader above the new tail", () => {
    // Clamped content, but the viewport is 300 px above the new bottom: the
    // reader dragged, not the layout.
    expect(decideScrollFollow({ ...pinnedAt(1_600), ...atTail(900, 1_600) })).toEqual({
      kind: "detach",
    });
  });
});

describe("decideScrollFollow — unpinned", () => {
  it("re-pins when the reader scrolls back to the tail", () => {
    expect(decideScrollFollow({ ...unpinned, ...atTail(1_600) })).toEqual({
      kind: "pin",
      pinnedTop: 1_600,
    });
  });

  it("re-pins from an overscroll", () => {
    expect(decideScrollFollow({ ...unpinned, ...atTail(1_700) })).toEqual({
      kind: "pin",
      pinnedTop: 1_600,
    });
  });

  it("ignores a scroll that stays above the tail", () => {
    expect(decideScrollFollow({ ...unpinned, ...atTail(900) })).toEqual({ kind: "ignore" });
  });

  it("ignores growth above the tail; the hook raises the pill instead", () => {
    expect(decideScrollFollow({ ...unpinned, ...atTail(1_600, 2_400) })).toEqual({
      kind: "ignore",
    });
  });
});

describe("gesture intent", () => {
  it("reads only an upward wheel as intent", () => {
    expect(isScrollUpWheel(-1)).toBe(true);
    expect(isScrollUpWheel(-120)).toBe(true);
    expect(isScrollUpWheel(0)).toBe(false);
    expect(isScrollUpWheel(120)).toBe(false);
  });

  it("reads a downward finger drag as an upward scroll", () => {
    expect(isScrollUpTouch(100, 120)).toBe(true);
    // Jitter inside the slop is a tap, not a gesture.
    expect(isScrollUpTouch(100, 102)).toBe(false);
    // Moving the finger up the screen reveals later content.
    expect(isScrollUpTouch(120, 100)).toBe(false);
  });

  it("detaches on the keys that scroll up", () => {
    for (const key of ["PageUp", "Home", "ArrowUp"]) expect(isDetachKey(key)).toBe(true);
    for (const key of ["PageDown", "End", "ArrowDown", "Escape"]) {
      expect(isDetachKey(key)).toBe(false);
    }
  });

  it("keeps the pinned baseline epsilon at one pixel", () => {
    expect(PIN_EPSILON_PX).toBe(1);
  });
});
