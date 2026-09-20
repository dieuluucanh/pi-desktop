import { create } from "zustand";
import type { AppInfo } from "../../../shared/ipc";
import {
  DEFAULT_PREFS,
  toggleFavoriteModel,
  type UiPrefs,
  type ViewMode,
} from "../../../shared/prefs";
import {
  findProject,
  projectNameOf,
  type CloneProjectInput,
  type CreateProjectInput,
  type ProjectAction,
  type ProjectConfigPatch,
  type ProjectInspection,
  type ProjectRecord,
  type ProjectTrustStatus,
  type TrustAnswer,
} from "../../../shared/projects";
import {
  PROVIDER_LOGIN_EVENT,
  isProviderLoginPrompt,
  type ProviderAuthPrompt,
  type ProviderLoginEvent,
  type ProviderSummary,
} from "../../../shared/providers";
import type { CustomProviderInput, CustomProviderSummary } from "../../../shared/custom-providers";
import {
  findSettingsField,
  getSettingsValue,
  mergeSettingsScopes,
  settingsDefaultsDocument,
  type SettingsValue,
} from "../../../shared/settings-schema";
import type {
  SettingsErrorInfo,
  SettingsFileStatus,
  SettingsScope,
  SettingsScopes,
  SettingsSnapshot,
} from "../../../shared/settings";
import {
  CONTROL_TAB_ID,
  type CreateTabInput,
  type SessionEventEnvelope,
  type SessionEventEntry,
  type SessionStateEnvelope,
  type SessionTabsEnvelope,
  type TabRecord,
} from "../../../shared/session-ipc";
import {
  mostRecentSessionForProject,
  sanitizeSessionList,
  type SessionSummary,
} from "../../../shared/session-browser";
import {
  EMPTY_RESOURCES,
  applyResourceOverride,
  diffResources,
  isResourceChangeEmpty,
  sanitizeResourcesSnapshot,
  settingsScopeForResource,
  type ResourceChangeSummary,
  type ResourceSummary,
  type ResourcesSnapshot,
} from "../../../shared/resources";
import type { RecommendedPackage } from "../../../shared/recommended-packages";
import {
  createTranscriptState,
  hydrateMessages,
  reduceSessionEvents,
  type TranscriptState,
} from "../session/session-events";
import { appCommandNames, resolveCommandInput } from "../completion/dispatch";
import type { HostCommandEntry } from "../completion/command-source";
import type { FileListSnapshot } from "../completion/file-source";
import type { CompletionSource } from "../completion/types";
import { thinkingLevelsOf, toCatalog, type ModelCatalogEntry } from "../session/model-catalog";

/**
 * The renderer's view state (plan step 1).
 *
 * Two rules keep this predictable:
 *  - the store never talks to a Pi host (that is the session service, step 3);
 *  - preferences and the project list are persisted through main (`prefs.*` and
 *    `projects.*`), so the main process stays the single writer of
 *    `app-state.json`.
 *
 * Session tabs live in the session service (step 3); the project list is real as
 * of step 10.
 */

export type AppView =
  | "welcome"
  | "session"
  | "settings"
  | "extensions"
  | "connections"
  | "skills"
  | "diagnostics"
  | "office";

/** How a message sent while the agent is streaming is delivered (plan step 6). */
export type SendMode = "steer" | "followUp";

/** One image attachment ready for `prompt`'s `images` parameter. */
export interface PromptImage {
  type: "image";
  data: string;
  mimeType: string;
}

/**
 * The composer's draft/persist debounce. Writing app state on every keystroke
 * would hammer the disk; the draft is safe in memory immediately and lands in
 * `app-state.json` shortly after the user stops typing.
 */
let draftPersistTimer: ReturnType<typeof setTimeout> | null = null;
export const DRAFT_PERSIST_DELAY_MS = 500;

export const APP_VIEWS: readonly AppView[] = [
  "welcome",
  "session",
  "settings",
  "extensions",
  "connections",
  "skills",
  "diagnostics",
  "office",
];

export interface ProjectRef {
  path: string;
  name: string;
}

/** The trust question the project needs answered (plan step 10). */
export interface TrustPrompt {
  cwd: string;
  /** The tab whose `session.create` was refused, when one exists. */
  tabId: string | null;
  status: ProjectTrustStatus;
}

export interface AppStateShape {
  view: AppView;
  /** The project a new session would use; null until one is opened. */
  project: ProjectRef | null;
  /** Remembered projects, most recent first (plan step 10). */
  projects: ProjectRecord[];
  projectsLoaded: boolean;
  /** Host inspection per project path (git branch, `.pi/`, trust, session dir). */
  projectInspections: Record<string, ProjectInspection>;
  projectInspectionErrors: Record<string, string>;
  /** The trust prompt currently on screen, if any. */
  trustPrompt: TrustPrompt | null;
  trustBusy: boolean;
  /** Projects trusted for this app run only (`Trust once`). */
  sessionTrust: string[];
  prefs: UiPrefs;
  /** True once preferences have been read from the main process. */
  prefsLoaded: boolean;
  paletteOpen: boolean;
  info: AppInfo | null;
  /** Transient, user-visible explanation for an action that is not wired yet. */
  hint: string | null;
  /** Open session tabs (plan step 3); the main process owns their hosts. */
  tabs: TabRecord[];
  activeTabId: string | null;
  /** Per-tab event counter/last event: proof the host pipe is live (step 5 renders it). */
  transcripts: Record<string, TranscriptState>;
  /** Latest `state.get` snapshot per tab (opaque to the renderer). */
  sessionStates: Record<string, unknown>;

  /** Session browser and tree (plan step 11). */
  sessionBrowserOpen: boolean;
  sessionBrowserQuery: string;
  /** Every session of the profile, from the control host's `session.list`. */
  projectSessions: SessionSummary[];
  projectSessionsLoaded: boolean;
  projectSessionsError: string | null;
  /** The session tree of the tab the tree dialog is showing. */
  sessionTreeOpen: boolean;
  sessionTreeTabId: string | null;
  sessionTree: unknown;
  sessionTreeLeafId: string | null;
  sessionTreeError: string | null;
  /** The fork dialog's candidates (Pi's `get_fork_messages`). */
  forkOpen: boolean;
  forkCandidates: Array<{ entryId: string; text: string }>;

  setView: (view: AppView) => void;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
  setPrefs: (patch: Partial<UiPrefs>) => void;
  toggleSidebar: () => void;
  setInfo: (info: AppInfo) => void;
  openProject: (path: string) => Promise<void>;
  closeProject: () => void;
  /** Loads the remembered project list and restores the active project. */
  loadProjects: () => Promise<void>;
  /** Applies a project-list snapshot returned by any `projects.*` call. */
  applyProjects: (snapshot: { projects: ProjectRecord[]; activeProject: string | null }) => void;
  activateProject: (path: string | null) => Promise<void>;
  removeProject: (path: string) => Promise<void>;
  reorderProject: (path: string, toIndex: number) => Promise<void>;
  updateProjectConfig: (path: string, patch: ProjectConfigPatch) => Promise<void>;
  /** Inspects a project folder through the control host (plan step 10). */
  inspectProject: (path: string) => Promise<ProjectInspection | null>;
  createBlankProject: (input: CreateProjectInput) => Promise<boolean>;
  cloneProject: (input: CloneProjectInput) => Promise<boolean>;
  /** Opens the user's home folder as a project and starts a session there. */
  quickSessionInHome: () => Promise<void>;
  projectAction: (path: string, action: ProjectAction) => Promise<boolean>;
  /** Answers the `project_trust` prompt and retries the refused session. */
  answerTrust: (answer: TrustAnswer) => Promise<void>;
  /** Raises the trust prompt when the project requires a decision; reports whether it did. */
  openTrustPrompt: (cwd: string) => Promise<boolean>;
  /** Hides the trust prompt, leaving the project untrusted. */
  dismissTrust: () => void;
  setHint: (hint: string | null) => void;
  loadPrefs: () => Promise<void>;
  /** Sessions (plan step 3). */
  loadTabs: () => Promise<void>;
  applyTabs: (envelope: SessionTabsEnvelope) => void;
  applySessionEvents: (envelope: SessionEventEnvelope) => void;
  applySessionState: (envelope: SessionStateEnvelope) => void;
  /** Loads history from `messages.get` once per tab (plan step 5). */
  hydrateTranscript: (tabId: string) => Promise<void>;
  /** Aborts the run of a tab (the transcript's error banner action). */
  abortTab: (tabId: string) => Promise<void>;
  /** Drops a tab's transcript so the next hydrate rebuilds it (branch navigation). */
  resetTranscript: (tabId: string) => void;

