/**
 * Performance and resource guardrails (plan step 24).
 *
 * One pure module owns the numbers the app measures itself against: the startup
 * budget, the per-host memory budget and restart threshold, the streaming-delta
 * coalescing window, and the host/tab caps. Main, the host and the renderer all
 * read the same constants, so a budget change is one edit and the Diagnostics
 * view can label a measurement instead of guessing at it.
 *
 * Nothing here imports Electron or Node: it is shared by the main process, the
 * host process and the renderer, and is unit tested without any of them.
 */

/** Window interactive ceiling: process start → `ready-to-show` (plan step 24). */
export const WINDOW_INTERACTIVE_BUDGET_MS = 2_500;
/** Warm session ceiling: process start → the restored tab's first ready. */
export const SESSION_READY_BUDGET_MS = 5_000;
/** Soft per-host RSS budget the Diagnostics view colours against. */
export const HOST_RSS_BUDGET_BYTES = 512 * 1024 * 1024;
/** Hard per-host RSS threshold: an *idle* host over this is recycled. */
export const HOST_RSS_RESTART_BYTES = 1_536 * 1024 * 1024;
/** Hosts kept running at once (the supervisor cap, plan step 3). */
export const MAX_HOSTS = 8;
/** Open tabs (the session service cap, plan step 3). */
export const MAX_TABS = 8;
/** Editor tabs have no host, so they get their own, larger cap. */
export const MAX_EDITOR_TABS = 16;
/** How long a host with no traffic is kept before it is recycled. */
export const IDLE_HOST_TIMEOUT_MS = 15 * 60_000;
/** Streaming-delta batching window (plan step 3; tuned in plan step 24). */
export const COALESCE_MS = 33;
/** Flush a delta batch early once it grows past this many bytes. */
export const COALESCE_BYTES = 1_024;
/**
 * Below this many transcript items the list renders plainly; at or above it the
 * row virtualizer takes over. The 10k-item acceptance path exercises this.
 */
export const TRANSCRIPT_VIRTUALIZE_THRESHOLD = 50;
/** The size of the transcript the virtualization acceptance test renders. */
export const TRANSCRIPT_10K_ITEMS = 10_000;

export type BudgetStatus = "met" | "over" | "unknown";

export interface BudgetCheck {
  /** What was measured, for the Diagnostics label. */
  label: string;
  budgetMs: number;
  /** null when the mark never happened (e.g. still starting). */
  actualMs: number | null;
  status: BudgetStatus;
}

/** Classifies a measured duration against its budget (`null` = not reached yet). */
export function checkBudget(actualMs: number | null | undefined, budgetMs: number): BudgetStatus {
  if (actualMs === null || actualMs === undefined || !Number.isFinite(actualMs)) return "unknown";
  return actualMs <= budgetMs ? "met" : "over";
}

/** The worst status across a set of checks: over beats unknown beats met. */
export function worstBudgetStatus(statuses: readonly BudgetStatus[]): BudgetStatus {
  if (statuses.includes("over")) return "over";
  if (statuses.includes("unknown")) return "unknown";
  return "met";
}

/** `1.4 s`, `820 ms`, `—` when the value is unknown. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  return `${(ms / 1_000).toFixed(1)} s`;
}

/** `512 MB`, `1.5 GB`, `—` when the value is unknown. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes < 1_024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1_024;
  let unit = 0;
  while (value >= 1_024 && unit < units.length - 1) {
    value /= 1_024;
    unit += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/** A host's last measured memory, as `host.metrics` reports it. */
export interface HostMemoryMetrics {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  /** Wall-clock ms the host process has been alive. */
  uptimeMs: number;
  /** When the sample was taken (epoch ms, host clock). */
  at: number;
}

/** True when a sample is over the hard restart threshold. */
export function shouldRestartForMemory(
  memory: HostMemoryMetrics | null | undefined,
  thresholdBytes: number = HOST_RSS_RESTART_BYTES,
): boolean {
  return memory !== null && memory !== undefined && memory.rssBytes >= thresholdBytes;
}

