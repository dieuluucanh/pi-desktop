import { describe, expect, it } from "vitest";
import {
  COALESCE_BYTES,
  COALESCE_MS,
  DEFAULT_LIVE_HOSTS,
  HOST_RSS_BUDGET_BYTES,
  HOST_RSS_RESTART_BYTES,
  LIVE_HOST_RAM_SHARE,
  MAX_HOSTS_HARD_CEILING,
  MAX_LIVE_HOSTS,
  MIN_LIVE_HOSTS,
  SESSION_READY_BUDGET_MS,
  TRANSCRIPT_10K_ITEMS,
  TRANSCRIPT_VIRTUALIZE_THRESHOLD,
  WINDOW_INTERACTIVE_BUDGET_MS,
  capacity,
  checkBudget,
  createStartupMetrics,
  formatBytes,
  formatDuration,
  hostCeilingMessage,
  liveHostBudget,
  shouldRestartForMemory,
  worstBudgetStatus,
  type HostMemoryMetrics,
} from "../../src/shared/performance";

/**
 * The performance guardrail policy (plan step 24): the startup budget, memory
 * thresholds and the shared formatting the Diagnostics view and E2E perf test
 * rely on. Pure — no clock, no process.
 */

describe("budgets", () => {
  it("documents the startup budget the plan commits to", () => {
    expect(WINDOW_INTERACTIVE_BUDGET_MS).toBe(2_500);
    expect(SESSION_READY_BUDGET_MS).toBe(5_000);
    expect(HOST_RSS_RESTART_BYTES).toBeGreaterThan(HOST_RSS_BUDGET_BYTES);
    expect(TRANSCRIPT_10K_ITEMS).toBe(10_000);
    expect(TRANSCRIPT_VIRTUALIZE_THRESHOLD).toBeLessThan(TRANSCRIPT_10K_ITEMS);
  });

  it("classifies a measurement against its budget", () => {
    expect(checkBudget(0, 100)).toBe("met");
    expect(checkBudget(100, 100)).toBe("met");
    expect(checkBudget(101, 100)).toBe("over");
    expect(checkBudget(null, 100)).toBe("unknown");
    expect(checkBudget(undefined, 100)).toBe("unknown");
    expect(checkBudget(Number.NaN, 100)).toBe("unknown");
  });

  it("takes the worst status across checks, over beatings unknown", () => {
    expect(worstBudgetStatus(["met", "met"])).toBe("met");
    expect(worstBudgetStatus(["met", "unknown"])).toBe("unknown");
    expect(worstBudgetStatus(["unknown", "over", "met"])).toBe("over");
    expect(worstBudgetStatus([])).toBe("met");
  });
});

describe("formatting", () => {
  it("formats durations the way a diagnostics reader expects", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(820)).toBe("820 ms");
    expect(formatDuration(1_420)).toBe("1.4 s");
    expect(formatDuration(5_000)).toBe("5.0 s");
  });

  it("formats bytes across units", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1_024)).toBe("1 KB");
    expect(formatBytes(HOST_RSS_BUDGET_BYTES)).toBe("512 MB");
    expect(formatBytes(HOST_RSS_RESTART_BYTES)).toBe("1.5 GB");
  });
});

