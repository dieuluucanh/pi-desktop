/**
 * The derived checkpoint configuration file (git-checkpoint plan step 19).
 *
 * There are two readers of one decision. Main owns the preference
 * (`userData/app-state.json` → `prefs.checkpoints`), but the *host-side*
 * extension — the thing that snapshots a run before the agent's first edit —
 * runs in a separate process with only `PI_CODING_AGENT_DIR` to go on. It cannot
 * read `app-state.json`, and it must not keep a second writable copy of the
 * same numbers, because two writable copies of `enabled`/`retentionDays` drift.
 *
 * So **D19**: prefs are the source, and main *projects* them to
 * `<profileDir>/checkpoints/config.json` on every change. This module is that
 * projection: `readConfig` for the extension (and for main's own services),
 * `writeConfig` for main alone.
 *
 * AGENTS rule 5 applies as it does to `settings.json`: a malformed file is
 * reported (`CheckpointConfigError`) and **kept**, never silently repaired or
 * replaced — it may be the user's own hand-edit, or a newer app's file.
 */

import {
  DEFAULT_CHECKPOINT_CONFIG,
  checkpointsRoot,
  sanitizeCheckpointConfig,
  type CheckpointConfig,
} from "../shared/checkpoints";

/** The file name inside `<profileDir>/checkpoints`. */
export const CHECKPOINT_CONFIG_FILE = "config.json";

/** Thrown when the config document exists but is not readable JSON. */
export class CheckpointConfigError extends Error {
  constructor(
    readonly filePath: string,
    cause: unknown,
  ) {
    super(`Invalid JSON in ${filePath}; leaving it untouched.`, { cause });
    this.name = "CheckpointConfigError";
  }
}

/** The filesystem surface this module needs (injected: AGENTS rule 2). */
export interface CheckpointConfigFs {
  readTextFile(target: string): Promise<string | null>;
  writeTextFile(target: string, contents: string): Promise<void>;
  /** Atomic replace. Optional so a read-only port (the engine) can be passed. */
  rename?(from: string, to: string): Promise<void>;
  ensureDir(target: string): Promise<void>;
  /** File mode after a write; `0o600` where the platform has modes. */
  chmod?(target: string, mode: number): Promise<void>;
}

export interface CheckpointConfigDeps {
  fs: CheckpointConfigFs;
  profileDir: string;
  /** Distinguishes a temp file per writer; injected so tests are deterministic. */
  token?: () => string;
}

/** `<profileDir>/checkpoints/config.json`. */
export function checkpointConfigPath(profileDir: string): string {
  // Built from `checkpointsRoot` with a forward slash on purpose: the shadow-repo
  // layout is spelled the same way on every platform, so a profile copied
  // between machines keeps resolving to the same files (and a test asserts one
  // string instead of a platform-dependent join).
  return `${checkpointsRoot(profileDir)}/${CHECKPOINT_CONFIG_FILE}`;
}

export interface ReadConfigResult {
  config: CheckpointConfig;
  /** Where it came from, so Settings can say "defaults" honestly. */
  source: "file" | "missing";
}

/**
 * Reads the projected config.
 *
 * A missing file means "defaults" — a fresh profile, or an app that has not yet
 * projected anything. An unreadable or malformed file **throws**: the caller
 * (the extension) degrades to defaults for that snapshot and reports the
 * problem, but the bytes on disk stay exactly as they were.
 */
export async function readConfig(
  deps: Pick<CheckpointConfigDeps, "fs" | "profileDir">,
): Promise<ReadConfigResult> {
  const filePath = checkpointConfigPath(deps.profileDir);
  const text = await deps.fs.readTextFile(filePath);
  if (text === null) return { config: DEFAULT_CHECKPOINT_CONFIG, source: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CheckpointConfigError(filePath, error);
  }
  return { config: sanitizeCheckpointConfig(parsed), source: "file" };
}

/** Serialises the config; stable key order, one trailing newline. */
export function serializeConfig(config: CheckpointConfig): string {
  const clean = sanitizeCheckpointConfig(config);
  return `${JSON.stringify(clean, null, 2)}\n`;
}

/**
 * Writes the config atomically: a temp file in the same directory, a `chmod`
 * where the platform supports it, then a rename. A crash mid-write therefore
 * leaves either the old file or the new one, never a truncated document the
 * extension would refuse to read.
 *
 * Only main calls this (D19). The extension only ever reads.
 */
export async function writeConfig(
  deps: CheckpointConfigDeps,
  config: CheckpointConfig,
): Promise<CheckpointConfig> {
  const clean = sanitizeCheckpointConfig(config);
  const filePath = checkpointConfigPath(deps.profileDir);
  await deps.fs.ensureDir(checkpointsRoot(deps.profileDir));
  const tempPath = `${filePath}.${deps.token?.() ?? "tmp"}.tmp`;
  await deps.fs.writeTextFile(tempPath, serializeConfig(clean));
  // A config file reveals folder names and retention choices; keep it private
  // where the platform has modes at all (Windows does not).
  if (deps.fs.chmod) await deps.fs.chmod(tempPath, 0o600).catch(() => undefined);
  if (!deps.fs.rename) {
    // No atomic replace available on this port: write in place rather than
    // leaving a temp file behind.
    await deps.fs.writeTextFile(filePath, serializeConfig(clean));
    return clean;
  }
  await deps.fs.rename(tempPath, filePath);
  return clean;
}

/**
 * Copies the configured values out of the app's preferences.
 *
 * `prefs.checkpoints` holds exactly the keys of {@link CheckpointConfig}, but it
 * is untrusted input like any other preference document, so this re-uses the
 * one sanitizer instead of trusting the shape.
 */
export function configFromPrefs(value: unknown): CheckpointConfig {
  const source =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  // `prefs.checkpoints` may carry the projection's own `updatedAt`/`source`
  // bookkeeping; the sanitizer drops anything it does not know.
  return sanitizeCheckpointConfig(source);
}

/**
 * Projects preferences onto the config file, writing only when the resulting
 * document would differ. A `prefs.set` for an unrelated key (the rail's width,
 * the theme) must not touch the file every few hundred milliseconds while a
 * drag handle is moving.
 *
 * Returns whether a write happened, for the settings service and its tests.
 */
export async function projectConfigFromPrefs(
  deps: CheckpointConfigDeps,
  prefsValue: unknown,
): Promise<{ config: CheckpointConfig; wrote: boolean }> {
  const config = configFromPrefs(prefsValue);
  const filePath = checkpointConfigPath(deps.profileDir);
  const existing = await deps.fs.readTextFile(filePath);
  if (existing !== null) {
    try {
      const current = sanitizeCheckpointConfig(JSON.parse(existing) as unknown);
      if (serializeConfig(current) === serializeConfig(config)) {
        return { config: current, wrote: false };
      }
    } catch {
      // Leave a malformed file alone: the next explicit prefs write replaces it,
      // and until then the extension reports the problem instead of us guessing.
      // `writeConfig` below is the one place that overwrites, on a real change.
    }
  }
  return { config: await writeConfig(deps, config), wrote: true };
}
