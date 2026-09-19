import { homedir } from "node:os";
import { join } from "node:path";
import { app } from "electron";

/**
 * Where the app keeps its own state, and where the Pi profile lives.
 *
 * App state is deliberately separate from Pi state (plan D14): sessions and
 * configuration belong to `~/.pi/agent` (or a project `.pi/`), while tabs,
 * layout and preferences live under Electron's `userData`.
 */

export const PROFILE_ENV = "PI_CODING_AGENT_DIR";
export const SAFE_MODE_FLAG = "--safe-mode";
export const SAFE_MODE_ENV = "PI_DESKTOP_SAFE_MODE";

export interface AppPaths {
  /** Electron `userData` root (also the base for package/app caches). */
  userData: string;
  logs: string;
  /** Spill area for oversized host frames (plan step 4). */
  blobCache: string;
  /** The shared Pi profile directory. */
  profileDir: string;
  appStateFile: string;
}

export interface ResolveAppPathsInput {
  userDataDir: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
}

/**
 * Pure path resolution, so it can be unit tested without Electron.
 * `PI_CODING_AGENT_DIR` wins when set and non-empty (plan D8).
 */
export function resolveAppPaths(input: ResolveAppPathsInput): AppPaths {
  const env = input.env ?? {};
  const home = input.homeDir ?? homedir();
  const override = env[PROFILE_ENV]?.trim();

  return {
    userData: input.userDataDir,
    logs: join(input.userDataDir, "logs"),
    blobCache: join(input.userDataDir, "blob-cache"),
    appStateFile: join(input.userDataDir, "app-state.json"),
    profileDir: override && override.length > 0 ? override : join(home, ".pi", "agent"),
  };
}

/** Electron-bound wrapper around {@link resolveAppPaths}. */
export function appPaths(): AppPaths {
  return resolveAppPaths({ userDataDir: app.getPath("userData") });
}

/**
 * Safe mode starts with no extensions and no packages so a bad install can
 * always be recovered from (plan step 21).
 */
export function isSafeMode(
  argv: readonly string[] = process.argv,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return argv.includes(SAFE_MODE_FLAG) || env[SAFE_MODE_ENV] === "1";
}
