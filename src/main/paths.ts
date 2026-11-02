import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { app } from "electron";
import { SAFE_MODE_ENV } from "../shared/host-protocol";
import { APP_PROFILE_DIR_NAME, sanitizeProfileMode, type ProfileMode } from "../shared/profile";

/**
 * Where the app keeps its own state, and where the Pi profile lives.
 *
 * App state is deliberately separate from Pi state (plan D14): sessions and
 * configuration belong to `~/.pi/agent` (or a project `.pi/`), while tabs,
 * layout and preferences live under Electron's `userData`.
 */

export const PROFILE_ENV = "PI_CODING_AGENT_DIR";
export const SAFE_MODE_FLAG = "--safe-mode";
/** Re-exported from the host protocol so the host and the app read one name. */
export { SAFE_MODE_ENV };

export interface AppPaths {
  /** Electron `userData` root (also the base for package/app caches). */
  userData: string;
  logs: string;
  /** Spill area for oversized host frames (plan step 4). */
  blobCache: string;
  /** Hot-exit editor backups (`<tabId>.json`). */
  editorBackups: string;
  /** The shared Pi profile directory. */
  profileDir: string;
  /** Which profile strategy produced {@link profileDir} (plan step 26). */
  profileMode: ProfileMode;
  appStateFile: string;
}

export interface ResolveAppPathsInput {
  userDataDir: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  /**
   * `shared` (default) keeps `~/.pi/agent`; `app` uses an app-private profile
   * under `userData`. `PI_CODING_AGENT_DIR` always wins over either.
   */
  profileMode?: ProfileMode;
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
function profileDirFor(input: {
  mode: ProfileMode;
  override: string | undefined;
  userDataDir: string;
  home: string;
}): string {
  if (input.override && input.override.length > 0) return input.override;
  if (input.mode === "app") return join(input.userDataDir, APP_PROFILE_DIR_NAME);
  return join(input.home, ".pi", "agent");
}

/**
 * Pure path resolution, so it can be unit tested without Electron.
 * `PI_CODING_AGENT_DIR` wins when set and non-empty (plan D8).
 */
export function resolveAppPaths(input: ResolveAppPathsInput): AppPaths {
  const env = input.env ?? {};
  const home = input.homeDir ?? homedir();
  const override = env[PROFILE_ENV]?.trim();
  const profileMode = sanitizeProfileMode(input.profileMode);

  return {
    userData: input.userDataDir,
    logs: join(input.userDataDir, "logs"),
    blobCache: join(input.userDataDir, "blob-cache"),
    editorBackups: join(input.userDataDir, "editor-backups"),
    appStateFile: join(input.userDataDir, "app-state.json"),
    profileDir: profileDirFor({
      mode: profileMode,
      override,
      userDataDir: input.userDataDir,
      home,
    }),
    profileMode,
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
 * always be recovered from (plan step 22).
 */
export function isSafeMode(
  argv: readonly string[] = process.argv,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return argv.includes(SAFE_MODE_FLAG) || env[SAFE_MODE_ENV] === "1";
}
