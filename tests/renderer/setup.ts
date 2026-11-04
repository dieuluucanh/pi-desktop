import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { endTabDrag } from "../../src/renderer/src/state/tab-drag-session";

/**
 * Renderer-test setup (plan step 1).
 *
 * Vitest runs without globals here, so Testing Library's automatic cleanup is
 * not registered for us — without this the DOM accumulates between tests and
 * queries start finding duplicates.
 *
 * jsdom implements neither pointer capture nor `scrollIntoView`, both of which
 * Radix's menu/popover primitives call on open (first needed by the tab overflow
 * menu in step 11). The shims are no-ops: the components only use them to keep
 * focus bookkeeping consistent, which the tests do not exercise.
 */
afterEach(() => {
  cleanup();
  endTabDrag();
  // A live Radix dialog leaves a body pointer-events/aria-hidden lock that
  // would poison every later test in the file. Clearing it here keeps a leaked
  // lock from being reported by the wrong test (the delete regression asserts
  // the invariant explicitly).
  document.body.style.pointerEvents = "";
  document.body.removeAttribute("data-scroll-locked");
});

if (!Element.prototype.hasPointerCapture) {
  // A real pointer-capture set: Radix's dismiss layer treats a pointerdown as
  // "outside" only when the target does not hold the capture, so returning a
  // constant `false` would close every menu on the click that opened it.
  const captured = new WeakSet<Element>();
  Element.prototype.setPointerCapture = function setPointerCapture(this: Element) {
    captured.add(this);
  };
  Element.prototype.releasePointerCapture = function releasePointerCapture(this: Element) {
    captured.delete(this);
  };
  Element.prototype.hasPointerCapture = function hasPointerCapture(this: Element) {
    return captured.has(this);
  };
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => undefined;
}
