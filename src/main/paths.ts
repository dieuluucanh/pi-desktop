import { homedir } from "node:os";
import { join, resolve } from "node:path";
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

export interface AppRoots {
  /** Repository root in development, the resources directory when packaged. */
  appRoot: string;
  /** Where `resources/…` lives (the asar sibling when packaged). */
  resourcesDir: string;
  manifestPath: string;
  runtimeDir: string;
  officeDir: string;
}

/**
 * Resolves the bundled resources (plan step 2/3). Pure so it can be unit tested:
 * the caller passes `app.isPackaged`, `process.resourcesPath` and the directory
 * of the running main bundle.
 */
export function resolveAppRoots(input: {
  isPackaged: boolean;
  resourcesPath: string;
  mainDir: string;
}): AppRoots {
  const appRoot = input.isPackaged ? input.resourcesPath : resolve(input.mainDir, "..", "..");
  const resourcesDir = input.isPackaged ? input.resourcesPath : join(appRoot, "resources");
  const officeDir = join(resourcesDir, "office");

  return {
    appRoot,
    resourcesDir,
    officeDir,
    runtimeDir: join(resourcesDir, "runtime"),
    manifestPath: join(officeDir, "manifest.prod.xml"),
  };
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
  // `process.env` is passed explicitly: without it the documented
  // `PI_CODING_AGENT_DIR` override (plan D8) would be ignored by the real app.
  return resolveAppPaths({ userDataDir: app.getPath("userData"), env: process.env });
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
