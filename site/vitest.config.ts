import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", ".astro/**"],
    environment: "node",
    restoreMocks: true,
    testTimeout: 30_000,
  },
});
