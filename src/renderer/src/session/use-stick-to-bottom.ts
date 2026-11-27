/**
 * The transcript's follow engine (2026-11-25 transcript follow plan).
 *
 * Step 1 extracted this scroll model out of `Transcript.tsx`; step 2 replaced its
 * 80 px distance rule with pinned-state follow:
 *
 * - `pinnedRef` is the state and `pinnedTopRef` is the baseline a detach must
 *   beat. A `scroll` event may only detach when `scrollTop` is provably above
 *   that baseline, so a coalesced burst of growth never stops follow.
 * - Explicit gestures (wheel up, an upward touch drag, PageUp/Home/ArrowUp)
 *   detach *before* the resulting scroll event, so a slow drag cannot be outrun
 *   by the next pin.
 * - Auto-follow is instant; `smooth` belongs to the pill and `Ctrl+End` and is
 *   guarded for the animation's duration.
 *
 * The ref stays the source of truth (an effect never waits for a re-render) and
 * the `atBottom`/`hasNews` state only drives the "jump to latest" pill. The
 * arithmetic and the intent predicates live in `scroll-follow.ts`.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { hasSelectionWithin } from "../ui/clipboard";
import {
  SMOOTH_GUARD_MS,
  bottomScrollTop,
  decideScrollFollow,
  isAtBottom,
  isDetachKey,
  isScrollUpTouch,
  isScrollUpWheel,
} from "./scroll-follow";

export interface StickToBottomOptions {
  /** The transcript's item count; growth pins when the view is following. */
  itemCount: number;
  /** A size signature of the last item's streamed text (`streamSize`). */
  contentSignature: number;
  /**
   * The virtualizer's total size, when the transcript virtualizes. A measured
   * row settling changes it without changing any text, so an estimated height
   * re-pins even where no `ResizeObserver` exists (2026-11-25 plan step 3). It
   * is a content change for pinning and `hasNews` exactly like
   * `contentSignature`.
   */
  contentSize?: number;
  /** Suspends follow while an overlay owns the user's attention. */
  paused?: boolean;
}

export interface StickToBottom {
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  atBottom: boolean;
  hasNews: boolean;
  isPinned(): boolean;
  scrollToBottom(behavior?: ScrollBehavior, options?: { force?: boolean }): void;
  detachForJump(): void;
}

