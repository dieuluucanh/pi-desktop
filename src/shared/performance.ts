/**
 * Performance and resource guardrails (plan step 24).
 *
 * One pure module owns the numbers the app measures itself against: the startup
 * budget, the per-host memory budget and restart threshold, the streaming-delta
 * coalescing window, the live-host target and the process ceiling. Main, the
 * host and the renderer all read the same constants, so a budget change is one
 * edit and the Diagnostics view can label a measurement instead of guessing at
 * it.
 *
 * A tab is a resumable record; it does not reserve a process. The live-host
 * target below is the only resource budget: it is soft (parking idle sessions
 * first) and derived from total physical memory, so a session count can never
 * block the user. The process ceiling is the emergency backstop for the
 * all-busy case, and it is derived from the same memory reading.
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
/** Hard per-host RSS threshold: an *idle, unpinned* host over this is recycled. */
export const HOST_RSS_RESTART_BYTES = 1024 * 1024 * 1024;
/**
 * A host must stay over the RSS threshold for this many consecutive samples
 * before it is eligible for a background recycle. One 15 s spike is not a leak,
 * and a cold session spends its first seconds loading extensions/LSP caches.
 */
export const HOST_RSS_OVER_BUDGET_SAMPLES = 2;
/** Do not even consider an RSS recycle during the host's first minute. */
export const HOST_MEMORY_GRACE_MS = 60_000;
/**
 * Fallback live-host target when the OS total-memory reading is unavailable.
 * A target is soft: idle sessions sleep before a new host is spawned, and a
 * new session still opens when every live session is busy.
 */
export const DEFAULT_LIVE_HOSTS = 4;
/** Never target fewer live hosts than this, even on a small machine. */
export const MIN_LIVE_HOSTS = 2;
/** Never target more live hosts than this, even on a huge machine. */
export const MAX_LIVE_HOSTS = 8;
/**
 * Share of total physical memory reserved for Pi host processes. The remaining
 * 80 % belongs to Electron, Vite, VS Code, the terminal Pi and the OS; the
 * previous 40 % assumed a 512 MB host that real sessions routinely exceed.
 */
export const LIVE_HOST_RAM_SHARE = 0.2;
/**
 * Extra processes allowed beyond the soft target when every live session is
 * busy (the target never blocks a new session on its own).
 */
export const HOST_PROCESS_HEADROOM = 2;
/** Absolute upper bound for the memory-derived process ceiling. */
export const MAX_HOST_PROCESSES = 10;
/**
 * Aggregate RSS share across all live hosts. When the last metrics samples add
 * up past this, main parks idle hosts even if the live count is under target.
 */
export const HOST_RSS_TOTAL_SHARE = 0.5;
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

/** `512 MB`, `1 GB`, `—` when the value is unknown. */
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
  /**
   * Memory held outside the V8 heap (native/WASM/typed arrays). Optional so a
   * legacy host or a small test double still satisfies the shape; the current
   * host reports it to explain a large RSS on a brand-new session.
   */
  externalBytes?: number;
  arrayBuffersBytes?: number;
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

/**
 * The number of live host processes the app aims for on this machine.
 *
 * Total memory, not free memory: the value must be stable for the life of the
 * app (a probe is not a budget that moves every second). The result is clamped
 * to a small floor so a modest machine still multitasks and a high ceiling so a
 * very large workstation does not spawn dozens of processes by default.
 */
export function liveHostBudget(totalMemoryBytes?: number | null): number {
  if (
    totalMemoryBytes === null ||
    totalMemoryBytes === undefined ||
    !Number.isFinite(totalMemoryBytes) ||
    totalMemoryBytes <= 0
  ) {
    return DEFAULT_LIVE_HOSTS;
  }
  const byMemory = Math.floor((totalMemoryBytes * LIVE_HOST_RAM_SHARE) / HOST_RSS_BUDGET_BYTES);
  return Math.min(MAX_LIVE_HOSTS, Math.max(MIN_LIVE_HOSTS, byMemory));
}

/** The memory-derived host-process ceiling: target + headroom, clamped. */
export function hostProcessCeiling(totalMemoryBytes?: number | null): number {
  return Math.min(
    MAX_HOST_PROCESSES,
    Math.max(MIN_LIVE_HOSTS, liveHostBudget(totalMemoryBytes) + HOST_PROCESS_HEADROOM),
  );
}

/** The ceiling sentence; never presented as a session limit. */
export function hostCeilingMessage(limit: number): string {
  return `Pi Desktop reached its memory-derived ceiling of ${limit} host processes. Wait for a running session to finish or close a session that is no longer running.`;
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

/** A used/limit pair for the memory-derived host-process ceiling. */
export interface Capacity {
  used: number;
  limit: number;
  atCapacity: boolean;
}

/**
 * The session service's user-facing capacity readout. `targetHosts` is a soft
 * budget, not a cap: `overTarget` means every live session was busy, so a new
 * one started past the target instead of being rejected.
 */
export interface SessionCapacity {
  /** Live host processes, including the control host. */
  liveHosts: number;
  /** RAM-derived soft target for live host processes. */
  targetHosts: number;
  /** Memory-derived hard process ceiling for the all-busy case. */
  ceilingHosts: number;
  /** True when `liveHosts > targetHosts` (all parkable sessions were busy). */
  overTarget: boolean;
  /** Sum of the last `host.metrics()` RSS samples across live hosts. */
  hostRssBytes: number;
  /** Aggregate host RSS budget; 0 disables the guard. */
  hostRssLimitBytes: number;
  /** True when `hostRssBytes > hostRssLimitBytes`. */
  overMemory: boolean;
  /** Session and Office tabs that are open, including asleep ones. */
  openSessions: number;
  /** Host-backed tabs whose process is parked. */
  asleepSessions: number;
  /** Open editor tabs; they hold no host. */
  editorTabs: number;
  /**
   * Tabs the renderer shows in a grid pane or the solo view (2026-11-03 grid
   * plan). They are pinned against idle/LRU parking, so Diagnostics can explain
   * why a small machine sits above its target with every session awake.
   */
  visibleSessions: number;
}

export function capacity(used: number, limit: number): Capacity {
  return { used, limit, atCapacity: used >= limit };
}