/** The plain startup report the Diagnostics view and the E2E perf test read. */
export interface StartupReport {
  startedAt: number;
  appReadyAt: number | null;
  windowInteractiveAt: number | null;
  sessionReadyAt: number | null;
  /** Whether the measured session was a warm (pre-warmed) restore. */
  sessionWarm: boolean;
  appReadyMs: number | null;
  windowInteractiveMs: number | null;
  sessionReadyMs: number | null;
  windowInteractive: BudgetCheck;
  sessionReady: BudgetCheck;
  status: BudgetStatus;
}

export interface StartupMetrics {
  /** Marks the moment `app.whenReady()` resolved. */
  markAppReady(at?: number): void;
  /** Marks the moment the window could paint (`ready-to-show`). */
  markWindowInteractive(at?: number): void;
  /** Marks the moment a session host was first ready. */
  markSessionReady(at?: number, warm?: boolean): void;
  /** A serialisable report for Diagnostics; safe to call at any time. */
  report(): StartupReport;
}

/**
 * Tracks how long startup takes. Times are epoch milliseconds so the report can
 * travel over IPC unchanged; durations are derived from `startedAt`.
 */
export function createStartupMetrics(options: { startedAt?: number } = {}): StartupMetrics {
  const startedAt = options.startedAt ?? Date.now();
  let appReadyAt: number | null = null;
  let windowInteractiveAt: number | null = null;
  let sessionReadyAt: number | null = null;
  let sessionWarm = false;

  const since = (at: number | null): number | null => (at === null ? null : at - startedAt);

  const report = (): StartupReport => {
    const windowInteractiveMs = since(windowInteractiveAt);
    const sessionReadyMs = since(sessionReadyAt);
    const windowInteractive: BudgetCheck = {
      label: "Window interactive",
      budgetMs: WINDOW_INTERACTIVE_BUDGET_MS,
      actualMs: windowInteractiveMs,
      status: checkBudget(windowInteractiveMs, WINDOW_INTERACTIVE_BUDGET_MS),
    };
    const sessionReady: BudgetCheck = {
      label: "Warm session ready",
      budgetMs: SESSION_READY_BUDGET_MS,
      actualMs: sessionReadyMs,
      status: checkBudget(sessionReadyMs, SESSION_READY_BUDGET_MS),
    };
    return {
      startedAt,
      appReadyAt,
      windowInteractiveAt,
      sessionReadyAt,
      sessionWarm,
      appReadyMs: since(appReadyAt),
      windowInteractiveMs,
      sessionReadyMs,
      windowInteractive,
      sessionReady,
      status: worstBudgetStatus([windowInteractive.status, sessionReady.status]),
    };
  };

  return {
    markAppReady(at = Date.now()) {
      appReadyAt = at;
    },
    markWindowInteractive(at = Date.now()) {
      windowInteractiveAt = at;
    },
    markSessionReady(at = Date.now(), warm = true) {
      // Only the first ready session is the startup measurement; later tabs are
      // not startup.
      if (sessionReadyAt !== null) return;
      sessionReadyAt = at;
      sessionWarm = warm;
    },
    report,
  };
}

/** A used/limit pair plus the single phrase that names the limit, for the UI. */
export interface Capacity {
  used: number;
  limit: number;
  atCapacity: boolean;
}

export function capacity(used: number, limit: number): Capacity {
  return { used, limit, atCapacity: used >= limit };
}

/**
 * The user-facing backpressure sentence. One wording, so the tab strip, the
 * create-session error and Diagnostics never disagree about what happened.
 */
export function capacityMessage(kind: "hosts" | "tabs" | "editors", limit: number): string {
  if (kind === "hosts") {
    return `Pi Desktop keeps at most ${limit} host processes running at once. Close a session tab to make room.`;
  }
  if (kind === "editors") {
    return `Pi Desktop keeps at most ${limit} editor tabs open at once. Close a file tab to open another.`;
  }
  return `Pi Desktop keeps at most ${limit} session tabs open at once. Close a tab to open another.`;
}
