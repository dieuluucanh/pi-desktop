import { defineConfig } from "@playwright/test";

/**
 * Screenshot harness configuration. It is deliberately separate from
 * `playwright.config.ts` so `npm run test:e2e` never launches a capture run and
 * CI does not depend on a windowing environment for marketing assets.
 */
export default defineConfig({
  testDir: "tests/screenshots",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  outputDir: "test-results/site-screenshots-artifacts",
});
