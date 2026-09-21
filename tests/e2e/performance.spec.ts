import { expect, test } from "@playwright/test";
import { launchApp, removeTempDirs, type LaunchedApp } from "./fixtures/app";

/**
 * The startup budget is measured on every CI run (plan step 24).
 *
 * This is the *app's own* clock — from main module load to the window's first
 * `ready-to-show` — not the whole Electron/Playwright launch, so the number is
 * the app's work and not the harness's. Diagnostics exposes it, which is also
 * what a bug report shows.
 */

interface StartupReportView {
  windowInteractiveMs: number | null;
  sessionReadyMs: number | null;
  windowInteractive: { budgetMs: number; status: string };
  sessionReady: { budgetMs: number; status: string };
}

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  if (!launched) return;
  await launched.close();
  removeTempDirs(launched.paths);
  launched = undefined;
});

async function startupReport(app: LaunchedApp): Promise<StartupReportView> {
  return app.window.evaluate(async () => {
    const bridge = (window as unknown as { pi: { diagnostics: { get(): Promise<unknown> } } }).pi;
    const snapshot = (await bridge.diagnostics.get()) as { startup: StartupReportView };
    return snapshot.startup;
  });
}

test("@perf the window reaches interactive within the startup budget", async () => {
  launched = await launchApp();
  const app = launched;

  // The mark lands on `ready-to-show`; wait for it before reading (the page can
  // finish loading a moment before the window is painted).
  await expect
    .poll(async () => (await startupReport(app)).windowInteractiveMs, { timeout: 15_000 })
    .not.toBeNull();

  const report = await startupReport(app);
  expect(report.windowInteractiveMs).toBeGreaterThan(0);
  // The plan's hard budget: 2.5 s from process start to an interactive window.
  expect(report.windowInteractive.budgetMs).toBe(2_500);
  expect(report.windowInteractive.status).toBe("met");
});

test("@perf reports the warm-session budget (met when a tab is restored)", async () => {
  // No tabs are seeded, so `prewarmLast` has nothing to warm and the session
  // mark stays unset. The measurement must stay honest rather than fabricate it.
  launched = await launchApp();
  const report = await startupReport(launched);
  expect(report.sessionReady.status).toBe("unknown");
  expect(report.sessionReadyMs).toBeNull();
});
