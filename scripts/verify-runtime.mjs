#!/usr/bin/env node
/**
 * `npm run runtime:verify` — the step-2 acceptance check.
 *
 * Runs the live runtime suite with `PI_DESKTOP_REQUIRE_RUNTIME=1`, which turns a
 * missing bundled runtime or a missing host bundle into a hard failure (in the
 * normal `npm test` run those suites skip instead, so CI without a fetched
 * runtime stays green).
 *
 *   npm run runtime:verify
 */

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitest = join(repoRoot, "node_modules", "vitest", "vitest.mjs");

const result = spawnSync(
  process.execPath,
  [vitest, "run", "tests/runtime/runtime.live.test.ts", "--disable-console-intercept"],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, PI_DESKTOP_REQUIRE_RUNTIME: "1" },
  },
);

process.exit(result.status ?? 1);