  /** Composer (plan step 6). */
  sendModes: Record<string, SendMode>;
  draftHistory: Record<string, string[]>;
  /** Where the user is browsing history for a tab (-1 = the live draft). */
  historyIndex: Record<string, number>;
  setSendMode: (tabId: string, mode: SendMode) => void;
  setDraft: (tabId: string, text: string) => void;
  sendPrompt: (
    tabId: string,
    text: string,
    options?: { mode?: SendMode; images?: PromptImage[]; preferredSource?: CompletionSource },
  ) => Promise<boolean>;
  /** Sends without command routing (used by the dispatch table itself). */
  sendPromptNow: (
    tabId: string,
    text: string,
    options?: { mode?: SendMode; images?: PromptImage[] },
  ) => Promise<boolean>;
  /** `clearQueue` then `abort`, restoring the queued text into the draft. */
  stopRun: (tabId: string) => Promise<void>;
  clearQueue: (tabId: string) => Promise<void>;
  historyStep: (tabId: string, direction: 1 | -1) => string | null;

  /** Completion engine (plan step 7). */
  completionCommands: Record<string, HostCommandEntry[]>;
  completionFiles: Record<string, FileCacheEntry>;
  loadCommands: (tabId: string, options?: { refresh?: boolean }) => Promise<HostCommandEntry[]>;
  loadFiles: (tabId: string, options?: { refresh?: boolean }) => Promise<FileListSnapshot | null>;
  /**
   * Runs a submitted `/command`. `handled: false` means the text is not a
   * command and the caller should treat it as a prompt; `sent: false` with
   * `handled: true` means the app consumed it (view switch, hint).
   */
  runCommandInput: (
    tabId: string,
    text: string,
    preferredSource?: CompletionSource,
  ) => Promise<CommandOutcome>;

  /** Model, thinking and usage UX (plan step 8). */
  modelCatalog: Record<string, ModelCatalogEntry[]>;
  providerAuth: Record<string, Record<string, unknown>>;
  thinkingLevels: Record<string, string[]>;
  picker: PickerKind | null;
  loadModels: (tabId: string) => Promise<void>;
  setModel: (
    tabId: string,
    entry: ModelCatalogEntry,
    options?: { persist?: boolean },
  ) => Promise<void>;
  setThinking: (tabId: string, level: string, options?: { persist?: boolean }) => Promise<void>;
  cycleModel: (tabId: string, direction: 1 | -1) => Promise<void>;
  cycleThinking: (tabId: string) => Promise<void>;
  renameSession: (tabId: string, name: string) => Promise<void>;
  toggleFavorite: (key: string) => void;
  setViewMode: (mode: ViewMode) => void;
  openPicker: (picker: PickerKind) => void;
  closePicker: () => void;

  /** Connections — providers, credentials and sign-in (plan step 9). */
  providers: ProviderSummary[];
  providersLoaded: boolean;
  providersError: string | null;
  providerLogin: ProviderLoginState | null;
  loadProviders: () => Promise<void>;
  /** Writes a key through Pi; throws so the write-only form can show the error. */
  setProviderKey: (providerId: string, apiKey: string) => Promise<void>;
  logoutProvider: (providerId: string) => Promise<void>;
  startProviderLogin: (providerId: string) => Promise<void>;
  cancelProviderLogin: () => Promise<void>;
  /** Aborts a running sign-in, then hides the dialog. */
  dismissProviderLogin: () => void;
  answerProviderLogin: (value: string | undefined) => Promise<void>;
  /** Routes a control-host event (provider login) rather than a transcript. */
  applyControlEvent: (entry: SessionEventEntry) => void;
  /** Custom model gateways in `models.json` (plan step 9, slice 5). */
  customProviders: CustomProviderSummary[];
  customProvidersLoaded: boolean;
  customProvidersError: string | null;
  loadCustomProviders: () => Promise<void>;
  saveCustomProvider: (input: CustomProviderInput) => Promise<void>;
  deleteCustomProvider: (providerId: string) => Promise<void>;

  /** Pi settings (plan step 12): both scopes, edited through the control host. */
  settingsCwd: string | null;
  settings: SettingsScopes | null;
  settingsLoaded: boolean;
  settingsBusy: boolean;
  settingsError: string | null;
  settingsErrors: SettingsErrorInfo[];
  settingsFiles: { global: SettingsFileStatus; project: SettingsFileStatus } | null;
  settingsProjectTrusted: boolean;
  /** File mtimes captured with the snapshot, to detect a terminal-Pi edit. */
  settingsMtimes: { global: number | null; project: number | null };
  settingsExternalEdit: boolean;
  loadSettings: (options?: { refresh?: boolean }) => Promise<void>;
  /**
   * Writes one key in one scope. Returns false (and records `settingsError`)
   * when the value is invalid or the project is not trusted.
   */
  setSetting: (key: string, value: unknown, scope: SettingsScope) => Promise<boolean>;
  writeRawSettings: (
    scope: SettingsScope,
    document: string | Record<string, unknown>,
  ) => Promise<boolean>;
  flushSettings: () => Promise<void>;
  /** Re-reads both scopes from disk and clears the external-edit flag. */
  reloadSettings: () => Promise<void>;
  /** Compares the files' mtimes with the loaded snapshot; true when they differ. */
  checkExternalSettingsEdit: () => Promise<boolean>;
  /** Writes the documented default (or deletes the key when it has none). */
  resetSetting: (key: string, scope: SettingsScope) => Promise<void>;
  /** Resets a scope: global to the documented defaults, project to no overrides. */
  resetScope: (scope: SettingsScope) => Promise<void>;
  /** The effective value of a key, with the project override winning. */
  effectiveSetting: (key: string) => SettingsValue | undefined;

  /** Extensions hub (plan step 13): what Pi loaded, with provenance and errors. */
  resources: ResourcesSnapshot;
  resourcesLoaded: boolean;
  resourcesBusy: boolean;
  resourcesError: string | null;
  /** The tab whose host answered (the control host when no session is active). */
  resourcesTabId: string | null;
  resourcesCwd: string | null;
  /** What the last runtime reload changed, for the hub's “what changed” note. */
  resourcesChange: ResourceChangeSummary | null;
  loadResources: (options?: { refresh?: boolean }) => Promise<void>;
  /** Enable/disable one resource through the settings arrays, then reload Pi. */
  toggleResource: (resource: ResourceSummary, enabled: boolean) => Promise<boolean>;
  /** `session.reload` on a live host (or a fresh loader) and report the delta. */
  reloadResources: () => Promise<void>;
  /**
   * One-click install of a recommended package (plan step 13 routes it through
   * the package manager; step 14 owns the install machinery, so a host without
   * it surfaces `not_implemented` instead of pretending success).
   */
  installRecommendedPackage: (entry: RecommendedPackage) => Promise<boolean>;

  createSessionTab: () => Promise<void>;
  activateTab: (tabId: string) => Promise<void>;
  closeTab: (tabId: string) => Promise<void>;
  closeActiveTab: () => Promise<void>;
  cycleTab: (direction: 1 | -1) => Promise<void>;
  /** Close every other tab, keeping `tabId` active (plan step 11). */
  closeOtherTabs: (tabId: string) => Promise<void>;
  /** Move a tab within the strip; persisted by the session service. */
  moveTab: (tabId: string, toIndex: number) => Promise<void>;
  /** Open a fresh session in the same project as `tabId`. */
  duplicateTab: (tabId: string) => Promise<void>;
  /** Clone the live session into a new file and keep working in the clone. */
  cloneSession: (tabId: string) => Promise<void>;
  /** Reveal the tab's session JSONL in the OS file manager. */
  revealSessionFile: (tabId: string) => Promise<void>;

