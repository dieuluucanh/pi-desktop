import { afterEach, describe, expect, it, vi } from "vitest";

import { createFocusResync } from "../../src/renderer/src/state/focus-resync";

/**
 * Focus burst coalescing (2026-11-03 plan step 9).
 *
 * One Alt+Tab emits `focus` and `visibilitychange`; they must produce one
 * reconcile, not two.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe("createFocusResync", () => {
  it("coalesces every request in one burst into a single run", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const resync = createFocusResync(run);

    resync.request();
    resync.request();
    resync.request();
    expect(run).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs again for a later burst", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const resync = createFocusResync(run);

    resync.request();
    vi.runAllTimers();
    resync.request();
    vi.runAllTimers();

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("drops a pending run when cancelled", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const resync = createFocusResync(run);

    resync.request();
    resync.cancel();
    vi.runAllTimers();

    expect(run).not.toHaveBeenCalled();
  });

  it("accepts an injected scheduler", () => {
    const run = vi.fn();
    const tasks: Array<() => void> = [];
    const resync = createFocusResync(run, (task) => {
      tasks.push(task);
      return () => undefined;
    });

    resync.request();
    resync.request();
    expect(tasks).toHaveLength(1);
    tasks[0]?.();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
