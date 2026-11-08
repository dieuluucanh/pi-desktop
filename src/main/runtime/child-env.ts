/**
 * Child-process environment composition (2026-11-05 terminal plan, step 5).
 *
 * Extracted from `HostSupervisor.spawnChild` so the Pi host and the terminal
 * host cannot drift on the thing that makes the bundled runtime usable: the shim
 * directory and the selected Node's directory come first on PATH, and Windows
 * ends up with exactly one canonical `PATH` key.
 *
 * Pure and injected: `platform` and the base environment are inputs, so the
 * Windows casing rules are testable on any OS.
 */

import { joinPathEntries } from "./layout";

export interface ChildEnvInput {
  baseEnv: Record<string, string | undefined>;
  platform: string;
  /** The runtime's shim directory (`pi`, `node`, `npm`, `npx`). */
  binDir: string;
  /** Directory of the selected Node binary, when it is an absolute path. */
  nodeBinDir?: string | null;
  /** Supervisor-specific variables applied after the base environment. */
  extra?: Record<string, string | undefined>;
  /** Names to remove after composition (e.g. Electron-only variables). */
  strip?: readonly string[];
}

/**
 * Returns a new environment with a canonical, ordered PATH. Windows environment
 * names are case-insensitive at the OS level, but a plain object can hold both
 * `PATH` and `Path`; the child would then pick whichever the platform keeps, so
 * every other spelling is deleted after `PATH` is set.
 */
export function composeChildEnv(input: ChildEnvInput): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...input.baseEnv, ...input.extra };
  const basePath = env.PATH ?? (input.platform === "win32" ? env.Path : undefined) ?? "";
  env.PATH = joinPathEntries([input.binDir, input.nodeBinDir ?? null, basePath], input.platform);
  if (input.platform === "win32") {
    for (const key of Object.keys(env)) {
      if (key !== "PATH" && key.toUpperCase() === "PATH") delete env[key];
    }
  }
  for (const name of input.strip ?? []) delete env[name];
  return env;
}

/**
 * Loader variables and how their entries are separated. glibc accepts colons
 * in both; `LD_PRELOAD` also accepts spaces.
 */
const LOADER_VARIABLES: Record<string, RegExp> = {
  LD_LIBRARY_PATH: /:/,
  LD_PRELOAD: /[\s:]/,
};

/**
 * Removes the AppImage mount from the loader paths of a child process.
 *
 * electron-builder's AppRun exports `LD_LIBRARY_PATH=$APPDIR/usr/lib` and every
 * process the app spawns inherits it. That directory holds the AppImage's own
 * runtime libraries, which can shadow the host's `libstdc++`/`libc` for a
 * bundled Node or a native addon — a class of failure that looks nothing like
 * its cause. Only entries under `$APPDIR` are removed: a user-set path is left
 * byte-identical, and without `APPDIR` (deb, dev, Windows, macOS) this is a
 * no-op.
 */
export function stripAppImageLibraryPaths(env: Record<string, string>): Record<string, string>;
export function stripAppImageLibraryPaths(
  env: Record<string, string | undefined>,
): Record<string, string | undefined>;
/**
 * Removes the AppImage mount from the loader paths of a child process.
 *
 * electron-builder's AppRun exports `LD_LIBRARY_PATH=$APPDIR/usr/lib` and every
 * process the app spawns inherits it. That directory holds the AppImage's own
 * runtime libraries, which can shadow the host's `libstdc++`/`libc` for a
 * bundled Node or a native addon — a class of failure that looks nothing like
 * its cause. Only entries under `$APPDIR` are removed: a user-set path is left
 * byte-identical, and without `APPDIR` (deb, dev, Windows, macOS) this is a
 * no-op.
 */
export function stripAppImageLibraryPaths(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const appDir = env.APPDIR?.replace(/\/+$/, "");
  if (!appDir) return { ...env };

  const result = { ...env };
  for (const [name, separator] of Object.entries(LOADER_VARIABLES)) {
    const value = result[name];
    if (typeof value !== "string" || value.length === 0) continue;
    const entries = value.split(separator);
    const kept = entries.filter(
      (entry) => entry.length > 0 && entry !== appDir && !entry.startsWith(`${appDir}/`),
    );
    const originalCount = entries.filter((entry) => entry.length > 0).length;
    if (kept.length === originalCount) continue;
    if (kept.length === 0) delete result[name];
    else result[name] = kept.join(":");
  }
  return result;
}
