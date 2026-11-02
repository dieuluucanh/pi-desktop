import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import { clampScrollLeft, revealScrollLeft, wheelScrollDelta } from "./tab-scroll";

/**
 * Binds the tab-strip wheel/reveal behaviour to a tablist element.
 *
 * React's synthetic `wheel` listener is passive, so it cannot reliably
 * `preventDefault`; this hook attaches a native non-passive listener. The
 * listener is attached once and reads live dimensions on every event, so it
 * keeps working when tabs are added or the window is resized.
 *
 * Reveal is deliberately tied to `activeTabId` only. `tabs` changes identity on
 * every main-process publish (window-focus reconcile, status/title updates), and
 * those updates must not move a strip the user scrolled by hand. A selection
 * change is the only event that should bring a tab into view; native browser
 * focus scrolling covers keyboard traversal.
 */
export function useTabStripScroll(activeTabId: string | null): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);

  const reveal = useCallback((tabId: string) => {
    const container = ref.current;
    if (!container) return;
    const chip = [...container.querySelectorAll<HTMLElement>("[data-tab-id]")].find(
      (element) => element.dataset.tabId === tabId,
    );
    if (!chip) return;
    const next = revealScrollLeft(
      {
        scrollLeft: container.scrollLeft,
        clientWidth: container.clientWidth,
        scrollWidth: container.scrollWidth,
      },
      { left: chip.offsetLeft, width: chip.offsetWidth },
    );
    if (next !== container.scrollLeft) container.scrollLeft = next;
  }, []);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const onWheel = (event: WheelEvent): void => {
      if (container.scrollWidth <= container.clientWidth) return;
      const delta = wheelScrollDelta(event, container.clientWidth);
      if (delta === null) return;
      event.preventDefault();
      container.scrollLeft = clampScrollLeft(
        container.scrollLeft + delta,
        container.scrollWidth,
        container.clientWidth,
      );
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, []);

  // Layout effect: reveal before paint so selecting an off-screen tab does not
  // flash the old scroll position for a frame. No `tabs` dependency.
  useLayoutEffect(() => {
    if (activeTabId) reveal(activeTabId);
  }, [activeTabId, reveal]);

  return ref;
}