describe("createStartupMetrics", () => {
  it("reports an unknown status before any mark", () => {
    const metrics = createStartupMetrics({ startedAt: 1_000 });
    const report = metrics.report();
    expect(report.windowInteractiveMs).toBeNull();
    expect(report.windowInteractive.status).toBe("unknown");
    expect(report.sessionReady.status).toBe("unknown");
    expect(report.status).toBe("unknown");
  });

  it("measures from process start and marks both budgets met", () => {
    const metrics = createStartupMetrics({ startedAt: 1_000 });
    metrics.markAppReady(1_200);
    metrics.markWindowInteractive(1_800);
    metrics.markSessionReady(4_000, true);

    const report = metrics.report();
    expect(report.appReadyMs).toBe(200);
    expect(report.windowInteractiveMs).toBe(800);
    expect(report.sessionReadyMs).toBe(3_000);
    expect(report.sessionWarm).toBe(true);
    expect(report.windowInteractive.status).toBe("met");
    expect(report.sessionReady.status).toBe("met");
    expect(report.status).toBe("met");
  });

  it("reports over-budget measurements as over", () => {
    const metrics = createStartupMetrics({ startedAt: 1_000 });
    metrics.markWindowInteractive(1_000 + WINDOW_INTERACTIVE_BUDGET_MS + 1);
    metrics.markSessionReady(1_000 + SESSION_READY_BUDGET_MS + 1);
    const report = metrics.report();
    expect(report.windowInteractive.status).toBe("over");
    expect(report.sessionReady.status).toBe("over");
    expect(report.status).toBe("over");
  });

  it("keeps only the first session-ready mark, so a second tab is not startup", () => {
    const metrics = createStartupMetrics({ startedAt: 1_000 });
    metrics.markSessionReady(2_000, true);
    metrics.markSessionReady(9_000, false);
    const report = metrics.report();
    expect(report.sessionReadyMs).toBe(1_000);
    expect(report.sessionWarm).toBe(true);
  });
});

describe("memory thresholds", () => {
  const sample = (rssBytes: number): HostMemoryMetrics => ({
    rssBytes,
    heapUsedBytes: 1_024,
    heapTotalBytes: 2_048,
    uptimeMs: 10,
    at: 5,
  });

  it("flags a sample at or above the restart threshold", () => {
    expect(shouldRestartForMemory(null)).toBe(false);
    expect(shouldRestartForMemory(sample(HOST_RSS_BUDGET_BYTES))).toBe(false);
    expect(shouldRestartForMemory(sample(HOST_RSS_RESTART_BYTES))).toBe(true);
    expect(shouldRestartForMemory(sample(HOST_RSS_RESTART_BYTES + 1))).toBe(true);
  });
});

describe("live-host budget", () => {
  const gib = 1024 ** 3;

  it("derives a soft target from total physical memory", () => {
    expect(LIVE_HOST_RAM_SHARE).toBe(0.4);
    expect(liveHostBudget(8 * gib)).toBe(6);
    expect(liveHostBudget(16 * gib)).toBe(12);
    expect(liveHostBudget(32 * gib)).toBe(25);
  });

  it("clamps small and huge machines to a sane range", () => {
    expect(liveHostBudget(1 * gib)).toBe(MIN_LIVE_HOSTS);
    expect(liveHostBudget(64 * gib)).toBe(MAX_LIVE_HOSTS);
    expect(MAX_HOSTS_HARD_CEILING).toBeGreaterThan(MAX_LIVE_HOSTS);
  });

  it("falls back to the default when the OS reading is unusable", () => {
    expect(liveHostBudget()).toBe(DEFAULT_LIVE_HOSTS);
    expect(liveHostBudget(null)).toBe(DEFAULT_LIVE_HOSTS);
    expect(liveHostBudget(0)).toBe(DEFAULT_LIVE_HOSTS);
    expect(liveHostBudget(-1)).toBe(DEFAULT_LIVE_HOSTS);
    expect(liveHostBudget(Number.NaN)).toBe(DEFAULT_LIVE_HOSTS);
  });

  it("names the emergency ceiling without inventing a session limit", () => {
    const message = hostCeilingMessage(64);
    expect(message).toContain("emergency ceiling of 64 host processes");
    expect(message).not.toMatch(/session tabs|close a tab/i);
  });
});

describe("capacity", () => {
  it("reports when a hard ceiling is reached", () => {
    expect(capacity(2, 8)).toEqual({ used: 2, limit: 8, atCapacity: false });
    expect(capacity(8, 8).atCapacity).toBe(true);
    expect(capacity(9, 8).atCapacity).toBe(true);
  });
});

describe("coalescing defaults", () => {
  it("keeps a small window and byte budget so a delta storm cannot grow unbounded", () => {
    expect(COALESCE_MS).toBe(33);
    expect(COALESCE_BYTES).toBe(1_024);
  });
});
