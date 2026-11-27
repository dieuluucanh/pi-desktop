#!/usr/bin/env node
/**
 * Fast native terminal check (2026-11-08 linux-terminal plan, step 7).
 *
 * `npm ci` can leave `node-pty` without a native binary in two silent ways:
 * npm 12+ blocks dependency install scripts unless `allowScripts` approves them
 * (including implicit `node-gyp` builds), and a platform without a prebuild
 * simply has nothing to load. On Windows/macOS the prebuild hides the first;
 * on Linux it surfaces as "the terminal host exited (1)" at first use.
 *
 * This runs in CI right after install on every OS so the failure is a red job
 * with the loader error, not a release artifact that cannot open a PTY.
 *
 *   node scripts/check-native-terminal.mjs
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const target = `${process.platform}-${process.arch}`;

try {
  const pty = require("node-pty");
  if (typeof pty?.spawn !== "function") {
    throw new Error("node-pty did not export spawn()");
  }
  const moduleDir = dirname(dirname(require.resolve("node-pty")));
  const candidates = [
    join(moduleDir, "build", "Release", "pty.node"),
    join(moduleDir, "build", "Debug", "pty.node"),
    join(moduleDir, "prebuilds", target, "pty.node"),
  ];
  const present = candidates.filter((candidate) => existsSync(candidate));
  const version =
    JSON.parse(require("node:fs").readFileSync(join(moduleDir, "package.json"), "utf8")).version ??
    "?";
  process.stdout.write(`check:terminal: node-pty ${version} loaded on ${target}\n`);
  process.stdout.write(
    `  ${present.length > 0 ? present.join(", ") : "(no native file found; loaded from elsewhere)"}\n`,
  );
} catch (error) {
  process.stderr.write(
    `check:terminal: node-pty failed on ${target}: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.stderr.write(
    "  Run `npm ci`; on npm 12+ approve node-pty in package.json `allowScripts`. " +
      "On Linux the release build is `npm run pty:linux`.\n",
  );
  process.exit(1);
}
