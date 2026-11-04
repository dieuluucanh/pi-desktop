/**
 * Coalesces the focus burst (2026-11-03 plan step 9).
 *
 * Alt+Tab produces both `window.focus` and `document.visibilitychange` for one
 * activation, and each one used to run a full `sessions.reconcile()` — the
 * reconcile publishes the tab table, which (before the identity fix) reloaded
 * every open editor. One `request()` per burst is enough: the reconcile is not
 * an incremental event, it reads the current state either way.
 */

export interface FocusResync {
  /** Ask for one run after the current task. Repeated calls in the same burst coalesce. */
  request(): void;
  /** Drop a pending run (component unmount). */
  cancel(): void;
}

type Schedule = (task: () => void) => () => void;

const scheduleTrailing: Schedule = (task) => {
  const timer = globalThis.setTimeout(task, 0);
  return () => globalThis.clearTimeout(timer);
};

export function createFocusResync(
  run: () => void,
  schedule: Schedule = scheduleTrailing,
): FocusResync {
  let cancelPending: (() => void) | null = null;
  return {
    request() {
      if (cancelPending) return;
      cancelPending = schedule(() => {
        cancelPending = null;
        run();
      });
    },
    cancel() {
      cancelPending?.();
      cancelPending = null;
    },
  };
}
