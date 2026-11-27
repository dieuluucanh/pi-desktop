/**
 * Development supervisor (2026-10-24 stale-host plan).
 *
 * `vite.host.config.ts` is a separate build from electron-vite's main/preload/
 * renderer targets. Running it once at startup left `out/host/index.mjs` stale
 * while the app stayed up, so the renderer was hot-reloaded but the long-lived
 * host kept executing old code. This runner keeps the host bundle on a watch
 * build and starts electron-vite beside it; the app then sees the new build id
 * and recycles an idle host before the next request.
 *
 * electron-vite is started with `--watch` too (see `dev:electron`): a change to
 * a shared protocol module imported by main must rebuild main and restart
 * Electron, otherwise the renderer can be current while main still rejects a
 * newly added host method. The host watch and the main watch are both required.
 */

import { spawn } from "node:child_process";
import { stopChild } from "./dev-stop.mjs";

const isWindows = process.platform === "win32";
const npm = isWindows ? "npm.cmd" : "npm";

const children = [
  spawn(npm, ["run", "dev:host"], { stdio: "inherit", shell: isWindows }),
  spawn(npm, ["run", "dev:electron"], { stdio: "inherit", shell: isWindows }),
];

let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  // On Windows the child is cmd.exe; kill its whole tree so the Vite/Electron
  // descendants cannot keep the renderer dev port after this process exits.
  for (const child of children) stopChild(child, process.platform);
  // A wedged descendant must not keep `npm run dev` alive after the tree kill.
  setTimeout(() => process.exit(code), 2_000).unref();
  process.exitCode = code;
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (stopping) return;
    stop(code ?? (signal ? 1 : 0));
  });
  child.on("error", (error) => {
    console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
    stop(1);
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => stop(0));
}
