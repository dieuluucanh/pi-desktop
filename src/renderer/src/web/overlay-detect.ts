import type { WebTabBounds } from "../../../shared/web-tabs";

/** Rounds a layout rectangle into the wire shape main expects. Pure, DOM-free. */
export function webTabBoundsFromRect(
  rect: { x: number; y: number; width: number; height: number },
  visible: boolean,
): WebTabBounds {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
    visible,
  };
}

/**
 * Selectors for a renderer overlay that must cover a web tab.
 *
 * A native `WebContentsView` always paints above the React renderer, so a dialog
 * or menu would be hidden behind it. The overlay detector is how the view learns
 * to step aside. It is intentionally narrow: an open *collapsible* also carries
 * `data-state="open"`, and hiding the view whenever the sidebar is expanded would
 * be wrong, so only genuine overlay surfaces match.
 */
export const OVERLAY_SELECTOR = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[role="menu"][data-state="open"]',
  "[data-radix-popper-content-wrapper]",
  "[data-sonner-toast]",
].join(", ");

/** True when an overlay that would sit above the web view is on screen. */
export function overlayOpenIn(root: Pick<Document, "querySelector"> | null | undefined): boolean {
  if (!root) return false;
  return root.querySelector(OVERLAY_SELECTOR) !== null;
}

/**
 * Calls `onChange` whenever an overlay appears or disappears. The first call is
 * immediate, so a view that mounts under an open dialog is hidden at once.
 */
export function observeOverlays(root: Document, onChange: (open: boolean) => void): () => void {
  if (typeof MutationObserver === "undefined" || !root.body) {
    onChange(overlayOpenIn(root));
    return () => undefined;
  }
  let last = overlayOpenIn(root);
  const observer = new MutationObserver(() => {
    const next = overlayOpenIn(root);
    if (next !== last) {
      last = next;
      onChange(next);
    }
  });
  observer.observe(root.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-state", "open"],
  });
  onChange(last);
  return () => observer.disconnect();
}
