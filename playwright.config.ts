import { defineConfig } from "@playwright/test";

/**
 * Playwright config (plan step 2).
 *
 * The only "browser" is the app itself: tests launch Electron through
 * `tests/e2e/fixtures/app.ts`, so there are no browser projects and no
 * `webServer`. `workers: 1` keeps the single-instance app lock and the shared
 * `out/` build unambiguous, and artifacts are kept only on failure.
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  outputDir: "test-results",
});
