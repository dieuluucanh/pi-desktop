import { describe, expect, it, vi } from "vitest";

import { createQuitTeardown, type QuitEventLike } from "../../src/main/lifecycle";

/**
 * Quit teardown (plan step 27). Electron's `before-quit` cannot await, so the
 * policy is: prevent the first quit, dispose, then quit again — and the second
 * pass must not prevent default or the app never exits.
 */

function quitEvent(): { event: QuitEventLike; prevented: () => number } {
  let prevented = 0;
  return {
    event: {
      preventDefault: () => {
        prevented += 1;
      },
    },
    prevented: () => prevented,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createQuitTeardown (plan step 27)", () => {
  it("defers the quit, awaits disposal, then quits again", async () => {
    const gate = deferred();
    const dispose = vi.fn(() => gate.promise);
    const quit = vi.fn();
    const teardown = createQuitTeardown({ dispose, quit });
    const first = quitEvent();

    teardown.handleBeforeQuit(first.event);

    expect(first.prevented()).toBe(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();

    gate.resolve();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
  });

  it("does not run disposal twice when quit is requested again while it runs", async () => {
    const gate = deferred();
    const dispose = vi.fn(() => gate.promise);
    const quit = vi.fn();
    const teardown = createQuitTeardown({ dispose, quit });

    teardown.handleBeforeQuit(quitEvent().event);
    teardown.handleBeforeQuit(quitEvent().event);
    expect(dispose).toHaveBeenCalledTimes(1);

    gate.resolve();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("lets the re-entrant quit pass through once disposal has finished", async () => {
    const dispose = vi.fn(async () => {});
    let passThroughPrevented = 0;
    const teardown = createQuitTeardown({
      dispose,
      quit: () => {
        // What Electron does: emit `before-quit` again from `app.quit()`.
        teardown.handleBeforeQuit({
          preventDefault: () => {
            passThroughPrevented += 1;
          },
        });
      },
    });

    teardown.handleBeforeQuit(quitEvent().event);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));

    expect(passThroughPrevented).toBe(0);
  });

  it("reports a failing disposal and still quits", async () => {
    const error = new Error("profile is read-only");
    const onError = vi.fn();
    const quit = vi.fn();
    const teardown = createQuitTeardown({
      dispose: async () => {
        throw error;
      },
      quit,
      onError,
    });

    teardown.handleBeforeQuit(quitEvent().event);

    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
    expect(onError).toHaveBeenCalledWith(error);
  });
});
