import { defineConfig } from "@playwright/test";

/**
 * Playwright config (plan step 2).
 *
 * The only "browser" is the app itself: tests launch Electron through
 * `tests/e2e/fixtures/app.ts`, so there are no browser projects and no
 * `webServer`. `workers: 1` keeps the single-instance app lock and the shared
 * `out/` build unambiguous, and artifacts are kept only on failure.
 *
 * The Windows runner is the slowest target: a cold Electron start plus the
 * single-instance handshake can take well over the old 60 s test budget, and a
 * slow renderer used to surface as a click timeout rather than a product
 * failure. The wider timeouts and the single CI retry absorb that variance;
 * assertions stay strict. (`actionTimeout` only covers Playwright-launched
 * browsers, so `tests/e2e/fixtures/app.ts` also lifts the default timeout on
 * the Electron page itself.)
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    actionTimeout: 60_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  outputDir: "test-results",
});