  /** Session browser (plan step 11): list, search, resume, delete. */
  openSessionBrowser: () => Promise<void>;
  closeSessionBrowser: () => void;
  setSessionBrowserQuery: (query: string) => void;
  loadProjectSessions: (options?: { refresh?: boolean }) => Promise<SessionSummary[]>;
  /** Resume a listed session in a new tab and focus it. */
  resumeSession: (session: SessionSummary) => Promise<void>;
  /** Continue the newest session of a project. */
  continueMostRecent: (cwd: string) => Promise<void>;
  /** Trash a session file (validated by the host, trashed by main). */
  deleteSession: (session: SessionSummary) => Promise<boolean>;
  /** Rename a stored session: through its open tab, or the control host. */
  renameStoredSession: (session: SessionSummary, name: string) => Promise<void>;

  /** Session tree and branches (plan step 11). */
  openSessionTree: (tabId: string) => Promise<void>;
  closeSessionTree: () => void;
  loadSessionTree: (tabId: string) => Promise<void>;
  navigateTree: (
    tabId: string,
    targetId: string,
    options?: { summarize?: boolean; label?: string },
  ) => Promise<void>;
  setEntryLabel: (tabId: string, targetId: string, label: string | null) => Promise<void>;
  /** The fork dialog: Pi's user messages, then fork at the chosen entry. */
  openFork: (tabId: string) => Promise<void>;
  closeFork: () => void;
  forkFrom: (tabId: string, entryId: string) => Promise<void>;
  /** Export the session to HTML and reveal the written file. */
  exportSessionHtml: (tabId: string) => Promise<void>;
}

/** How long a `files.list` result is reused before it is fetched again. */
export const FILE_CACHE_TTL_MS = 30_000;

export interface FileCacheEntry {
  files: string[];
  root: string;
  truncated: boolean;
  fetchedAt: number;
}

/** What running a `/command` did (plan step 7). */
export interface CommandOutcome {
  /** False when the text was not a command at all. */
  handled: boolean;
  /** True when something was actually sent to the agent (or a host method ran). */
  sent: boolean;
}

/** Which model/thinking dialog is open (plan step 8). */
export type PickerKind = "model" | "thinking";

/**
 * The visible state of an in-flight provider sign-in (plan step 9).
 *
 * `url`/`deviceCode` mirror what Pi reported; the URL has already been opened
 * in the system browser, and `prompt` is the `oi.request` the flow is blocked on
 * until `answerProviderLogin` responds.
 */
export interface ProviderLoginState {
  loginId: string;
  providerId: string;
  status: "running" | "done" | "error" | "cancelled";
  message: string | null;
  url: string | null;
  deviceCode: { userCode: string; verificationUri: string } | null;
  prompt: { id: string; prompt: ProviderAuthPrompt } | null;
}

