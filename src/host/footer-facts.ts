/**
 * Live `FooterDataProvider` facts for an extension `ctx.ui.setFooter()` factory
 * (2026-11-22 Workflow parity row 28).
 *
 * Pi hands a custom footer the real `ReadonlyFooterDataProvider`: the git branch
 * (with a watcher) and the number of providers with available models. The
 * desktop's adapter used to return `null`/`0` because the host has no branch
 * watcher of its own, so a footer written for terminal Pi rendered an empty
 * branch column. This module supplies the same facts from injected ports:
 *
 * - git is probed through `FooterFactsIo` (no `node:child_process` here), and
 *   polled only while something is subscribed — a footer that nobody renders
 *   costs nothing;
 * - the provider count is a callback owned by the caller (the session's model
 *   runtime), read at call time so it never goes stale;
 * - `onBranchChange` fires on a real change (a full scan of the same branch is
 *   silent), so a footer component can re-render without a timer of its own.
 *
 * Pure and unit-tested with an in-memory git port; the composition root wires
 * `createNodeProjectIo()` and the live session.
 */

export interface FooterFactsIo {
  /** Runs `git` in `root` and returns stdout, or null when the command fails. */
  runGit(root: string, args: readonly string[]): Promise<string | null>;
}

export interface FooterFactsOptions {
  cwd: string;
  io: FooterFactsIo;
  /** Number of providers with available models, read at call time. */
  availableProviderCount: () => number;
  /** Branch poll interval while a footer is subscribed. Defaults to 15s. */
  pollMs?: number;
  /** Injected for tests; defaults to an unref'd `setInterval`. */
  startTimer?: (callback: () => void, ms: number) => unknown;
  stopTimer?: (handle: unknown) => void;
}

export interface FooterFacts {
  gitBranch(): string | null;
  availableProviderCount(): number;
  onBranchChange(listener: () => void): () => void;
  /** One explicit probe (also runs on the first subscription). */
  refresh(): Promise<void>;
  /** Stops polling and drops listeners. Safe to call more than once. */
  dispose(): void;
}

const DEFAULT_POLL_MS = 15_000;

function defaultStartTimer(callback: () => void, ms: number): unknown {
  const timer = setInterval(callback, ms);
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref(): void }).unref();
  }
  return timer;
}

function defaultStopTimer(handle: unknown): void {
  clearInterval(handle as ReturnType<typeof setInterval>);
}

export function createFooterFacts(options: FooterFactsOptions): FooterFacts {
  const listeners = new Set<() => void>();
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const startTimer = options.startTimer ?? defaultStartTimer;
  const stopTimer = options.stopTimer ?? defaultStopTimer;
  let branch: string | null = null;
  let loaded = false;
  let disposed = false;
  let inFlight: Promise<void> | null = null;
  let timer: unknown = null;

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A broken footer must never break the host or another footer.
      }
    }
  };

  const settle = (next: string | null): void => {
    const changed = next !== branch;
    branch = next;
    if (!loaded || changed) {
      loaded = true;
      notify();
    }
  };

  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = options.io
      .runGit(options.cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
      .then((output) => {
        const trimmed = output?.trim() ?? "";
        settle(trimmed.length > 0 ? trimmed : null);
      })
      .catch(() => settle(null))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const stopPolling = (): void => {
    if (timer === null) return;
    stopTimer(timer);
    timer = null;
  };

  return {
    gitBranch: () => branch,
    availableProviderCount: () => options.availableProviderCount(),

    onBranchChange(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      if (timer === null) {
        void refresh();
        timer = startTimer(() => void refresh(), pollMs);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stopPolling();
      };
    },

    refresh,

    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      stopPolling();
    },
  };
}
