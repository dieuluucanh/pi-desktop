/**
 * Stopping the dev supervisor's children (2026-11-05 renderer-port plan).
 *
 * `scripts/dev.mjs` spawns npm with `shell: true` on Windows, so the child pid
 * is `cmd.exe`. `child.kill()` stops that shell but not the
 * npm → electron-vite → Vite/Electron descendants, which can keep the renderer
 * dev port held after the dev session ends — the same collision the dedicated
 * port is meant to avoid. `taskkill /T` stops the whole tree instead.
 *
 * On POSIX the console's foreground process group already receives Ctrl+C, so
 * the existing `child.kill()` is kept. The decision is pure and the effects are
 * injected so both paths are unit tested.
 */

import { spawnSync } from "node:child_process";

/**
 * The command that stops `pid` and its descendants, or `null` when the platform
 * should use `child.kill()`.
 *
 * @param {number | undefined} pid
 * @param {string} platform
 * @returns {{ command: string, args: string[] } | null}
 */
export function stopCommand(pid, platform) {
  if (platform !== "win32" || !Number.isInteger(pid) || pid <= 0) return null;
  return { command: "taskkill", args: ["/pid", String(pid), "/T", "/F"] };
}

const defaultDeps = {
  spawnSync: (command, args, options) => spawnSync(command, args, options),
  kill: (child) => child.kill(),
};

/**
 * Stops one spawned child and returns whether a stop was attempted. A child that
 * already exited is left alone; only Windows replaces `child.kill()`.
 *
 * @param {{ pid?: number, exitCode: number | null, killed: boolean } | null | undefined} child
 * @param {string} platform
 * @param {{ spawnSync: Function, kill: Function }} [deps]
 * @returns {boolean}
 */
export function stopChild(child, platform, deps = defaultDeps) {
  if (!child || child.exitCode !== null || child.killed) return false;
  const plan = stopCommand(child.pid, platform);
  if (plan) deps.spawnSync(plan.command, plan.args, { stdio: "ignore", windowsHide: true });
  else deps.kill(child);
  return true;
}
