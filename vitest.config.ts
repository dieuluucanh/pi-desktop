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
    // Coverage spans both projects (`npm run test:coverage`); thresholds are
    // enforced in plan step 25.
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/renderer/src/**/*.d.ts", "src/renderer/src/main.tsx"],
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
