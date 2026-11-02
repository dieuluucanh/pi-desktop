import {
  initialUpdateState,
  reduceUpdateState,
  type UpdateErrorContext,
  type UpdateEvent,
  type UpdateState,
  type UpdateUnsupportedReason,
} from "../shared/updates";

/**
 * The update service (plan step 26).
 *
 * Electron-free on purpose: `electron-updater` is injected as an {@link UpdatePort}
 * (`src/main/electron-updater.ts` is the only module that imports it), so the
 * policy — when a check may run, how an automatic check differs from a manual
 * one, what happens on failure — is unit-tested with a fake port and no network.
 *
 * `autoDownload` is off: a check reports, and the user chooses to download and
 * restart. Installation quits the app, which is `electron-updater`'s contract.
 */

/** The narrow surface `electron-updater` is reduced to. */
export interface UpdatePort {
  /** Subscribes to updater events; returns an unsubscriber. */
  subscribe(listener: (event: UpdateEvent) => void): () => void;
  /** Starts a check. Errors arrive as an `error` event, not a rejection. */
  check(): void | Promise<void>;
  /** Downloads the offered update. Progress arrives as `progress` events. */
  download(): void | Promise<void>;
  /** Quits and installs the downloaded update. */
  install(): void;
}

export interface CreateUpdateServiceOptions {
  /** Null when the updater could not be wired (a dev build, safe mode, a failure). */
  port: UpdatePort | null;
  /** Whether this build may use the updater at all (see `resolveUpdateSupport`). */
  supported: boolean;
  /** Why the updater is unsupported; carried into the pushed state. */
  unsupportedReason?: UpdateUnsupportedReason | null;
  /** The running app version, so a feed cannot offer this same build. */
  currentVersion: string;
  /** Injected clock; used by tests to make `checkedAt` deterministic. */
  now?: () => number;
  /** Called on every state change so main can push it to the renderer. */
  onChange?: (state: UpdateState) => void;
}

export interface UpdateCheckOptions {
  /** The startup timer passes true; every user gesture passes false. */
  automatic?: boolean;
}

export interface UpdateService {
  state(): UpdateState;
  /** Starts a check unless one is already running. */
  check(options?: UpdateCheckOptions): Promise<UpdateState>;
  /** Downloads the offered update (no-op unless one is available). */
  download(): Promise<UpdateState>;
  /** Quits and installs a downloaded update; false when nothing is ready. */
  install(): boolean;
  /** Clears a recorded problem without discarding an offer/download. */
  clearProblem(): UpdateState;
  dispose(): void;
}

export function createUpdateService(options: CreateUpdateServiceOptions): UpdateService {
  const port = options.supported ? options.port : null;
  const supported = port !== null;
  const now = options.now ?? (() => Date.now());
  let state = initialUpdateState(supported, {
    currentVersion: options.currentVersion,
    unsupportedReason: supported ? null : (options.unsupportedReason ?? "updater-unavailable"),
  });
  let busy = false;
  let busyAction: "check" | "download" | null = null;
  let disposed = false;

  const publish = (next: UpdateState): void => {
    state = next;
    if (!disposed) options.onChange?.(state);
  };

  const unsubscribe = port
    ? port.subscribe((event) => {
        // The library's error event does not say which action failed. Attach the
        // action we started so a check-time 404 becomes "no feed" while a
        // download-time 404 stays a retryable download failure.
        const mapped: UpdateEvent =
          event.type === "error" && event.context === undefined
            ? { ...event, context: busyAction ?? "check" }
            : event;
        publish(reduceUpdateState(state, mapped, now()));
      })
    : () => undefined;

  /** Runs a port action, mapping a rejection to an `error` event. */
  const run = async (
    action: "check" | "download",
    call: () => void | Promise<void>,
    checkOptions?: UpdateCheckOptions,
  ) => {
    if (!port || busy) return state;
    busy = true;
    busyAction = action;
    try {
      if (action === "check") {
        // A click is a check in the user's eyes: show it immediately rather
        // than waiting for the feed's first event. An automatic check keeps the
        // settled phase and never flashes a chip.
        publish(
          reduceUpdateState(
            state,
            { type: "checking", automatic: checkOptions?.automatic === true },
            now(),
          ),
        );
      }
      await call();
    } catch (error) {
      publish(
        reduceUpdateState(
          state,
          {
            type: "error",
            message: error instanceof Error ? error.message : String(error),
            context: action,
          },
          now(),
        ),
      );
    } finally {
      busy = false;
      busyAction = null;
    }
    return state;
  };

  const clearProblem = (): UpdateState => {
    if (state.error === null && state.problemKind === null) return state;
    const phase = state.phase === "error" || state.phase === "no-feed" ? "idle" : state.phase;
    publish({
      ...state,
      phase,
      error: null,
      problemKind: null,
      problemAutomatic: false,
    });
    return state;
  };

  return {
    state: () => state,
    check: (checkOptions) => run("check", () => port?.check(), checkOptions),
    download: () => run("download", () => port?.download()),
    install: () => {
      if (!port || state.phase !== "downloaded") return false;
      try {
        port.install();
        return true;
      } catch (error) {
        publish(
          reduceUpdateState(
            state,
            {
              type: "error",
              message: error instanceof Error ? error.message : String(error),
              context: "install" satisfies UpdateErrorContext,
            },
            now(),
          ),
        );
        return false;
      }
    },
    clearProblem,
    dispose: () => {
      disposed = true;
      unsubscribe();
    },
  };
}
