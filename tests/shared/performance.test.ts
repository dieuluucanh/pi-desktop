import { describe, expect, it } from "vitest";
import {
  COALESCE_BYTES,
  COALESCE_MS,
  HOST_RSS_BUDGET_BYTES,
  HOST_RSS_RESTART_BYTES,
  SESSION_READY_BUDGET_MS,
  TRANSCRIPT_10K_ITEMS,
  TRANSCRIPT_VIRTUALIZE_THRESHOLD,
  WINDOW_INTERACTIVE_BUDGET_MS,
  capacity,
  capacityMessage,
  checkBudget,
  createStartupMetrics,
  formatBytes,
  formatDuration,
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

describe("capacity", () => {
  it("reports when the cap is reached", () => {
    expect(capacity(2, 8)).toEqual({ used: 2, limit: 8, atCapacity: false });
    expect(capacity(8, 8).atCapacity).toBe(true);
    expect(capacity(9, 8).atCapacity).toBe(true);
  });

  it("has one user-facing sentence per limit", () => {
    expect(capacityMessage("hosts", 8)).toContain("at most 8 host processes");
    expect(capacityMessage("tabs", 8)).toContain("at most 8 session tabs");
  });
});

describe("coalescing defaults", () => {
  it("keeps a small window and byte budget so a delta storm cannot grow unbounded", () => {
    expect(COALESCE_MS).toBe(33);
    expect(COALESCE_BYTES).toBe(1_024);
  });
});
