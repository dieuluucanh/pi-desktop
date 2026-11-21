/**
 * SDK-side binding for the generic contribution registry (step 8).
 *
 * The registry is SDK-free; this adapter connects it to the shared extension
 * event bus that Pi puts behind `pi.events`. The composition root supplies the
 * bus (the same instance a `DefaultResourceLoader({ eventBus })` uses), so an
 * out-of-process child would need its own bridge rather than a global marker.
 *
 * Lifecycle: call `announce()` when a session binds (and after a rebind), and
 * `dispose()` on teardown. `announce()` is what makes extensions publish —
 * without it they deliberately fall back to statuses/widgets.
 */

import type { ContributionHost } from "../contributions";
import { CONTRIBUTION_EVENTS } from "../contributions";

/** Structural `EventBus` (Pi's `createEventBus()` result). */
export interface ContributionBus {
  on(channel: string, handler: (payload: unknown) => unknown): () => void;
  emit(channel: string, payload?: unknown): void;
}

export interface ContributionBridge {
  /** Broadcast host support; extensions answer by publishing their set. */
  announce(): void;
  /** Stop listening (session teardown / rebind). */
  dispose(): void;
}

export interface ContributionBridgeOptions {
  host: ContributionHost;
  bus: ContributionBus | null | undefined;
  /** Reports a throwing bus listener; never throws itself. */
  onError?: (error: unknown) => void;
}

export function createSdkContributionBridge(options: ContributionBridgeOptions): ContributionBridge {
  const offs: Array<() => void> = [];
  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      /* diagnostics must never break the bridge */
    }
  };

  if (options.bus) {
    try {
      offs.push(
        options.bus.on(CONTRIBUTION_EVENTS.update, (payload) => {
          try {
            options.host.receive(payload);
          } catch (error) {
            report(error);
          }
          return undefined;
        }),
      );
      offs.push(
        options.bus.on(CONTRIBUTION_EVENTS.probe, () => {
          try {
            options.bus?.emit(CONTRIBUTION_EVENTS.hello, options.host.hello());
          } catch (error) {
            report(error);
          }
          return undefined;
        }),
      );
    } catch (error) {
      // A host without a working bus simply never receives contributions; the
      // renderer keeps whatever generic statuses/widgets the extension pushed.
      report(error);
    }
  }

  return {
    announce() {
      if (!options.bus) return;
      try {
        options.bus.emit(CONTRIBUTION_EVENTS.hello, options.host.hello());
      } catch (error) {
        report(error);
      }
    },
    dispose() {
      for (const off of offs.splice(0)) {
        try {
          off();
        } catch (error) {
          report(error);
        }
      }
    },
  };
}
