import { createNodeFsPort, type FsPort } from "./fs-port";
import {
  readSettingsDocument,
  writeSettingsDocument,
  type SettingsDocument,
} from "./packages/settings";
import { DEFAULT_PREFS, mergePrefs, sanitizePrefs, type UiPrefs } from "../shared/prefs";
import {
  emptyIntegrationsState,
  sanitizeIntegrationsState,
  type IntegrationsState,
} from "../shared/integrations";
import { sanitizeProjects, type ProjectRecord } from "../shared/projects";
import { sanitizeTabs, type TabRecord } from "../shared/session-ipc";

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
  /** Remembered projects, most recent first (plan step 10). */
  projects: ProjectRecord[];
  /** Window chrome and session-view preferences (plan step 1). */
  prefs: UiPrefs;
  /** Session/web/office tabs, restored on launch (plan step 3). */
  tabs: TabRecord[];
  /** The tab the window should select after a relaunch. */
  activeTabId: string | null;
  /**
   * Integrations (plan step 19): the app's own record of a consented install
   * and the last completed setup. Pi's settings remain the install source of
   * truth; this is what lets the card be honest about "installed by this app".
   */
  integrations: IntegrationsState;
}

export function defaultAppState(): AppState {
  return {
    version: APP_STATE_VERSION,
    activeProject: null,
    projects: [],
    prefs: { ...DEFAULT_PREFS },
    tabs: [],
    activeTabId: null,
    integrations: emptyIntegrationsState(),
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
    // `recentProjects` was the pre-step-10 schema (bare paths); the sanitizer
    // already accepts those strings, so an existing app-state.json migrates.
    projects: sanitizeProjects(doc.projects ?? doc.recentProjects),
    prefs: sanitizePrefs(doc.prefs),
    tabs: sanitizeTabs(doc.tabs),
    activeTabId: typeof doc.activeTabId === "string" ? doc.activeTabId : null,
    integrations: sanitizeIntegrationsState(doc.integrations),
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
      // Never cache a state the disk did not accept: a failed write used to be
      // reported and then cached anyway, so every later read returned phantom
      // state and each patch compounded the drift (plan step 27).
      try {
        await writeSettingsDocument(fs, options.file, { ...next });
      } catch (error) {
        report(error);
        throw error;
      }
      cached = next;
      return next;
    },
    updatePrefs: async (patch: unknown): Promise<UiPrefs> => {
      const current = await read();
      const prefs = mergePrefs(current.prefs, patch);
      try {
        await writeSettingsDocument(fs, options.file, { ...current, prefs });
      } catch (error) {
        report(error);
        throw error;
      }
      cached = { ...current, prefs };
      return prefs;
    },
  };
}