export function useStickToBottom({
  itemCount,
  contentSignature,
  contentSize = 0,
  paused = false,
}: StickToBottomOptions): StickToBottom {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const pinnedTopRef = useRef(0);
  /**
   * A deadline (ms) while a smooth jump animates the viewport. Scroll events
   * before it are ours, not the reader's; the landing scroll ends it earlier.
   */
  const smoothUntilRef = useRef<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [hasNews, setHasNews] = useState(false);

  /**
   * Follow from the tail: scroll to the bottom and record the baseline a detach
   * must beat. `bottomScrollTop` is where the browser lands, which is also the
   * clamp a shrink and an overscroll settle on.
   */
  const pinToBottom = useCallback((behavior: ScrollBehavior = "auto"): void => {
    const node = scrollRef.current;
    if (!node) return;
    smoothUntilRef.current = behavior === "smooth" ? Date.now() + SMOOTH_GUARD_MS : null;
    if (typeof node.scrollTo === "function") {
      node.scrollTo({ top: node.scrollHeight, behavior });
    } else {
      node.scrollTop = node.scrollHeight;
    }
    pinnedRef.current = true;
    pinnedTopRef.current = bottomScrollTop(node);
    setAtBottom(true);
    setHasNews(false);
  }, []);

  const isPinned = useCallback((): boolean => pinnedRef.current, []);

  /** Stop following: a gesture or a jump took the viewport; the pill is the way back. */
  const detach = useCallback((): void => {
    // A gesture also cancels a pending smooth jump: the reader wins the race.
    smoothUntilRef.current = null;
    if (!pinnedRef.current) return;
    pinnedRef.current = false;
    setAtBottom(false);
  }, []);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "auto", options?: { force?: boolean }) => {
      const node = scrollRef.current;
      if (!node) return;
      // A live selection belongs to the user. Auto-follow must not move the
      // viewport out from under a drag-select while a response streams; the
      // pill and Ctrl+End are the explicit ways to force it (2026-10-30 copy
      // plan). The pin ref deliberately stays untouched, so clearing the
      // selection lets the next streamed delta resume follow.
      if (!options?.force && hasSelectionWithin(node)) {
        setAtBottom(false);
        setHasNews(true);
        return;
      }
      pinToBottom(behavior);
    },
    [pinToBottom],
  );

  /**
   * Explicit jumps (find navigation) take the viewport; follow resumes via the
   * pill. The guard is cleared too, so a jump cannot be mistaken for our own
   * smooth landing.
   */
  const detachForJump = useCallback((): void => {
    detach();
  }, [detach]);

  const handleScroll = useCallback((): void => {
    const node = scrollRef.current;
    if (!node) return;
    const guard = smoothUntilRef.current;
    if (guard !== null) {
      // Our own smooth jump is animating the viewport: its scroll events are not
      // evidence of anything. The landing scroll ends the guard and pins.
      if (isAtBottom(node)) {
        smoothUntilRef.current = null;
        pinnedRef.current = true;
        pinnedTopRef.current = bottomScrollTop(node);
        setAtBottom(true);
        setHasNews(false);
        return;
      }
      if (Date.now() < guard) return;
      smoothUntilRef.current = null;
    }
    const decision = decideScrollFollow({
      pinned: pinnedRef.current,
      pinnedTop: pinnedTopRef.current,
      scrollTop: node.scrollTop,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    });
    if (decision.kind === "ignore") return;
    if (decision.kind === "detach") {
      pinnedRef.current = false;
      setAtBottom(false);
      return;
    }
    pinnedRef.current = true;
    pinnedTopRef.current = decision.pinnedTop;
    setAtBottom(true);
    setHasNews(false);
  }, []);

  // The hook owns the scroller listeners so callers keep the same markup without
  // threading handlers through the interface. `itemCount` re-attaches them after
  // the empty state swaps in the real scroller.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.addEventListener("scroll", handleScroll, { passive: true });

    // Gestures are intent *before* the scroll event they cause, so detaching here
    // keeps a slow drag ahead of the next pin. Passive: the hook never prevents
    // the gesture, it only stops following.
    const onWheel = (event: WheelEvent): void => {
      if (isScrollUpWheel(event.deltaY)) detach();
    };
    let touchY: number | null = null;
    const onTouchStart = (event: TouchEvent): void => {
      touchY = event.touches.length === 1 ? (event.touches[0]?.clientY ?? null) : null;
    };
    const onTouchMove = (event: TouchEvent): void => {
      const currentY = event.touches[0]?.clientY;
      if (currentY === undefined) return;
      if (touchY === null) {
        touchY = currentY;
        return;
      }
      // The finger moving down the screen reveals earlier content.
      if (isScrollUpTouch(touchY, currentY)) detach();
    };
    const onTouchEnd = (): void => {
      touchY = null;
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isDetachKey(event.key)) return;
      // Arrow/Home inside a field belong to the field, not to the transcript.
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, [contenteditable='true']")) return;
      detach();
    };

    node.addEventListener("wheel", onWheel, { passive: true });
    node.addEventListener("touchstart", onTouchStart, { passive: true });
    node.addEventListener("touchmove", onTouchMove, { passive: true });
    node.addEventListener("touchend", onTouchEnd, { passive: true });
    node.addEventListener("touchcancel", onTouchEnd, { passive: true });
    node.addEventListener("keydown", onKeyDown);
    return () => {
      node.removeEventListener("scroll", handleScroll);
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("touchstart", onTouchStart);
      node.removeEventListener("touchmove", onTouchMove);
      node.removeEventListener("touchend", onTouchEnd);
      node.removeEventListener("touchcancel", onTouchEnd);
      node.removeEventListener("keydown", onKeyDown);
    };
  }, [itemCount, handleScroll, detach]);

  /**
   * The follow pin, before paint so a new delta never appears a frame above the
   * tail. `hasNews` is honest: the pill only appears when the content actually
   * changed *and* the reader is above, so mounting a session never raises it.
   */
  const lastCount = useRef(itemCount);
  const lastSignature = useRef(contentSignature);
  const lastSize = useRef(contentSize);
  useLayoutEffect(() => {
    const changed =
      itemCount !== lastCount.current ||
      contentSignature !== lastSignature.current ||
      contentSize !== lastSize.current;
    lastCount.current = itemCount;
    lastSignature.current = contentSignature;
    lastSize.current = contentSize;
    if (changed && !pinnedRef.current) {
      setHasNews(true);
      return;
    }
    // Paused suppresses the pin only: the pin ref survives, so closing the
    // overlay re-pins if the reader was still following (and a gesture taken
    // while paused has already cleared it). `scrollToBottom` keeps the live
    // selection guard, so a pin never moves the viewport under a drag-select.
    if (paused || !pinnedRef.current) return;
    scrollToBottom();
  }, [itemCount, contentSignature, contentSize, paused, scrollToBottom]);

  // Layout growth (an image decoding, a Mermaid block settling) does not change
  // text length, so observe the content box where the platform supports it,
  // coalesced to one pin per frame. Without `ResizeObserver` (jsdom, old hosts)
  // the content signature above is the deterministic fallback.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    if (typeof ResizeObserver === "undefined") return;
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      // Layout growth while the reader is above is not news: only the item count
      // and the content signature raise the pill.
      if (paused || !pinnedRef.current || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (!pinnedRef.current) return;
        scrollToBottom();
      });
    });
    observer.observe(content);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [paused, scrollToBottom]);

  return { scrollRef, contentRef, atBottom, hasNews, isPinned, scrollToBottom, detachForJump };
}