function bridge(): Window["pi"] | undefined {
  return typeof window === "undefined" ? undefined : window.pi;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Turns a `settings.*` snapshot into the store slice it updates, so every
 * settings action records the file mtimes for external-edit detection the same
 * way (plan step 12).
 */
function settingsStateFrom(snapshot: SettingsSnapshot, cwd: string | null): Partial<AppStateShape> {
  return {
    settingsCwd: cwd,
    settings: snapshot.settings,
    settingsErrors: snapshot.errors ?? [],
    settingsFiles: snapshot.files,
    settingsProjectTrusted: snapshot.projectTrusted,
    settingsMtimes: {
      global: snapshot.files.global.mtimeMs,
      project: snapshot.files.project.mtimeMs,
    },
    settingsLoaded: true,
    settingsBusy: false,
    settingsError: null,
    settingsExternalEdit: false,
  };
}

/** Returns a copy of a record without one key (used to clear an inspection error). */
function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * Which host answers the Extensions hub (plan step 13): the active session tab
 * when one exists (live, with `extension_error` history), otherwise the app-wide
 * control host, which loads resources on demand.
 */
function resourcesTarget(state: AppStateShape): string {
  const active = state.tabs.find((tab) => tab.id === state.activeTabId);
  return active && active.kind === "session" ? active.id : CONTROL_TAB_ID;
}

/** The project whose resources the hub should describe. */
function resourcesCwd(state: AppStateShape, target: string): string | null {
  const tab = state.tabs.find((entry) => entry.id === target);
  return tab?.cwd ?? state.project?.path ?? null;
}

export const useAppStore = create<AppStateShape>()((set, get) => ({
  view: "welcome",
  project: null,
  projects: [],
  projectsLoaded: false,
  projectInspections: {},
  projectInspectionErrors: {},
  trustPrompt: null,
  trustBusy: false,
  sessionTrust: [],
  prefs: { ...DEFAULT_PREFS },
  prefsLoaded: false,
  paletteOpen: false,
  info: null,
  hint: null,
  tabs: [],
  activeTabId: null,
  transcripts: {},
  sessionStates: {},
  sessionBrowserOpen: false,
  sessionBrowserQuery: "",
  projectSessions: [],
  projectSessionsLoaded: false,
  projectSessionsError: null,
  sessionTreeOpen: false,
  sessionTreeTabId: null,
  sessionTree: null,
  sessionTreeLeafId: null,
  sessionTreeError: null,
  forkOpen: false,
  forkCandidates: [],
  sendModes: {},
  draftHistory: {},
  historyIndex: {},
  completionCommands: {},
  completionFiles: {},
  modelCatalog: {},
  providerAuth: {},
  thinkingLevels: {},
  picker: null,
  providers: [],
  providersLoaded: false,
  providersError: null,
  settingsCwd: null,
  settings: null,
  settingsLoaded: false,
  settingsBusy: false,
  settingsError: null,
  settingsErrors: [],
  settingsFiles: null,
  settingsProjectTrusted: true,
  settingsMtimes: { global: null, project: null },
  settingsExternalEdit: false,
  resources: EMPTY_RESOURCES,
  resourcesLoaded: false,
  resourcesBusy: false,
  resourcesError: null,
  resourcesTabId: null,
  resourcesCwd: null,
  resourcesChange: null,
  providerLogin: null,
  customProviders: [],
  customProvidersLoaded: false,
  customProvidersError: null,

  setView: (view) => set({ view, hint: null }),
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set({ paletteOpen: !get().paletteOpen }),

  setPrefs: (patch) => {
    const prefs = { ...get().prefs, ...patch };
    set({ prefs });
    void bridge()?.prefs.set(patch);
  },

  toggleSidebar: () => get().setPrefs({ sidebarCollapsed: !get().prefs.sidebarCollapsed }),

  setInfo: (info) => set({ info }),

  openProject: async (path) => {
    const api = bridge();
    if (!api?.projects) {
      // Without the bridge the app still works in-memory for this run.
      set({ project: { path, name: projectNameOf(path) }, view: "session", hint: null });
      return;
    }
    try {
      get().applyProjects(await api.projects.mutate({ action: "add", path }));
      set({ view: "session", hint: null });
      void bridge()?.setTitle(`Pi Desktop — ${projectNameOf(path)}`);
      void get().inspectProject(path);
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  closeProject: () => set({ project: null, view: "welcome" }),

  loadProjects: async () => {
    const api = bridge();
    if (!api?.projects) {
      set({ projectsLoaded: true });
      return;
    }
    try {
      get().applyProjects(await api.projects.get());
    } catch {
      // Reading the project table must never break the shell.
    } finally {
      set({ projectsLoaded: true });
    }
  },

  applyProjects: (snapshot) => {
    const projects = snapshot.projects;
    const active = findProject(projects, snapshot.activeProject);
    set({
      projects,
      project: active ? { path: active.path, name: active.name } : null,
      ...(active && get().view === "welcome" ? { view: "session" as AppView } : {}),
    });
  },

  activateProject: async (path) => {
    const api = bridge();
    if (!api?.projects) return;
    try {
      get().applyProjects(await api.projects.mutate({ action: "activate", path }));
      if (path) {
        set({ view: "session", hint: null });
        void get().inspectProject(path);
      }
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  removeProject: async (path) => {
    const api = bridge();
    if (!api?.projects) return;
    try {
      get().applyProjects(await api.projects.mutate({ action: "remove", path }));
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  reorderProject: async (path, toIndex) => {
    const api = bridge();
    if (!api?.projects) return;
    try {
      get().applyProjects(await api.projects.mutate({ action: "reorder", path, toIndex }));
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  updateProjectConfig: async (path, patch) => {
    const api = bridge();
    if (!api?.projects) return;
    try {
      get().applyProjects(await api.projects.mutate({ action: "update", path, patch }));
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  inspectProject: async (path) => {
    const api = bridge();
    if (!api?.sessions) return null;
    try {
      const inspection = (await api.sessions.request({
        tabId: CONTROL_TAB_ID,
        method: "project.inspect",
        params: { cwd: path },
      })) as ProjectInspection;
      set({
        projectInspections: { ...get().projectInspections, [path]: inspection },
        projectInspectionErrors: omitKey(get().projectInspectionErrors, path),
      });
      return inspection;
    } catch (error) {
      set({
        projectInspectionErrors: {
          ...get().projectInspectionErrors,
          [path]: error instanceof Error ? error.message : String(error),
        },
      });
      return null;
    }
  },

  createBlankProject: async (input) => {
    const api = bridge();
    if (!api?.projects) {
      set({ hint: "The preload bridge is unavailable." });
      return false;
    }
    try {
      const result = await api.projects.create(input);
      get().applyProjects(result);
      if (!result.ok) {
        set({ hint: result.error ?? "the project could not be created" });
        return false;
      }
      set({ view: "session", hint: null });
      if (result.path) void get().inspectProject(result.path);
      return true;
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },

  cloneProject: async (input) => {
    const api = bridge();
    if (!api?.projects) {
      set({ hint: "The preload bridge is unavailable." });
      return false;
    }
    try {
      const result = await api.projects.clone(input);
      get().applyProjects(result);
      if (!result.ok) {
        set({ hint: result.error ?? "the repository could not be cloned" });
        return false;
      }
      set({ view: "session", hint: null });
      if (result.path) void get().inspectProject(result.path);
      return true;
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },

  quickSessionInHome: async () => {
    const home = get().info?.homeDir;
    if (!home) {
      set({ hint: "The home folder is unknown; open a project folder instead." });
      return;
    }
    await get().openProject(home);
    await get().createSessionTab();
  },

  projectAction: async (path, action) => {
    const api = bridge();
    if (!api?.projects) return false;
    try {
      return await api.projects.action({ path, action });
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },

  answerTrust: async (answer) => {
    const prompt = get().trustPrompt;
    const api = bridge();
    if (!prompt || !api?.sessions) return;
    set({ trustBusy: true });
    try {
      if (answer === "session") {
        set({ sessionTrust: [...new Set([...get().sessionTrust, prompt.cwd])] });
      }
      if (prompt.tabId) {
        // Retry the refused `session.create` with the answer; the host then
        // loads (or keeps disabled) the project's resources and emits state.
        await api.sessions.request({
          tabId: prompt.tabId,
          method: "session.create",
          params: { cwd: prompt.cwd, trust: answer },
        });
        await get().loadTabs();
        set({ trustPrompt: null, view: "session", hint: null });
      } else {
        await api.sessions.request({
          tabId: CONTROL_TAB_ID,
          method: "project.trust",
          params: { cwd: prompt.cwd, answer },
        });
        set({ trustPrompt: null, hint: null });
      }
      void get().inspectProject(prompt.cwd);
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ trustBusy: false });
    }
  },

  dismissTrust: () => set({ trustPrompt: null }),

  setHint: (hint) => set({ hint }),

  loadPrefs: async () => {
    const api = bridge();
    if (!api) {
      set({ prefsLoaded: true });
      return;
    }
    try {
      const prefs = await api.prefs.get();
      set({ prefs, prefsLoaded: true });
    } catch {
      set({ prefsLoaded: true });
    }
  },

  loadTabs: async () => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      get().applyTabs(await api.sessions.list());
    } catch {
      // Reading the tab table must never break the shell.
    }
  },

  applyTabs: (envelope) => set({ tabs: envelope.tabs, activeTabId: envelope.activeTabId }),

  applySessionEvents: (envelope) => {
    // The control host is addressed like a tab but has no transcript: its events
    // are provider-login progress and prompts (plan step 9).
    if (envelope.tabId === CONTROL_TAB_ID) {
      for (const entry of envelope.events) get().applyControlEvent(entry);
      return;
    }
    // A trust refusal is a project-level question, not transcript content: raise
    // the prompt and keep it out of the message list (plan step 10).
    const trustEntry = envelope.events.find((entry) => entry.event === "project_trust");
    if (trustEntry) {
      const status = trustEntry.payload as ProjectTrustStatus | undefined;
      const tab = get().tabs.find((entry) => entry.id === envelope.tabId);
      const cwd = status?.cwd ?? tab?.cwd ?? "";
      if (cwd) {
        set({
          trustPrompt: {
            cwd,
            tabId: envelope.tabId,
            status: status ?? {
              cwd,
              requiresTrust: true,
              decision: null,
              trusted: false,
              needsPrompt: true,
            },
          },
        });
        void get().inspectProject(cwd);
      }
    }
    const rest = envelope.events.filter((entry) => entry.event !== "project_trust");
    if (rest.length === 0) return;
    const current = get().transcripts[envelope.tabId] ?? createTranscriptState();
    set({
      transcripts: {
        ...get().transcripts,
        [envelope.tabId]: reduceSessionEvents(current, rest, envelope.seq),
      },
    });
  },

  applySessionState: (envelope) =>
    set({ sessionStates: { ...get().sessionStates, [envelope.tabId]: envelope.state } }),

  hydrateTranscript: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    const current = get().transcripts[tabId];
    if (current?.hydrated) return;
    try {
      const result = (await api.sessions.request({ tabId, method: "messages.get" })) as {
        messages?: unknown[];
      };
      const base = get().transcripts[tabId] ?? createTranscriptState();
      set({
        transcripts: {
          ...get().transcripts,
          [tabId]: hydrateMessages(base, result.messages ?? []),
        },
      });
    } catch {
      // A session that cannot report history still streams; hydration is best effort.
      const base = get().transcripts[tabId] ?? createTranscriptState();
      set({
        transcripts: { ...get().transcripts, [tabId]: { ...base, hydrated: true } },
      });
    }
  },

  abortTab: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      await api.sessions.request({ tabId, method: "abort" });
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  setSendMode: (tabId, mode) => set({ sendModes: { ...get().sendModes, [tabId]: mode } }),

  setDraft: (tabId, text) => {
    const drafts = { ...get().prefs.drafts, [tabId]: text };
    set({ prefs: { ...get().prefs, drafts } });
    if (draftPersistTimer) clearTimeout(draftPersistTimer);
    draftPersistTimer = setTimeout(() => {
      draftPersistTimer = null;
      void bridge()?.prefs.set({ drafts: useAppStore.getState().prefs.drafts });
    }, DRAFT_PERSIST_DELAY_MS);
  },

  openPicker: (picker) => set({ picker }),
  closePicker: () => set({ picker: null }),

  loadModels: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      const response = (await api.sessions.request({ tabId, method: "model.available" })) as
        | {
            models?: unknown[];
            auth?: Record<string, unknown>;
            thinkingLevels?: unknown[];
          }
        | undefined;
      set({
        modelCatalog: {
          ...get().modelCatalog,
          [tabId]: toCatalog(Array.isArray(response?.models) ? response.models : []),
        },
        providerAuth: { ...get().providerAuth, [tabId]: response?.auth ?? {} },
        thinkingLevels: {
          ...get().thinkingLevels,
          [tabId]: thinkingLevelsOf({ thinkingLevels: response?.thinkingLevels }),
        },
      });
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  setModel: async (tabId, entry, options = {}) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      const response = await api.sessions.request({
        tabId,
        method: "model.set",
        params: { model: entry.raw, persist: options.persist === true },
      });
      // A different model can mean a different set of thinking levels, so the
      // clamp is re-read from the state the host returns instead of cached.
      set({
        picker: null,
        thinkingLevels: { ...get().thinkingLevels, [tabId]: thinkingLevelsOf(response) },
      });
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  setThinking: async (tabId, level, options = {}) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      await api.sessions.request({
        tabId,
        method: "thinking.set",
        params: { level, persist: options.persist === true },
      });
      set({ picker: null });
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  cycleModel: async (tabId, direction) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      await api.sessions.request({
        tabId,
        method: "model.cycle",
        params: { direction: direction === -1 ? "backward" : "forward", persist: false },
      });
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  cycleThinking: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      await api.sessions.request({ tabId, method: "thinking.cycle", params: { persist: false } });
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  renameSession: async (tabId, name) => {
    const api = bridge();
    const trimmed = name.trim();
    if (!api?.sessions || trimmed.length === 0) return;
    try {
      await api.sessions.request({ tabId, method: "session.rename", params: { name: trimmed } });
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  toggleFavorite: (key) => {
    const favorites = toggleFavoriteModel(get().prefs.favoriteModels, key);
    set({ prefs: { ...get().prefs, favoriteModels: favorites } });
    void bridge()?.prefs.set({ favoriteModels: favorites });
  },

  setViewMode: (mode) => {
    set({ prefs: { ...get().prefs, viewMode: mode } });
    void bridge()?.prefs.set({ viewMode: mode });
  },

  sendPromptNow: async (tabId, text, options = {}) => {
    const api = bridge();
    const trimmed = text.trim();
    if (!api?.sessions || trimmed.length === 0) return false;
    const running = get().tabs.find((tab) => tab.id === tabId)?.status === "running";
    // Mirrors the host's rule (step 4): while streaming, a delivery mode is
    // required, so the caller must have chosen steer or follow-up first.
    if (running && !options.mode) return false;
    const params: Record<string, unknown> = { text: trimmed };
    if (options.images && options.images.length > 0) params.images = options.images;
    if (running && options.mode) params.streamingBehavior = options.mode;
    try {
      await api.sessions.request({ tabId, method: "prompt", params });
      get().setDraft(tabId, "");
      const history = get().draftHistory[tabId] ?? [];
      set({
        draftHistory: { ...get().draftHistory, [tabId]: [trimmed, ...history].slice(0, 50) },
        historyIndex: { ...get().historyIndex, [tabId]: -1 },
      });
      return true;
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },

  /**
   * The send path (plan step 7): a leading `/` is resolved before anything is
   * sent, so an unknown command becomes a hint instead of a literal prompt.
   */
  sendPrompt: async (tabId, text, options = {}) => {
    if (text.trim().startsWith("/")) {
      const outcome = await get().runCommandInput(tabId, text, options.preferredSource);
      // `handled` covers an executed command, a view switch and an unknown name:
      // in every one of those cases the text was consumed, not sent as prose.
      if (outcome.handled) return true;
    }
    return get().sendPromptNow(tabId, text, options);
  },

  loadCommands: async (tabId, options = {}) => {
    const cached = get().completionCommands[tabId];
    if (cached && !options.refresh) return cached;
    const api = bridge();
    if (!api?.sessions) return cached ?? [];
    try {
      const response = (await api.sessions.request({ tabId, method: "commands.list" })) as
        { commands?: HostCommandEntry[] } | undefined;
      const commands = Array.isArray(response?.commands) ? response.commands : [];
      set({ completionCommands: { ...get().completionCommands, [tabId]: commands } });
      return commands;
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
      return cached ?? [];
    }
  },

  loadFiles: async (tabId, options = {}) => {
    const cached = get().completionFiles[tabId];
    const fresh = cached !== undefined && Date.now() - cached.fetchedAt < FILE_CACHE_TTL_MS;
    if (cached && fresh && !options.refresh) return cached;
    const api = bridge();
    if (!api?.sessions) return cached ?? null;
    try {
      const response = (await api.sessions.request({ tabId, method: "files.list" })) as
        { files?: unknown; root?: unknown; truncated?: unknown } | undefined;
      const entry: FileCacheEntry = {
        files: Array.isArray(response?.files) ? response.files.map((file) => String(file)) : [],
        root: typeof response?.root === "string" ? response.root : "",
        truncated: response?.truncated === true,
        fetchedAt: Date.now(),
      };
      set({ completionFiles: { ...get().completionFiles, [tabId]: entry } });
      return entry;
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
      return cached ?? null;
    }
  },

  runCommandInput: async (tabId, text, preferredSource) => {
    const hostCommands = await get().loadCommands(tabId);
    const resolution = resolveCommandInput(text, {
      hostCommands,
      ...(preferredSource ? { preferredSource } : {}),
    });

    if (resolution.kind === "not-a-command") return { handled: false, sent: false };

    if (resolution.kind === "unknown") {
      set({ hint: `Unknown command /${resolution.name} — press / to list commands.` });
      return { handled: true, sent: false };
    }

    // Extension commands, prompt templates and /skill:* are sent as a prompt so
    // the SDK expands them; nothing is interpreted here.
    if (resolution.kind === "host") {
      const sent = await get().sendPromptNow(tabId, text);
      return { handled: true, sent };
    }

    const { name, argument, command } = resolution;
    const action = command.action;
    get().setDraft(tabId, "");

    if (action.kind === "pending") {
      set({ hint: `/${name}: ${action.message}` });
      return { handled: true, sent: false };
    }
    if (action.kind === "help") {
      set({ hint: `Commands: ${appCommandNames().join("  ·  ")}` });
      return { handled: true, sent: false };
    }
    if (action.kind === "view") {
      set({ view: action.view, hint: null });
      return { handled: true, sent: false };
    }
    if (action.kind === "picker") {
      // The model picker needs the catalog, so it is fetched as the dialog opens.
      set({ picker: action.picker, hint: null });
      if (action.picker === "model") void get().loadModels(tabId);
      return { handled: true, sent: false };
    }
    if (action.kind === "trust") {
      const cwd = get().tabs.find((tab) => tab.id === tabId)?.cwd ?? get().project?.path;
      if (!cwd) {
        set({ hint: "Open a project first — trust applies to a project folder." });
        return { handled: true, sent: false };
      }
      const raised = await get().openTrustPrompt(cwd);
      if (!raised)
        set({ hint: "This project is already trusted or ships nothing that needs a decision." });
      return { handled: true, sent: false };
    }
    if (action.kind === "browser") {
      await get().openSessionBrowser();
      return { handled: true, sent: false };
    }
    if (action.kind === "tree") {
      await get().openSessionTree(tabId);
      return { handled: true, sent: false };
    }
    if (action.kind === "fork") {
      await get().openFork(tabId);
      return { handled: true, sent: false };
    }
    if (action.kind === "export") {
      await get().exportSessionHtml(tabId);
      return { handled: true, sent: false };
    }
    if (action.requiresArgument && argument.length === 0) {
      set({ hint: `/${name} needs ${command.argumentHint ?? "an argument"}.` });
      return { handled: true, sent: false };
    }

    const api = bridge();
    if (!api?.sessions) {
      set({ hint: "The preload bridge is unavailable." });
      return { handled: true, sent: false };
    }
    try {
      await api.sessions.request({
        tabId,
        method: action.method,
        params: action.params ? action.params(argument) : {},
      });
      return { handled: true, sent: true };
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
      return { handled: true, sent: false };
    }
  },

  stopRun: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      // The RPC recipe: take the queue back first, abort, then hand the queued
      // text to the editor so a cancelled run never loses what the user typed.
      const result = (await api.sessions.request({ tabId, method: "clearQueue" })) as {
        cleared?: { steering?: string[]; followUp?: string[] };
      };
      await api.sessions.request({ tabId, method: "abort" });
      const restored = [
        ...(result?.cleared?.steering ?? []),
        ...(result?.cleared?.followUp ?? []),
      ].join("\n\n");
      if (restored.length > 0) get().setDraft(tabId, restored);
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  clearQueue: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      await api.sessions.request({ tabId, method: "clearQueue" });
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  historyStep: (tabId, direction) => {
    const history = get().draftHistory[tabId] ?? [];
    if (history.length === 0) return null;
    const current = get().historyIndex[tabId] ?? -1;
    // -1 means "the live draft"; older entries walk forward through the list.
    const next =
      direction === -1 ? Math.min(current + 1, history.length - 1) : Math.max(current - 1, -1);
    set({ historyIndex: { ...get().historyIndex, [tabId]: next } });
    return next === -1 ? null : (history[next] ?? null);
  },

  // ---- Connections: providers, credentials and sign-in (plan step 9) ----

  loadProviders: async () => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      const result = (await api.sessions.request({
        tabId: CONTROL_TAB_ID,
        method: "providers.list",
      })) as { providers?: ProviderSummary[] };
      set({ providers: result.providers ?? [], providersLoaded: true, providersError: null });
    } catch (error) {
      set({
        providersLoaded: true,
        providersError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  setProviderKey: async (providerId, apiKey) => {
    const api = bridge();
    if (!api?.sessions) throw new Error("The preload bridge is unavailable.");
    // The key travels one way: it is sent and never read back.
    await api.sessions.request({
      tabId: CONTROL_TAB_ID,
      method: "providers.setKey",
      params: { providerId, apiKey },
    });
    await get().loadProviders();
  },

  logoutProvider: async (providerId) => {
    const api = bridge();
    if (!api?.sessions) return;
    await api.sessions.request({
      tabId: CONTROL_TAB_ID,
      method: "providers.logout",
      params: { providerId },
    });
    await get().loadProviders();
  },

  startProviderLogin: async (providerId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      const result = (await api.sessions.request({
        tabId: CONTROL_TAB_ID,
        method: "providers.login",
        params: { providerId },
      })) as { loginId?: string };
      if (result?.loginId) {
        set({
          providerLogin: {
            loginId: result.loginId,
            providerId,
            status: "running",
            message: null,
            url: null,
            deviceCode: null,
            prompt: null,
          },
        });
      }
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  cancelProviderLogin: async () => {
    const login = get().providerLogin;
    const api = bridge();
    if (!login || !api?.sessions) return;
    if (login.status === "running") {
      // Abort first so the flow stops even if the dialog is gone next tick.
      try {
        await api.sessions.request({
          tabId: CONTROL_TAB_ID,
          method: "providers.cancel",
          params: { loginId: login.loginId },
        });
      } catch {
        // The flow may already have finished; the terminal event is authoritative.
      }
    }
    set({ providerLogin: null });
  },

  dismissProviderLogin: () => {
    void get().cancelProviderLogin();
  },

  answerProviderLogin: async (value) => {
    const login = get().providerLogin;
    const api = bridge();
    if (!login?.prompt || !api?.sessions) return;
    try {
      await api.sessions.request({
        tabId: CONTROL_TAB_ID,
        method: "oi.respond",
        params: { id: login.prompt.id, value },
      });
      set({ providerLogin: { ...login, prompt: null } });
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  applyControlEvent: (entry) => {
    if (entry.event === PROVIDER_LOGIN_EVENT) {
      const event = entry.payload as ProviderLoginEvent | undefined;
      if (!event) return;

      if (event.phase === "started") {
        set({
          providerLogin: {
            loginId: event.loginId,
            providerId: event.providerId,
            status: "running",
            message: null,
            url: null,
            deviceCode: null,
            prompt: null,
          },
        });
        return;
      }

      const current = get().providerLogin;
      // A late event from a previous attempt must not reopen a closed dialog.
      if (current && current.loginId !== event.loginId) return;
      const base: ProviderLoginState = current ?? {
        loginId: event.loginId,
        providerId: event.providerId,
        status: "running",
        message: null,
        url: null,
        deviceCode: null,
        prompt: null,
      };

      if (event.phase === "progress") {
        const next: ProviderLoginState = { ...base };
        if (event.event.type === "progress" || event.event.type === "info") {
          next.message = event.event.message;
        } else if (event.event.type === "auth_url") {
          next.url = event.event.url;
          next.message = event.event.instructions ?? "Finish signing in in your browser.";
          // System browser by default (plan step 9); an in-app tab is step 21.
          void bridge()?.openExternal(event.event.url);
        } else if (event.event.type === "device_code") {
          next.deviceCode = {
            userCode: event.event.userCode,
            verificationUri: event.event.verificationUri,
          };
          next.message = `Enter code ${event.event.userCode}`;
          void bridge()?.openExternal(event.event.verificationUri);
        }
        set({ providerLogin: next });
        return;
      }

      const status =
        event.phase === "done" ? "done" : event.phase === "error" ? "error" : "cancelled";
      const message =
        event.phase === "error"
          ? event.message
          : event.phase === "done"
            ? "Signed in."
            : "Cancelled.";
      set({ providerLogin: { ...base, status, message, prompt: null } });
      if (event.phase === "done") void get().loadProviders();
      return;
    }

    if (entry.event === "oi.request") {
      const payload = entry.payload as { id?: unknown; params?: unknown } | undefined;
      if (!payload || typeof payload.id !== "string" || !isProviderLoginPrompt(payload.params)) {
        return;
      }
      const login = get().providerLogin;
      if (!login || login.loginId !== payload.params.loginId) return;
      set({
        providerLogin: { ...login, prompt: { id: payload.id, prompt: payload.params.prompt } },
      });
    }
  },

  loadCustomProviders: async () => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      const result = (await api.sessions.request({
        tabId: CONTROL_TAB_ID,
        method: "providers.custom",
        params: { action: "list" },
      })) as { providers?: CustomProviderSummary[] };
      set({
        customProviders: result.providers ?? [],
        customProvidersLoaded: true,
        customProvidersError: null,
      });
    } catch (error) {
      set({
        customProvidersLoaded: true,
        customProvidersError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  saveCustomProvider: async (input) => {
    const api = bridge();
    if (!api?.sessions) throw new Error("The preload bridge is unavailable.");
    await api.sessions.request({
      tabId: CONTROL_TAB_ID,
      method: "providers.custom",
      params: { action: "set", provider: input },
    });
    await get().loadCustomProviders();
  },

  deleteCustomProvider: async (providerId) => {
    const api = bridge();
    if (!api?.sessions) return;
    await api.sessions.request({
      tabId: CONTROL_TAB_ID,
      method: "providers.custom",
      params: { action: "remove", providerId },
    });
    await get().loadCustomProviders();
  },

  // ---- Pi settings (plan step 12) ----

  loadSettings: async (options) => {
    const api = bridge();
    if (!api?.sessions) return;
    const cwd = get().project?.path ?? null;
    const current = get();
    if (!options?.refresh && current.settingsLoaded && current.settingsCwd === cwd) return;
    set({ settingsBusy: true, settingsError: null });
    try {
      const snapshot = (await api.sessions.request({
        tabId: CONTROL_TAB_ID,
        method: "settings.get",
        params: { cwd },
      })) as SettingsSnapshot;
      set(settingsStateFrom(snapshot, cwd));
    } catch (error) {
      set({ settingsBusy: false, settingsLoaded: true, settingsError: errorMessage(error) });
    }
  },

  setSetting: async (key, value, scope) => {
    const api = bridge();
    if (!api?.sessions) {
      set({ settingsError: "The preload bridge is unavailable." });
      return false;
    }
    const cwd = get().project?.path ?? null;
    set({ settingsBusy: true, settingsError: null });
    try {
      const snapshot = (await api.sessions.request({
        tabId: CONTROL_TAB_ID,
        method: "settings.set",
        params: { cwd, key, value, scope },
      })) as SettingsSnapshot;
      set(settingsStateFrom(snapshot, cwd));
      return true;
    } catch (error) {
      set({ settingsBusy: false, settingsError: errorMessage(error) });
      return false;
    }
  },

  writeRawSettings: async (scope, document) => {
    const api = bridge();
    if (!api?.sessions) {
      set({ settingsError: "The preload bridge is unavailable." });
      return false;
    }
    const cwd = get().project?.path ?? null;
    set({ settingsBusy: true, settingsError: null });
    try {
      const snapshot = (await api.sessions.request({
        tabId: CONTROL_TAB_ID,
        method: "settings.raw",
        params: { cwd, scope, document },
      })) as SettingsSnapshot;
      set(settingsStateFrom(snapshot, cwd));
      return true;
    } catch (error) {
      set({ settingsBusy: false, settingsError: errorMessage(error) });
      return false;
    }
  },

  flushSettings: async () => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      const result = (await api.sessions.request({
        tabId: CONTROL_TAB_ID,
        method: "settings.flush",
        params: { cwd: get().project?.path ?? null },
      })) as { errors?: SettingsErrorInfo[] };
      set({ settingsErrors: result.errors ?? [] });
    } catch (error) {
      set({ settingsError: errorMessage(error) });
    }
  },

  reloadSettings: async () => {
    set({ settingsExternalEdit: false });
    await get().loadSettings({ refresh: true });
  },

  checkExternalSettingsEdit: async () => {
    const api = bridge();
    const before = get().settingsMtimes;
    if (!api?.sessions || !get().settingsFiles) return false;
    try {
      const snapshot = (await api.sessions.request({
        tabId: CONTROL_TAB_ID,
        method: "settings.get",
        params: { cwd: get().project?.path ?? null },
      })) as SettingsSnapshot;
      const external =
        snapshot.files.global.mtimeMs !== before.global ||
        snapshot.files.project.mtimeMs !== before.project;
      if (external) set({ settingsExternalEdit: true });
      return external;
    } catch {
      return false;
    }
  },

  resetSetting: async (key, scope) => {
    const field = findSettingsField(key);
    if (!field) return;
    await get().setSetting(key, field.default === undefined ? undefined : field.default, scope);
  },

  resetScope: async (scope) => {
    // Global resets to Pi's documented defaults; project resets to “no overrides”.
    const document = scope === "global" ? settingsDefaultsDocument() : {};
    await get().writeRawSettings(scope, document);
  },

  effectiveSetting: (key) => {
    const settings = get().settings;
    if (!settings) return undefined;
    return getSettingsValue(mergeSettingsScopes(settings.global, settings.project), key);
  },

  // ---- Extensions hub (plan step 13) ----

  loadResources: async (options) => {
    const api = bridge();
    if (!api?.sessions) return;
    const target = resourcesTarget(get());
    const cwd = resourcesCwd(get(), target);
    const current = get();
    if (
      options?.refresh !== true &&
      current.resourcesLoaded &&
      current.resourcesTabId === target &&
      current.resourcesCwd === cwd
    ) {
      return;
    }
    set({ resourcesBusy: true, resourcesError: null });
    try {
      const raw = await api.sessions.request({
        tabId: target,
        method: "resources.list",
        params: { cwd, refresh: options?.refresh === true },
      });
      set({
        resources: sanitizeResourcesSnapshot(raw),
        resourcesLoaded: true,
        resourcesBusy: false,
        resourcesError: null,
        resourcesTabId: target,
        resourcesCwd: cwd,
      });
    } catch (error) {
      set({
        resourcesBusy: false,
        resourcesLoaded: true,
        resourcesError: errorMessage(error),
      });
    }
  },

  toggleResource: async (resource, enabled) => {
    const api = bridge();
    if (!api?.sessions) {
      set({ resourcesError: "The preload bridge is unavailable." });
      return false;
    }
    if (!get().settings) await get().loadSettings();
    const settings = get().settings;
    if (!settings) {
      set({ resourcesError: "Pi settings could not be read, so the toggle was not written." });
      return false;
    }
    const key = resource.settingsKey;
    const scope = settingsScopeForResource(resource.scope);
    const document = scope === "project" ? settings.project : settings.global;
    const currentValue = getSettingsValue(document, key);
    const entries = Array.isArray(currentValue)
      ? currentValue.filter((entry): entry is string => typeof entry === "string")
      : [];
    const next = applyResourceOverride(entries, resource.overridePath, enabled);
    const ok = await get().setSetting(key, next, scope);
    if (ok) await get().loadResources({ refresh: true });
    return ok;
  },

  reloadResources: async () => {
    const api = bridge();
    if (!api?.sessions) return;
    const target = resourcesTarget(get());
    const before = get().resources.resources;
    // A live session host reloads its whole runtime; the control host has no
    // runtime to reload, so its fresh loader *is* the reload (plan step 13).
    if (target !== CONTROL_TAB_ID) {
      try {
        await api.sessions.request({ tabId: target, method: "session.reload" });
      } catch {
        // A failed runtime reload still re-lists: the list is the source of truth.
      }
    }
    await get().loadResources({ refresh: true });
    const change = diffResources(before, get().resources.resources);
    set({ resourcesChange: isResourceChangeEmpty(change) ? null : change });
  },

  installRecommendedPackage: async (entry) => {
    const api = bridge();
    if (!api?.sessions) {
      set({ resourcesError: "The preload bridge is unavailable." });
      return false;
    }
    set({ resourcesBusy: true, resourcesError: null });
    try {
      await api.sessions.request({
        tabId: CONTROL_TAB_ID,
        method: "packages.install",
        params: { source: entry.source, scope: "global" },
      });
      await get().loadResources({ refresh: true });
      set({ resourcesBusy: false });
      return true;
    } catch (error) {
      set({
        resourcesBusy: false,
        resourcesError: `Installing ${entry.name} failed: ${errorMessage(error)}`,
      });
      return false;
    }
  },

  createSessionTab: async () => {
    const { project, setHint } = get();
    const api = bridge();
    if (!project) {
      setHint("Choose a project first — open a folder with “Open project…”, then start a session.");
      return;
    }
    if (!api?.sessions) {
      setHint("The preload bridge is unavailable.");
      return;
    }
    const input: CreateTabInput = { cwd: project.path };
    // Per-project defaults (plan step 10) travel with the create so the host can
    // apply them before the first state snapshot.
    const record = findProject(get().projects, project.path);
    if (record?.defaultModel) input.model = record.defaultModel;
    if (record?.defaultThinking) input.thinking = record.defaultThinking;
    // A project answered “Trust once” this run is passed the session-only grant so
    // a second tab never re-prompts.
    if (get().sessionTrust.includes(project.path)) input.trust = "session";
    try {
      get().applyTabs(await api.sessions.create(input));
      set({ view: "session", hint: null });
    } catch (error) {
      setHint(error instanceof Error ? error.message : String(error));
      // The host emits `project_trust` before it refuses, so the prompt is usually
      // already up; this is the fallback for a failure without the event.
      if (!get().trustPrompt) await get().openTrustPrompt(project.path);
    }
  },

  openTrustPrompt: async (cwd) => {
    const inspection = await get().inspectProject(cwd);
    if (!inspection?.trust.needsPrompt) return false;
    const tab = [...get().tabs]
      .filter((entry) => entry.cwd === cwd)
      .sort((left, right) => right.createdAt - left.createdAt)[0];
    set({
      trustPrompt: { cwd, tabId: tab?.id ?? null, status: inspection.trust },
    });
    return true;
  },

  activateTab: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    set({ activeTabId: tabId, view: "session" });
    try {
      get().applyTabs(await api.sessions.activate(tabId));
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  closeTab: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      get().applyTabs(await api.sessions.close(tabId));
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  closeActiveTab: async () => {
    const { activeTabId } = get();
    if (!activeTabId) return;
    await get().closeTab(activeTabId);
  },

  cycleTab: async (direction) => {
    const { tabs, activeTabId } = get();
    if (tabs.length < 2) return;
    const index = tabs.findIndex((tab) => tab.id === activeTabId);
    const next = tabs[(index + direction + tabs.length) % tabs.length];
    if (next) await get().activateTab(next.id);
  },

  closeOtherTabs: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      get().applyTabs(await api.sessions.closeOthers(tabId));
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  moveTab: async (tabId, toIndex) => {
    const api = bridge();
    if (!api?.sessions) return;
    // Optimistic: the strip reorders immediately, the service confirms.
    const order = [...get().tabs];
    const from = order.findIndex((tab) => tab.id === tabId);
    if (from === -1) return;
    const target = Math.max(0, Math.min(order.length - 1, Math.floor(toIndex)));
    if (target !== from) {
      const [moved] = order.splice(from, 1);
      if (moved) order.splice(target, 0, moved);
      set({ tabs: order });
    }
    try {
      get().applyTabs(await api.sessions.reorder(tabId, target));
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
      void get().loadTabs();
    }
  },

  duplicateTab: async (tabId) => {
    const tab = get().tabs.find((entry) => entry.id === tabId);
    const api = bridge();
    if (!tab || !api?.sessions) return;
    const input: CreateTabInput = { cwd: tab.cwd };
    const record = findProject(get().projects, tab.cwd);
    if (record?.defaultModel) input.model = record.defaultModel;
    if (record?.defaultThinking) input.thinking = record.defaultThinking;
    if (get().sessionTrust.includes(tab.cwd)) input.trust = "session";
    try {
      get().applyTabs(await api.sessions.create(input));
      set({ view: "session", hint: null });
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  revealSessionFile: async (tabId) => {
    const tab = get().tabs.find((entry) => entry.id === tabId);
    const api = bridge();
    if (!tab?.sessionFile || !api) {
      set({ hint: "This session has no file yet — send a message first." });
      return;
    }
    const revealed = await api.revealPath(tab.sessionFile);
    if (!revealed) set({ hint: "That session file could not be revealed." });
  },

  cloneSession: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      await api.sessions.request({ tabId, method: "session.clone" });
      // The clone is a new session file with a copied context: rebuild the view.
      get().resetTranscript(tabId);
      await get().hydrateTranscript(tabId);
      set({ hint: null });
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  // ---- Session browser (plan step 11) ----

  openSessionBrowser: async () => {
    set({ sessionBrowserOpen: true, view: "session", hint: null });
    await get().loadProjectSessions();
  },

  closeSessionBrowser: () => set({ sessionBrowserOpen: false }),

  setSessionBrowserQuery: (query) => set({ sessionBrowserQuery: query }),

  loadProjectSessions: async (options = {}) => {
    const api = bridge();
    if (!api?.sessions) return get().projectSessions;
    try {
      const response = (await api.sessions.request({
        tabId: CONTROL_TAB_ID,
        method: "session.list",
      })) as { sessions?: unknown } | undefined;
      const sessions = sanitizeSessionList(response?.sessions);
      set({
        projectSessions: sessions,
        projectSessionsLoaded: true,
        projectSessionsError: null,
      });
      return sessions;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ projectSessionsLoaded: true, projectSessionsError: message });
      if (options.refresh) set({ hint: message });
      return get().projectSessions;
    }
  },

  resumeSession: async (session) => {
    const api = bridge();
    if (!api?.sessions) return;
    const cwd = session.cwd.length > 0 ? session.cwd : (get().project?.path ?? null);
    if (!cwd) {
      set({
        hint: "That session does not record a project folder — open the folder first, then resume.",
      });
      return;
    }
    try {
      get().applyTabs(await api.sessions.create({ cwd, sessionFile: session.path }));
      set({ sessionBrowserOpen: false, view: "session", hint: null });
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  continueMostRecent: async (cwd) => {
    const sessions = await get().loadProjectSessions();
    const latest = mostRecentSessionForProject(sessions, cwd);
    if (!latest) {
      set({ hint: "No saved session in this project yet — start a new one (Ctrl+N)." });
      return;
    }
    await get().resumeSession(latest);
  },

  deleteSession: async (session) => {
    const api = bridge();
    if (!api?.sessions) return false;
    try {
      const result = await api.sessions.deleteSession(session.path);
      if (!result.ok) {
        set({ hint: result.error ?? "The session could not be deleted." });
        // A stale row is the usual cause: refresh so the list tells the truth.
        await get().loadProjectSessions({ refresh: true });
        return false;
      }
      // No tab should keep pointing at a file that is now in the trash.
      const open = get().tabs.filter((tab) => tab.sessionFile === session.path);
      for (const tab of open) await get().closeTab(tab.id);
      await get().loadProjectSessions({ refresh: true });
      set({ hint: "Session moved to the trash." });
      return true;
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },

  renameStoredSession: async (session, name) => {
    const api = bridge();
    const trimmed = name.trim();
    if (!api?.sessions || trimmed.length === 0) return;
    // An open tab owns a live `SessionManager` for this file, so renaming through
    // it updates the tab title too; a closed session goes through the control
    // host's stored-session writer.
    const openTab = get().tabs.find((tab) => tab.sessionFile === session.path);
    try {
      if (openTab) {
        await api.sessions.request({
          tabId: openTab.id,
          method: "session.rename",
          params: { name: trimmed },
        });
      } else {
        await api.sessions.request({
          tabId: CONTROL_TAB_ID,
          method: "session.rename",
          params: { sessionFile: session.path, name: trimmed },
        });
      }
      await get().loadProjectSessions({ refresh: true });
      set({ hint: null });
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  // ---- Session tree, branches and forks (plan step 11) ----
  openSessionTree: async (tabId) => {
    set({
      sessionTreeOpen: true,
      sessionTreeTabId: tabId,
      sessionTree: null,
      sessionTreeError: null,
    });
    await get().loadSessionTree(tabId);
  },

  closeSessionTree: () => set({ sessionTreeOpen: false, sessionTreeTabId: null }),

  loadSessionTree: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      const response = (await api.sessions.request({ tabId, method: "tree.get" })) as
        { tree?: unknown; leafId?: unknown } | undefined;
      set({
        sessionTree: response?.tree ?? [],
        sessionTreeLeafId: typeof response?.leafId === "string" ? response.leafId : null,
        sessionTreeError: null,
      });
    } catch (error) {
      set({ sessionTreeError: error instanceof Error ? error.message : String(error) });
    }
  },

  navigateTree: async (tabId, targetId, options = {}) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      const params: Record<string, unknown> = { targetId };
      if (options.summarize) params.summarize = true;
      if (options.label) params.label = options.label;
      const result = (await api.sessions.request({
        tabId,
        method: "session.navigateTree",
        params,
      })) as { editorText?: unknown } | undefined;
      // Branch navigation replaces the live context, so the transcript must be
      // rebuilt from `messages.get` rather than appended to.
      get().resetTranscript(tabId);
      if (typeof result?.editorText === "string" && result.editorText.length > 0) {
        get().setDraft(tabId, result.editorText);
      }
      await get().hydrateTranscript(tabId);
      await get().loadSessionTree(tabId);
      set({ sessionTreeOpen: false, hint: null });
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  setEntryLabel: async (tabId, targetId, label) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      await api.sessions.request({
        tabId,
        method: "session.setLabel",
        params: { targetId, label },
      });
      await get().loadSessionTree(tabId);
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  openFork: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      const response = (await api.sessions.request({
        tabId,
        method: "session.forkMessages",
      })) as { messages?: Array<{ entryId?: unknown; text?: unknown }> } | undefined;
      const messages = (response?.messages ?? []).flatMap((entry) =>
        typeof entry.entryId === "string" && typeof entry.text === "string"
          ? [{ entryId: entry.entryId, text: entry.text }]
          : [],
      );
      set({ forkOpen: true, forkCandidates: messages });
      if (messages.length === 0) set({ hint: "Nothing to fork from yet." });
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  closeFork: () => set({ forkOpen: false, forkCandidates: [] }),

  forkFrom: async (tabId, entryId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      await api.sessions.request({ tabId, method: "session.fork", params: { entryId } });
      get().resetTranscript(tabId);
      await get().hydrateTranscript(tabId);
      set({ forkOpen: false, forkCandidates: [], hint: null });
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  exportSessionHtml: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      const result = (await api.sessions.request({
        tabId,
        method: "session.exportHtml",
      })) as { path?: unknown } | undefined;
      const path = typeof result?.path === "string" ? result.path : null;
      if (!path) {
        set({ hint: "The session was exported but the file path was not reported." });
        return;
      }
      await api.revealPath(path);
      set({ hint: `Exported to ${path}` });
    } catch (error) {
      set({ hint: error instanceof Error ? error.message : String(error) });
    }
  },

  resetTranscript: (tabId) => {
    set({
      transcripts: { ...get().transcripts, [tabId]: createTranscriptState() },
    });
  },
}));

/** Imperative access for non-React callers (menu commands, keyboard shortcuts). */
export const appStore = useAppStore;
