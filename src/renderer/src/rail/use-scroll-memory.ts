/**
 * The rail's per-block scroll restore hook (2026-11-25 rail scroll plan step 5).
 *
 * `scroll-memory.ts` owns the offsets; this hook is the DOM adapter around it.
 * It is generic on purpose — the transcript has its own follow engine and the
 * rail supplies `block:folder` keys — so it knows nothing about git, menus or
 * sources.
 *
 * Three rules this file exists to hold:
 *
 *  - **Never save an unready block.** A loading/empty block has no list to
 *    measure, so its `scrollTop` is 0; saving that would erase the offset the
 *    block is about to restore.
 *  - **Restore only into enough content.** The saved offset is assigned at
 *    once, then confirmed on the next frame. While the list is still shorter
 *    than the offset, retry through a `ResizeObserver` on the scroller's first
 *    child (or a bounded rAF loop where the platform has none) and give up
 *    after `RESTORE_DEADLINE_MS`.
 *  - **The reader wins.** A wheel, pointer, key or any scroll the restore did
 *    not write cancels the pending restore instead of fighting it.
 *
 * A saved entry is never deleted on unmount: surviving the remount is the whole
 * point, and the LRU cap in `scroll-memory.ts` already bounds memory.
 */

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { recallScroll, rememberScroll } from "./scroll-memory";

export interface ScrollMemoryOptions {
  /** The memory key; rail callers use `block:folder`. */
  key: string;
  /** Whether the block has content. Saves are ignored while false. */
  ready: boolean;
}

/** How long a restore keeps retrying for content tall enough to hold the offset. */
export const RESTORE_DEADLINE_MS = 1_000;

export function useScrollMemory({
  key,
  ready,
}: ScrollMemoryOptions): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  /** True from the moment a restore starts until it lands or is cancelled. */
  const restoringRef = useRef(false);

  // Save: the listener is native so callers keep their markup free of
  // `onScroll`, and rAF coalesces a burst of scroll events into one write.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    let frame: number | null = null;
    const onScroll = (): void => {
      if (!ready || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        // The restore's own writes are not user intent, and an unready block
        // must never overwrite the offset it is restoring.
        if (!ready || restoringRef.current) return;
        rememberScroll(key, node.scrollTop);
      });
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      node.removeEventListener("scroll", onScroll);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [key, ready]);

  // Restore before paint, so a saved offset never flashes at the top first.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const saved = recallScroll(key);
    if (saved === undefined) return;

    let stopped = false;
    let frame: number | null = null;
    let observer: ResizeObserver | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    /** The `scrollTop` the last restore write produced, after clamping. */
    let ownTop: number | null = null;
    restoringRef.current = true;

    const canHold = (): boolean => node.scrollHeight - node.clientHeight >= saved;

    const clearFrame = (): void => {
      if (frame === null) return;
      cancelAnimationFrame(frame);
      frame = null;
    };

    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      restoringRef.current = false;
      clearFrame();
      observer?.disconnect();
      observer = null;
      if (deadline !== null) {
        clearTimeout(deadline);
        deadline = null;
      }
      node.removeEventListener("scroll", onCancelScroll);
      node.removeEventListener("wheel", stop);
      node.removeEventListener("pointerdown", stop);
      node.removeEventListener("keydown", stop);
    };

    const onCancelScroll = (): void => {
      // Our own assignment — possibly clamped while the list is still short —
      // is not the reader moving the viewport. Any other scroll means they won.
      if (ownTop !== null && Math.abs(node.scrollTop - ownTop) <= 1) return;
      stop();
    };

    const write = (): void => {
      node.scrollTop = saved;
      ownTop = node.scrollTop;
    };

    /** Wait for content growth: observe the child, or poll without an observer. */
    const waitForContent = (): void => {
      if (stopped) return;
      if (typeof ResizeObserver === "function") {
        const child = node.firstElementChild;
        if (child) {
          observer = new ResizeObserver(() => {
            if (stopped || !canHold()) return;
            write();
            stop();
          });
          observer.observe(child);
          return;
        }
      }
      const tick = (): void => {
        frame = null;
        if (stopped) return;
        if (!canHold()) {
          frame = requestAnimationFrame(tick);
          return;
        }
        write();
        stop();
      };
      frame = requestAnimationFrame(tick);
    };

    const confirm = (): void => {
      frame = null;
      if (stopped) return;
      if (canHold()) {
        stop();
        return;
      }
      waitForContent();
    };

    // Act at once — the content is usually already there — then confirm the
    // offset can actually be held rather than trust a clamped assignment.
    write();
    node.addEventListener("scroll", onCancelScroll, { passive: true });
    node.addEventListener("wheel", stop, { passive: true });
    node.addEventListener("pointerdown", stop, { passive: true });
    node.addEventListener("keydown", stop);
    deadline = setTimeout(stop, RESTORE_DEADLINE_MS);
    frame = requestAnimationFrame(confirm);

    return stop;
  }, [key, ready]);

  return ref;
}
