/**
 * Quit teardown policy (plan step 27).
 *
 * Electron's `before-quit` is synchronous, so a teardown that awaits anything —
 * flushing the tab table, stopping every host — has to `preventDefault()`, await
 * the disposal and then quit again. The first implementation discarded the
 * promise with `void`, so the process could exit before the hosts were stopped
 * and before the tab table was written. This module owns that ordering and stays
 * Electron-free so it is unit tested; `index.ts` only supplies the ports.
 */

export interface QuitEventLike {
  preventDefault(): void;
}

export interface QuitTeardownOptions {
  /** Runs once, before the app is allowed to exit. */
  dispose(): void | Promise<void>;
  /** Asks Electron to quit again; the handler lets this pass through. */
  quit(): void;
  /** Receives a teardown failure. The app still quits. */
  onError?(error: unknown): void;
}

export interface QuitTeardown {
  /**
   * `before-quit` handler. The first call defers the quit, runs `dispose` and
   * then calls `quit`; the re-entrant call returns without preventing default,
   * so the exit proceeds.
   */
  handleBeforeQuit(event: QuitEventLike): void;
}

export function createQuitTeardown(options: QuitTeardownOptions): QuitTeardown {
  let state: "idle" | "disposing" | "done" = "idle";
  return {
    handleBeforeQuit(event) {
      // The second pass (from `quit()` after a finished teardown) must not
      // prevent default, or the app would never exit.
      if (state === "done") return;
      event.preventDefault();
      // A quit requested while the teardown is already running (menu + window
      // close, or a second Ctrl+Q) joins it instead of disposing twice.
      if (state === "disposing") return;
      state = "disposing";
      void (async () => {
        try {
          await options.dispose();
        } catch (error) {
          options.onError?.(error);
        } finally {
          state = "done";
          options.quit();
        }
      })();
    },
  };
}
