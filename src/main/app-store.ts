import { createNodeFsPort, type FsPort } from "./fs-port";
import {
  readSettingsDocument,
  writeSettingsDocument,
  type SettingsDocument,
} from "./packages/settings";
import { DEFAULT_PREFS, mergePrefs, sanitizePrefs, type UiPrefs } from "../shared/prefs";

/**
 * The app's own persisted state (plan D14): which project is open, recent
 * projects, UI preferences and — from step 11 — the tab layout. Nothing
 * Pi-related is stored here; sessions and settings stay in the Pi profile.
 *
 * Writes reuse the atomic settings writer (temp file + rename) and never repair
 * a malformed file silently: a corrupt store is reported and replaced in memory
 * by defaults only.
 */

export const APP_STATE_VERSION = 1;

export interface AppState {
  version: number;
  activeProject: string | null;
  recentProjects: string[];
  /** Window chrome and session-view preferences (plan step 1). */
  prefs: UiPrefs;
  /** Session/web/office tab descriptors; populated in plan step 11. */
  tabs: unknown[];
}

export function defaultAppState(): AppState {
  return {
    version: APP_STATE_VERSION,
    activeProject: null,
    recentProjects: [],
    prefs: { ...DEFAULT_PREFS },
    tabs: [],
  };
}

export interface AppStore {
  read(): Promise<AppState>;
  update(patch: Partial<AppState>): Promise<AppState>;
  /** Merges a validated, partial preference patch (unknown keys are ignored). */
  updatePrefs(patch: unknown): Promise<UiPrefs>;
}

export interface CreateAppStoreOptions {
  /** Absolute path of the JSON file to read and write. */
  file: string;
  fs?: FsPort;
  /** Receives parse/IO failures so the caller can log or surface them. */
  onError?: (error: unknown) => void;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** Coerces an arbitrary JSON document into a valid `AppState`. */
export function normalizeAppState(doc: SettingsDocument): AppState {
  const defaults = defaultAppState();
  const version =
    typeof doc.version === "number" && Number.isFinite(doc.version)
      ? doc.version
      : defaults.version;
  const activeProject =
    typeof doc.activeProject === "string" ? doc.activeProject : defaults.activeProject;
  return {
    version,
    activeProject,
    recentProjects: stringArray(doc.recentProjects),
    prefs: sanitizePrefs(doc.prefs),
    tabs: Array.isArray(doc.tabs) ? doc.tabs : defaults.tabs,
  };
}

export function createAppStore(options: CreateAppStoreOptions): AppStore {
  const fs = options.fs ?? createNodeFsPort();
  const report = options.onError ?? ((): void => {});
  let cached: AppState | null = null;

  const read = async (): Promise<AppState> => {
    if (cached) return cached;
    try {
      cached = normalizeAppState(await readSettingsDocument(fs, options.file));
    } catch (error) {
      report(error);
      cached = defaultAppState();
    }
    return cached;
  };

  return {
    read,
    update: async (patch: Partial<AppState>): Promise<AppState> => {
      const current = await read();
      const next: AppState = normalizeAppState({
        ...current,
        ...patch,
        version: APP_STATE_VERSION,
      });
      try {
        await writeSettingsDocument(fs, options.file, { ...next });
      } catch (error) {
        report(error);
      }
      cached = next;
      return next;
    },
    updatePrefs: async (patch: unknown): Promise<UiPrefs> => {
      const current = await read();
      const prefs = mergePrefs(current.prefs, patch);
      await writeSettingsDocument(fs, options.file, { ...current, prefs });
      cached = { ...current, prefs };
      return prefs;
    },
  };
}
