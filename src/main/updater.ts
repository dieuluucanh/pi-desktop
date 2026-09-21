import {
  initialUpdateState,
  reduceUpdateState,
  type UpdateEvent,
  type UpdateState,
} from "../shared/updates";

/**
 * The update service (plan step 26).
 *
 * Electron-free on purpose: `electron-updater` is injected as an {@link UpdatePort}
 * (`src/main/electron-updater.ts` is the only module that imports it), so the
 * policy — when a check may run, how a progress event maps to the banner, what
 * happens on failure — is unit-tested with a fake port and no network.
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
  /** Whether this build has a feed at all (`app.isPackaged` and not safe mode). */
  supported: boolean;
  /** Injected clock; used by tests to make `checkedAt` deterministic. */
  now?: () => number;
  /** Called on every state change so main can push it to the renderer. */
  onChange?: (state: UpdateState) => void;
}

export interface UpdateService {
  state(): UpdateState;
  /** Starts a check unless one is already running. */
  check(): Promise<UpdateState>;
  /** Downloads the offered update (no-op unless one is available). */
  download(): Promise<UpdateState>;
  /** Quits and installs a downloaded update; false when nothing is ready. */
  install(): boolean;
  dispose(): void;
}

export function createUpdateService(options: CreateUpdateServiceOptions): UpdateService {
  const port = options.supported ? options.port : null;
  const supported = port !== null;
  const now = options.now ?? (() => Date.now());
  let state = initialUpdateState(supported);
  let busy = false;
  let disposed = false;

  const publish = (next: UpdateState): void => {
    state = next;
    if (!disposed) options.onChange?.(state);
  };

  const unsubscribe = port
    ? port.subscribe((event) => {
        publish(reduceUpdateState(state, event, now()));
      })
    : () => undefined;

  /** Runs a port action, mapping a rejection to an `error` event. */
  const run = async (action: "check" | "download", call: () => void | Promise<void>) => {
    if (!port || busy) return state;
    busy = true;
    try {
      // A click is a check in the user's eyes: show it immediately rather than
      // waiting for the feed's first event.
      if (action === "check") publish(reduceUpdateState(state, { type: "checking" }, now()));
      await call();
    } catch (error) {
      publish(
        reduceUpdateState(
          state,
          { type: "error", message: error instanceof Error ? error.message : String(error) },
          now(),
        ),
      );
    } finally {
      busy = false;
    }
    return state;
  };

  return {
    state: () => state,
    check: () => run("check", () => port?.check()),
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
            { type: "error", message: error instanceof Error ? error.message : String(error) },
            now(),
          ),
        );
        return false;
      }
    },
    dispose: () => {
      disposed = true;
      unsubscribe();
    },
  };
}
