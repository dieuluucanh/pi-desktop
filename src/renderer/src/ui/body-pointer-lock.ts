/**
 * Recovery net for a stale modal body lock (2026-11-03 plan step 3).
 *
 * Radix's `DismissableLayer` sets `document.body { pointer-events: none }`
 * while a modal layer is open and restores the previous value when it closes.
 * The bookkeeping is *module-level*, so two installed copies of the package
 * each restore their own idea of the previous value. The delete flow in the
 * explorer proved the failure: a context menu (copy A) opened, a dialog
 * (copy B) mounted while the lock was active and recorded `"none"` as its
 * "original", then restored `"none"` on close. The renderer kept running but
 * ignored every click — no error, no toast, just a dead window.
 *
 * `package.json` now forces one copy of every stateful dependency
 * (`tests/architecture/radix-singletons.test.ts` guards it). This module is the
 * recovery path for whatever reintroduces the split next: after the last app
 * dialog unmounts, and whenever the window regains focus, clear the lock *only
 * when no modal layer is actually open*.
 */

/** Selectors for the modal surfaces that legitimately hold the body lock. */
const OPEN_MODAL_SELECTOR = [
  '[role="dialog"][data-state="open"]',
  '[role="menu"][data-state="open"]',
  '[data-radix-popper-content-wrapper] [data-state="open"]',
].join(", ");

/**
 * Clears `pointer-events: none` from the body when it was left behind by an
 * unmounted layer. Returns `true` when a stale lock was removed.
 *
 * No-op while a dialog, menu or popper surface is open: unlocking then would
 * let clicks leak through a real modal.
 */
export function releaseStaleBodyPointerLock(doc: Document = document): boolean {
  if (doc.body.style.pointerEvents !== "none") return false;
  if (doc.querySelector(OPEN_MODAL_SELECTOR)) return false;
  doc.body.style.pointerEvents = "";
  return true;
}

/**
 * Runs the check after the current task, once Radix has run its own effect
 * cleanups. Called from `DialogContent`'s unmount, which is the exact moment
 * the reported lock is left behind.
 */
export function scheduleBodyPointerLockCheck(doc: Document = document): void {
  globalThis.setTimeout(() => releaseStaleBodyPointerLock(doc), 0);
}
