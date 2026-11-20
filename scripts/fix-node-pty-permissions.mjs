/**
 * Makes node-pty's POSIX `spawn-helper` executable after install.
 *
 * `node-pty@1.1.0` publishes `prebuilds/darwin-<arch>/spawn-helper` with mode
 * 0644 in the npm tarball. The installer accepts the prebuild, so `node-gyp`
 * never runs and the helper stays non-executable; macOS then fails `pty.fork`
 * with the opaque `posix_spawnp failed`, which is what broke the macOS
 * terminal-host integration test. `afterPack` already re-applies this mode to
 * the packaged copy; this script covers `npm ci`/`npm install` for dev and CI.
 *
 * Invoked as `node scripts/…` from the package `postinstall`; safe to run
 * repeatedly and a no-op on Windows.
 */

import { chmodSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = join(fileURLToPath(new URL("..", import.meta.url)), "node_modules", "node-pty");
const EXECUTABLE = 0o755;

/** The helper locations node-pty uses: the prebuild and a source build. */
export function nodePtyHelperCandidates(root = PACKAGE_DIR) {
  return [
    join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    join(root, "build", "Release", "spawn-helper"),
  ];
}

/**
 * chmods every existing candidate. Dependencies are injectable so the test can
 * prove the selection without touching a real filesystem mode.
 */
export function ensureExecutable(paths, chmod = chmodSync, exists = existsSync) {
  const changed = [];
  for (const path of paths) {
    if (!exists(path)) continue;
    chmod(path, EXECUTABLE);
    changed.push(path);
  }
  return changed;
}

function main() {
  // The helper only exists on POSIX; Windows uses ConPTY/winpty.
  if (process.platform === "win32") return;
  const changed = ensureExecutable(nodePtyHelperCandidates());
  if (changed.length > 0) {
    process.stdout.write(`node-pty: made executable ${changed.join(", ")}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
