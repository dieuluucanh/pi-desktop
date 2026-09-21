import { defineConfig } from "vitest/config";

/**
 * Two test projects (plan step 1):
 *  - `node`    the existing suites: host protocol, session core, main process,
 *              Office backend, packages, runtime — no DOM;
 *  - `renderer` jsdom + Testing Library for the React app.
 *
 * `npm test` runs both. `tests/e2e/**` belongs to Playwright (step 2).
 */
export default defineConfig({
  test: {
    // Coverage spans both projects (`npm run test:coverage`); the thresholds are
    // enforced in plan step 25 and run in CI (`checks.yml`, coverage job).
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/renderer/src/**/*.d.ts",
        "src/renderer/src/main.tsx",
        // Electron-only wiring. It cannot be exercised by a Vitest run (it needs
        // `app`, `BrowserWindow` and a live renderer); the Playwright-Electron
        // E2E suite is its coverage. Excluding it keeps the thresholds a
        // meaningful statement about the unit-testable surface.
        "src/main/index.ts",
        "src/main/ipc.ts",
        "src/main/web-view-host.ts",
        "src/preload/**",
        // The host entry point / composition root: it wires the SDK adapters and
        // the service loop together, so only the live host tests can run it.
        "src/host/index.ts",
      ],
      // A floor just under the current suite, plus tighter floors for the three
      // groups the plan names (host, protocol/shared, renderer utilities).
      // Raising a floor is a deliberate act; falling below one fails `npm run
      // test:coverage` and the CI coverage job.
      thresholds: {
        statements: 75,
        branches: 68,
        functions: 70,
        lines: 78,
        "src/shared/**": { statements: 88, branches: 78, functions: 88, lines: 90 },
        "src/host/**": { statements: 78, branches: 68, functions: 72, lines: 80 },
        "src/renderer/src/**": { statements: 58, branches: 42, functions: 52, lines: 57 },
      },
    },
    projects: [
      {
        test: {
          name: "node",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/renderer/**", "tests/e2e/**", "node_modules/**"],
          environment: "node",
          restoreMocks: true,
        },
      },
      {
        test: {
          name: "renderer",
          include: ["tests/renderer/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          setupFiles: ["tests/renderer/setup.ts"],
          restoreMocks: true,
          // The `userEvent`-driven view tests take several seconds each on a
          // loaded machine; the 5 s default is too tight once the renderer suite
          // runs its files in parallel (the settings raw-editor test is the one
          // that tips over). A real hang still fails, just later.
          testTimeout: 15_000,
        },
        // Renderer tests are not part of a tsconfig project Vite reads, so the
        // automatic JSX runtime is stated here instead of being inferred.
        esbuild: { jsx: "automatic" },
      },
    ],
  },
});
