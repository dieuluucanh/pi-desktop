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
        },
        // Renderer tests are not part of a tsconfig project Vite reads, so the
        // automatic JSX runtime is stated here instead of being inferred.
        esbuild: { jsx: "automatic" },
      },
    ],
  },
});
