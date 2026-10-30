import { create } from "zustand";
import { toast } from "sonner";
import type { AppInfo, WebTabOpenInput } from "../../../shared/ipc";
import type { BlobRef, HostMethod } from "../../../shared/host-protocol";
import { DEFAULT_PREFS, type UiPrefs, type ViewMode } from "../../../shared/prefs";
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
import { normalizeScopePatterns, scopeKeys, scopeStarKeys } from "../../../shared/model-scope";
import { mostRecentTabForFolder, sameFolder } from "../../../shared/rail-scope";
import type { CustomProviderInput, CustomProviderSummary } from "../../../shared/custom-providers";
import {
  findSettingsField,
  getSettingsValue,
  mergeSettingsScopes,
  settingsDefaultsDocument,
  type SettingsValue,
} from "../../../shared/settings-schema";
import {
  sanitizeCheckpointState,
  type CheckpointAction,
  type CheckpointActionResult,
  type CheckpointPreviewState,
  type CheckpointState,
} from "../../../shared/checkpoints";
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
  type TabKind,
  type TabRecord,
} from "../../../shared/session-ipc";
import {
  EMPTY_TUI_SURFACE,
  TUI_STATE_EVENT,
  sanitizeTuiSurfaceSnapshot,
  type TuiSurfaceSnapshot,
} from "../../../shared/tui-surface";
import {
  firstLoopbackUrl,
  sanitizeWebUrl,
  type WebCommand,
  type WebNavigationAction,
  type WebNavigationRequest,
  type WebTabBounds,
  type WebTabState,
} from "../../../shared/web-tabs";
import {
  sanitizeMarkdownTransformResult,
  sanitizeRenderedFrame,
  type MarkdownTransformRequest,
  type MarkdownTransformResult,
  type RenderRequest,
  type RenderedFrame,
} from "../../../shared/extension-render";
import {
  EMPTY_EXTENSION_UI,
  EXTENSION_UI_NOTIFY_EVENT,
  EXTENSION_UI_REQUEST_EVENT,
  EXTENSION_UI_STATE_EVENT,
  EXTENSION_UI_THEME_EVENT,
  SESSION_SHUTDOWN_REQUEST_EVENT,
  parseExtensionDialogRequest,
  parseExtensionNotification,
  sanitizeCompletionSuggestions,
  sanitizeExtensionUiSnapshot,
  type ExtensionCompletionApplyRequest,
  type ExtensionCompletionRequest,
  type ExtensionCompletionResult,
  type ExtensionCompletionSuggestions,
  type ExtensionDialogRequest,
  type ExtensionNotification,
  type ExtensionUiSnapshot,
} from "../../../shared/extension-ui";
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
  emptyIntegrationsState,
  officeBridgePackageSource,
  sanitizeIntegrationsState,
  type IntegrationsState,
  type OfficeIntegrationRecordPatch,
} from "../../../shared/integrations";
import {
  EMPTY_THEMES,
  activeThemeSwatches,
  sanitizeThemesSnapshot,
  themeCssVariables,
  type ThemesSnapshot,
} from "../../../shared/themes";
import {
  officeDocumentScope,
  officeDocumentTag,
  type OfficeDocumentPane,
  type OfficeDocumentsView,
} from "../../../shared/office-documents";
import { sanitizeKeybindingsSnapshot, type KeybindingsSnapshot } from "../../../shared/keybindings";
import {
  EMPTY_SHORTCUTS,
  sanitizeShortcutsSnapshot,
  type ShortcutsSnapshot,
} from "../../../shared/shortcuts";
import {
  PACKAGES_CHANGED_EVENT,
  PACKAGE_PROGRESS_EVENT,
  normalizePackageSource,
  pinnedPackageSource,
  sanitizePackageProgress,
  sanitizePackagesSnapshot,
  unpinnedPackageSource,
  type PackageProgressEvent,
  type PackageScope,
  type PackageSummary,
} from "../../../shared/packages";
import {
  applyPromptOrigins,
  createTranscriptState,
  hydrateMessages,
  reduceSessionEvents,
  textOfPartial,
  transcriptTextOf,
  type TranscriptState,
} from "../session/session-events";
import { rememberPromptOrigin } from "../../../shared/prompt-origin";
import { appCommandNames, resolveCommandInput } from "../completion/dispatch";
import type { HostCommandEntry } from "../completion/command-source";
import type { FileListSnapshot } from "../completion/file-source";
import { appArgumentItems } from "../completion/app-arguments";
import { collapsePastes, expandPasteMarkers, pasteMarkerText } from "../session/paste-markers";
import type { CompletionItem, CompletionSource } from "../completion/types";
import {
  isUnsupportedCommandComplete,
  parseCommandCompleteResult,
  parseCommandRunResult,
  type CommandArgumentItem,
} from "../../../shared/commands";
import {
  findExactModelEntry,
  thinkingLevelsOf,
  toCatalog,
  type ModelCatalogEntry,
} from "../session/model-catalog";
import { classifyFailure, isOfflineError } from "../../../shared/diagnostics";
import type { DiagnosticsSnapshot } from "../../../shared/diagnostics";
import { sanitizeUpdateState, type UpdateState } from "../../../shared/updates";
import {
  clampRailSplit,
  clampRailWidth,
  sanitizeRailMenuOrder,
  type RailCollapsedGroup,
  type RailMenuId,
  type RailSplitPrefs,
} from "../../../shared/rail";
import {
  isMutatingGitAction,
  sanitizeGitSnapshot,
  type GitAction,
  type GitActionResult,
  type GitCommitEntry,
  type GitDiff,
  type GitDiffRequest,
  type GitSnapshot,
} from "../../../shared/git";
import {
  firstOnboardingStep,
  nextOnboardingStep,
  previousOnboardingStep,
  type OnboardingStep,
} from "../../../shared/onboarding";
import type { ProfileMode } from "../../../shared/profile";

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
  "welcome" | "session" | "settings" | "extensions" | "connections" | "skills" | "diagnostics";

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

/**
 * The last extension `setEditorText`/`pasteToEditor` sequence applied per tab
 * (plan step 16). A host-issued edit is applied exactly once, so a state push
 * that repeats it cannot clobber the user's typing.
 */
const appliedEditorSeq = new Map<string, number>();

/** Per-tab debounce for the `oi.editorText` mirror, so typing is not one frame per key. */
const editorTextTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Extension dialog timeouts. The extension's `opts.timeout` must fire even when
 * its tab is in the background (the inline dock unmounts then), so the store
 * owns the timer instead of the component's countdown.
 */
const extensionDialogTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearExtensionDialogTimer(id: string): void {
  const timer = extensionDialogTimers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  extensionDialogTimers.delete(id);
}

/** Drop every queued dialog whose tab is no longer open. */
function purgeClosedTabDialogs(openTabs: ReadonlySet<string>): void {
  for (const dialog of useAppStore.getState().extensionDialogs) {
    if (!openTabs.has(dialog.tabId)) clearExtensionDialogTimer(dialog.id);
  }
  useAppStore.setState({
    extensionDialogs: useAppStore
      .getState()
      .extensionDialogs.filter((dialog) => openTabs.has(dialog.tabId)),
  });
}

/** In-flight ensures, so focus + click + first keystroke share one activation. */
const sessionEnsuring = new Map<string, Promise<boolean>>();
/** Last successful interaction-driven activation per tab (throttles keystrokes). */
const sessionEnsuredAt = new Map<string, number>();
/** Minimum gap between non-forced ensures; a send/tab switch always forces. */
export const SESSION_ENSURE_THROTTLE_MS = 2_000;
/** Minimum gap between window-focus/visibility reconciliations. */
const SESSION_RESYNC_THROTTLE_MS = 1_000;
let lastSessionResyncAt = 0;
let lastScopeSyncAt = 0;
export const EDITOR_TEXT_DELAY_MS = 250;

export const APP_VIEWS: readonly AppView[] = [
  "welcome",
  "session",
  "settings",
  "extensions",
  "connections",
  "skills",
  "diagnostics",
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

/** One folder's commit-log page (git-checkpoint plan step 9). */
export interface GitLogPage {
  entries: GitCommitEntry[];
  loading: boolean;
  /** True when the last page filled the window, so "Load more" is useful. */
  hasMore: boolean;
}

/** Most project folders whose snapshot the store keeps. */
export const MAX_GIT_SNAPSHOTS = 5;
/** One commit-log page (mirrors the main-process default). */
export const GIT_LOG_PAGE_SIZE = 30;
const EMPTY_GIT_LOG_PAGE: GitLogPage = { entries: [], loading: false, hasMore: false };

export interface BlobState {
  status: "loading" | "ready" | "error";
  /** The raw spilled JSON, present once `ready`. */
  contents?: string;
  error?: string;
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
  /** Projects whose settings toggle is being written. */
  projectSettingsBusy: Record<string, boolean>;
  /** The trust prompt currently on screen, if any. */
  trustPrompt: TrustPrompt | null;
  trustBusy: boolean;
  /** Projects trusted for this app run only (`Trust once`). */
  sessionTrust: string[];
  prefs: UiPrefs;
  /** True once preferences have been read from the main process. */
  prefsLoaded: boolean;
  /**
   * The first-run onboarding step on screen (plan step 26), or null when the
   * wizard is closed. Completion lives in `prefs.onboardingCompletedAt`.
   */
  onboardingStep: OnboardingStep | null;
  paletteOpen: boolean;
  info: AppInfo | null;
  /**
   * Persistent explanation for a renderer that is newer than the running main
   * process (2026-10-25 model-scope plan). Restarting the app loads the current
   * main build; a raw `session: unsupported host method …` error is not shown.
   */
  mainOutdated: string | null;
  /** Transient, user-visible explanation for an action that is not wired yet. */
  hint: string | null;
  /** A connectivity failure the user should see until it is dismissed or a call works. */
  offlineNotice: string | null;
  /**
   * Per-tab stale-host explanation (2026-10-24 stale-host plan). Persistent
   * until the tab is restarted, a completion succeeds, or `session.recovered`.
   */
  staleHosts: Record<string, string>;
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
  /**
   * Pasted bodies behind the composer's `[paste #N …]` markers (plan step 20).
   * Renderer memory only: never persisted, so a 2 MB paste cannot reach
   * `app-state.json` (D15).
   */
  pasteBodies: Record<string, Record<number, string>>;
  pasteCounter: number;
  /** Registers a large paste and returns the marker to insert. */
  registerPaste: (tabId: string, text: string) => string;
  /** Replaces every known marker with its body (used before sending). */
  expandPastes: (tabId: string, text: string) => string;

  /** Expanded editor (plan step 21): a large in-app textarea for the draft. */
  expandedEditorOpen: boolean;
  expandedEditorError: string | null;
  expandedEditorBusy: boolean;
  openExpandedEditor: (tabId: string) => void;
  closeExpandedEditor: () => void;
  /** Writes the edited text back into the composer draft. */
  saveExpandedEditor: (tabId: string, text: string) => void;
  /** Opens the configured OS editor and waits for it (best effort). */
  openExternalEditor: (tabId: string) => Promise<void>;

  /** `/share` and `/bug` (plan step 18). */
  shareOpen: boolean;
  shareMode: "share" | "bug";
  shareStatus: "idle" | "running" | "done" | "error";
  shareResult: {
    gistUrl?: string;
    viewerUrl?: string;
    file?: string;
    path?: string;
    bytes?: number;
  } | null;
  shareError: string | null;
  shareErrorCode: string | null;
  shareIncludeTranscript: boolean;
  shareHint: string | null;
  openShare: (tabId: string) => Promise<void>;
  openBugReport: (tabId: string, hint?: string) => Promise<void>;
  setShareIncludeTranscript: (include: boolean) => void;
  runBugReport: () => Promise<void>;
  closeShare: () => void;

  /** `/changelog` (plan step 15): Pi's packaged changelog text. */
  changelogOpen: boolean;
  changelogPath: string | null;
  changelogText: string | null;
  changelogError: string | null;
  openChangelog: () => Promise<void>;
  closeChangelog: () => void;

  /** The fork dialog's candidates (Pi's `get_fork_messages`). */
  forkOpen: boolean;
  forkCandidates: Array<{ entryId: string; text: string }>;

  /** `/session` (plan step 12): the live `stats.get` payload for one tab. */
  sessionInfoOpen: boolean;
  sessionInfoTabId: string | null;
  sessionInfoData: SessionInfoView | null;
  sessionInfoError: string | null;
  openSessionInfo: (tabId: string) => Promise<void>;
  closeSessionInfo: () => void;
  /** `/copy` and `Ctrl+X`: the last assistant answer, without touching the composer. */
  copyLastAssistant: (tabId: string) => Promise<boolean>;

  setView: (view: AppView) => void;
  /**
   * Which section of the Extensions hub to reveal after navigation (plan step
   * 19). The Integrations menu item routes here, since Pi for Office has no
   * primary-navigation surface of its own.
   */
  extensionsFocus: "integrations" | null;
  /** Opens the Extensions hub on the Integrations card. */
  focusIntegrations: () => void;
  clearExtensionsFocus: () => void;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
  setPrefs: (patch: Partial<UiPrefs>) => void;
  /** Opens the onboarding wizard at the first step that still matters. */
  startOnboarding: () => void;
  setOnboardingStep: (step: OnboardingStep) => void;
  nextOnboarding: () => void;
  previousOnboarding: () => void;
  /** Hides the wizard without marking it done, so it returns next launch. */
  dismissOnboarding: () => void;
  /** Marks the flow done (or explicitly skipped) in preferences. */
  completeOnboarding: () => Promise<void>;
  /**
   * Persists the profile choice. Returns true when the running app still uses
   * the old mode, so the wizard can offer a restart.
   */
  chooseProfileMode: (mode: ProfileMode) => Promise<boolean>;
  /** Relaunches the app (a profile change is applied on the next launch). */
  relaunchApp: () => Promise<void>;
  toggleSidebar: () => void;
  setInfo: (info: AppInfo) => void;
  openProject: (path: string) => Promise<void>;
  closeProject: () => void;
  /** Loads the remembered project list and restores the active project. */
  loadProjects: () => Promise<void>;
  /** Applies a project-list snapshot returned by any `projects.*` call. */
  applyProjects: (snapshot: { projects: ProjectRecord[]; activeProject: string | null }) => void;
  activateProject: (path: string | null, options?: { focusSession?: boolean }) => Promise<void>;
  /**
   * Points the rail and the sidebar at `cwd` after a session was chosen (2026-10-30
   * project-scoped rail plan). A remembered project is activated through main so
   * the choice persists; a cwd that was never saved stays renderer-local.
   */
  selectProjectForCwd: (cwd: string) => Promise<void>;
  /**
   * Jumps into a project's most recently active **open** tab, or clears the
   * selection when the folder has none (the rail keeps the project's scope).
   */
  focusProjectSession: (path: string) => Promise<void>;
  /** Clears the active tab without closing one (`session:deactivate`). */
  clearActiveTab: () => Promise<void>;
  removeProject: (path: string) => Promise<void>;
  reorderProject: (path: string, toIndex: number) => Promise<void>;
  updateProjectConfig: (path: string, patch: ProjectConfigPatch) => Promise<void>;
  /** Inspects a project folder through the control host (plan step 10). */
  inspectProject: (path: string) => Promise<ProjectInspection | null>;
  /** Enables/disables project-scoped settings and reloads the affected hosts. */
  setProjectSettingsEnabled: (path: string, enabled: boolean) => Promise<boolean>;
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
  /**
   * Records a failed operation: sets the transient hint and, when the message
   * looks like a network failure, raises the persistent offline banner
   * (plan step 22). Every user-visible catch path funnels through here.
   */
  noteFailure: (error: unknown) => void;
  /** Marks a tab's host as too old for command completion, once per tab. */
  noteStaleHost: (tabId: string) => void;
  /** Clears the stale-host banner for a tab (restart, recovery, success). */
  clearStaleHost: (tabId: string) => void;
  /** Clears the offline banner (a retry worked, or the user dismissed it). */
  clearOffline: () => void;
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
  /** Stops and re-spawns a tab's host, resuming its session (plan step 22). */
  restartTab: (tabId: string) => Promise<void>;
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
    options?: {
      mode?: SendMode;
      images?: PromptImage[];
      preferredSource?: CompletionSource;
      promptOrigin?: string;
    },
  ) => Promise<boolean>;
  /** Sends without command routing (used by the dispatch table itself). */
  sendPromptNow: (
    tabId: string,
    text: string,
    options?: { mode?: SendMode; images?: PromptImage[]; promptOrigin?: string },
  ) => Promise<boolean>;
  /** `clearQueue` then `abort`, restoring the queued text into the draft. */
  stopRun: (tabId: string) => Promise<void>;
  clearQueue: (tabId: string) => Promise<void>;
  abortRetry: (tabId: string) => Promise<void>;
  abortCompaction: (tabId: string) => Promise<void>;
  historyStep: (tabId: string, direction: 1 | -1) => string | null;

  /** Completion engine (plan step 7). */
  completionCommands: Record<string, HostCommandEntry[]>;
  completionFiles: Record<string, FileCacheEntry>;
  loadCommands: (tabId: string, options?: { refresh?: boolean }) => Promise<HostCommandEntry[]>;
  /** Drops a tab's cached command list so the next lookup refetches it. */
  invalidateCommands: (tabId: string) => void;
  /** Runs `commands.complete` for one extension command's argument prefix. */
  completeCommandArguments: (
    tabId: string,
    name: string,
    prefix: string,
  ) => Promise<CommandArgumentItem[] | null>;
  /** Runs the app-owned completers for `/model`, `/thinking` and `/login`. */
  completeAppCommandArguments: (
    tabId: string,
    name: string,
    prefix: string,
  ) => Promise<CompletionItem[] | null>;
  loadFiles: (tabId: string, options?: { refresh?: boolean }) => Promise<FileListSnapshot | null>;
  /**
   * Runs a submitted `/command`. `handled: false` means the text is not a
   * command and the caller should treat it as a prompt; `sent: false` with
   * `handled: true` means the app consumed it (view switch, hint).
   */
  runCommandInput: (
    tabId: string,
    text: string,
    options?: { preferredSource?: CompletionSource; mode?: SendMode; images?: PromptImage[] },
  ) => Promise<CommandOutcome>;

  /** Model, thinking and usage UX (plan step 8). */
  modelCatalog: Record<string, ModelCatalogEntry[]>;
  providerAuth: Record<string, Record<string, unknown>>;
  thinkingLevels: Record<string, string[]>;
  /** `provider/id` keys of the live session scope (Pi's `enabledModels`). */
  modelScope: Record<string, string[]>;
  /** Persisted patterns behind each tab's stars. */
  modelScopePatterns: Record<string, string[]>;
  /** The project toggle's write target for each tab. */
  modelScopeTarget: Record<string, "global" | "project">;
  /** The model key a star toggle is currently writing, per tab. */
  modelScopeBusy: Record<string, string | null>;
  picker: PickerKind | null;
  pickerError: string | null;
  /** Initial search text for the model picker (`/model <query>`). */
  pickerSearch: string;
  loadModels: (tabId: string) => Promise<void>;
  /** Applies a host/model-scope snapshot to one tab. */
  setModelScopeSnapshot: (
    tabId: string,
    payload: { enabledModels?: unknown; scoped?: unknown },
  ) => void;
  setModel: (
    tabId: string,
    entry: ModelCatalogEntry,
    options?: { persist?: boolean },
  ) => Promise<void>;
  setThinking: (tabId: string, level: string, options?: { persist?: boolean }) => Promise<void>;
  cycleModel: (tabId: string, direction: 1 | -1) => Promise<void>;
  cycleThinking: (tabId: string) => Promise<void>;
  renameSession: (tabId: string, name: string) => Promise<void>;
  /**
   * Adds/removes one model in Pi's scope (`enabledModels`). Persists the
   * rewrite, applies it to this tab, then refreshes every other open tab.
   */
  toggleModelScope: (tabId: string, provider: string, id: string) => Promise<void>;
  /** Re-reads `enabledModels` into each open session (no write). */
  applyModelScopeToTabs: (exceptTabId?: string) => Promise<void>;
  /** Pushes the persisted queue modes into every open Pi tab (plan step 9). */
  applyQueueModeToTabs: (exceptTabId?: string) => Promise<void>;
  /** `clearQueue` and put every queued message back in the draft (Alt+Up). */
  restoreQueue: (tabId: string) => Promise<void>;
  /** Pulls enabledModels from disk into every live tab (focus/reload). */
  syncModelScopesFromDisk: () => Promise<void>;
  setViewMode: (mode: ViewMode) => void;
  openPicker: (picker: PickerKind, options?: { search?: string }) => void;
  closePicker: () => void;
  /** What `/login <provider>` asked Connections to show, consumed by the view. */
  connectionsFocus: { providerId?: string; query?: string } | null;
  openConnections: (focus?: { providerId?: string; query?: string }) => void;
  clearConnectionsFocus: () => void;

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
  reloadSettings: () => Promise<void>; /** Compares the files' mtimes with the loaded snapshot; true when they differ. */
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
   * One-click install of a recommended package: opens the consent dialog. The
   * actual install happens in `confirmPackageConsent` once the user has seen
   * the exact source (plan step 14).
   */
  installRecommendedPackage: (entry: RecommendedPackage) => void;

  /**
   * Install the Office bridge through the package manager (plan step 19): opens
   * the same consent dialog a manual install uses and records the consented
   * install in app state.
   */
  installOfficeBridge: () => void;

  /** Integrations (plan step 19): the app's record of consented installs. */
  integrations: IntegrationsState;
  integrationsLoaded: boolean;
  loadIntegrations: () => Promise<void>;
  /** Records a consented install / completed setup (validated in main). */
  recordOfficeIntegration: (patch: OfficeIntegrationRecordPatch) => Promise<void>;
  /** Opens (or focuses) the Office session tab, which owns the bridge port. */
  openOfficeSession: () => Promise<void>;
  /**
   * Makes `tabId` the single Office host (plan step 20): demotes any other
   * `office` tab and restarts this host on port 38617, resuming its session.
   */
  promoteToOfficeHost: (tabId: string) => Promise<boolean>;

  /** The live Office pane registry (plan step 20), pushed from main's poll. */
  officeDocuments: OfficeDocumentsView | null;
  /**
   * True while a bridge promotion is in flight. The takeover restarts two hosts
   * and re-binds a port, so a second click must not start it again.
   */
  promotingOfficeHost: boolean;
  officeDocumentsLoaded: boolean;
  /** The app-wide diagnostics snapshot (plan step 22), null until first loaded. */
  diagnostics: DiagnosticsSnapshot | null;
  diagnosticsError: string | null;
  /**
   * The updater's state (plan step 26), null until first read. Unsigned builds
   * report `supported: false`, so the banner can say so instead of pretending a
   * check ran.
   */
  update: UpdateState | null;
  loadUpdateState: () => Promise<void>;
  /** Applies a pushed updater state from main. */
  applyUpdateState: (state: unknown) => void;
  /** Starts a check; a no-op in a build with no feed. */
  checkForUpdates: () => Promise<void>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  /**
   * Bodies of spilled large payloads, fetched on demand and cached by blob path
   * (plan step 24). A 50 MB tool result never crosses the event frame; it is
   * read only when its card is rendered open.
   */
  blobs: Record<string, BlobState>;
  /** Fetches a spilled payload's body once and caches it. */
  loadBlob: (tabId: string, ref: BlobRef) => Promise<void>;
  loadDiagnostics: () => Promise<void>;
  /**
   * The docked panel rail. Its open/active-menu/width/order state lives in
   * `prefs.rail`, so the layout survives a relaunch: the strip is always
   * mounted, and `open` means "the panel body is expanded".
   */
  /** Toggles the panel body, leaving `activeMenu` alone (the menu command). */
  toggleRail: () => void;
  setRailOpen: (open: boolean) => void;
  /**
   * Expands the panel on one menu without toggling it. Used by Go → Source
   * Control / Checkpoints / Documents and by the palette.
   */
  openRailMenu: (id: RailMenuId) => void;
  /**
   * The strip's click: switches to that menu and expands, or collapses it when
   * it is already the active, open menu.
   */
  toggleRailMenu: (id: RailMenuId) => void;
  /** Persists an adjusted strip order (drag-drop or the per-entry menu). */
  setRailMenuOrder: (order: readonly RailMenuId[]) => void;
  /** Persists a clamped rail width (the resize handle commits on release). */
  setRailWidth: (width: number) => void;
  /**
   * Persists the Source Control menu's block split (plan step 2). The splitters
   * call this **once per gesture** — a drag commits on release, a keyboard nudge
   * commits per key — so the persisted layout never churns mid-drag.
   */
  setRailSplit: (split: RailSplitPrefs) => void;
  /**
   * Folds one collapsible Source Control group away (or unfolds it). `group` is
   * the stable key, not an index, so a new group cannot shift the others.
   */
  setSourceControlCollapsed: (group: RailCollapsedGroup, collapsed: boolean) => void;
  loadOfficeDocuments: () => Promise<void>;
  applyOfficeDocuments: (view: OfficeDocumentsView) => void;
  refreshOfficeDocuments: () => Promise<void>;
  /**
   * Starts or appends a `[office:<host> "<name>" id=…]`-tagged prompt in the
   * active session's composer draft (plan step 20). Returns the tab it targeted,
   * or null when no session is open.
   */
  chatAboutDocument: (pane: OfficeDocumentPane) => string | null;

  /**
   * Source control (git-checkpoint plan step 9).
   *
   * Keyed by project folder rather than by tab, because two tabs can share one
   * folder and a project with no tab open still has a rail. The map is bounded
   * (`MAX_GIT_SNAPSHOTS`) so a long app session cannot grow it without limit.
   */
  git: Record<string, GitSnapshot>;
  /** A failed git operation worth showing in the rail (cleared on success). */
  gitError: string | null;
  /** The folder whose snapshot main is polling, or null when none is. */
  gitWatched: string | null;
  /** The diff open in the viewer, with the request that produced it. */
  /** The diff open in the viewer, with the folder and request behind it. */
  gitDiff: { projectPath: string; request: GitDiffRequest; diff: GitDiff } | null;
  gitDiffLoading: boolean;
  /** The commit log per folder, with its paging state. */
  gitLog: Record<string, GitLogPage>;
  /** Reads a folder's snapshot (main memoises it). */
  loadGit: (projectPath: string) => Promise<void>;
  /** Applies a snapshot pushed from main, or returned by a request. */
  applyGitSnapshot: (snapshot: unknown) => void;
  /** Re-reads now, bypassing main's memo. */
  refreshGit: (projectPath: string) => Promise<void>;
  /**
   * Watches one folder and stops watching the previous one, so a tab switch or a
   * closed rail costs nothing. `null` stops watching.
   */
  watchGit: (projectPath: string | null) => Promise<void>;
  /** Runs an action, then refreshes the snapshot and reports a failure inline. */
  runGitAction: (projectPath: string, action: GitAction) => Promise<GitActionResult>;
  /** Opens the diff viewer for one side, loading it into the store. */
  openGitDiff: (projectPath: string, request: GitDiffRequest) => Promise<void>;
  closeGitDiff: () => void;
  /** Loads (or appends to) a folder's commit log. */
  loadGitLog: (projectPath: string, options?: { more?: boolean }) => Promise<void>;
  /**
   * HEAD's complete commit message, for the amend box. Resolves null when there
   * is no commit yet; the box then leaves the message empty rather than
   * inventing one.
   */
  loadHeadCommitMessage: (projectPath: string) => Promise<string | null>;
  /** Dismisses the rail's error line. */
  clearGitError: () => void;

  /**
   * One consent per session for mutating git writes (plan D13). Staging,
   * committing, discarding, branching and stashing all run through
   * {@link performGitAction}, which asks once and then remembers.
   */
  gitConsentGranted: boolean;
  /** The write waiting for that consent, or null when nothing is pending. */
  gitConsentPrompt: { projectPath: string; action: GitAction } | null;
  /**
   * Runs an action, asking for consent first when it mutates the repository.
   * Resolves null when the action was gated and is waiting for that consent.
   */
  performGitAction: (projectPath: string, action: GitAction) => Promise<GitActionResult | null>;
  /** Grants the session's consent and runs the waiting write. */
  confirmGitConsent: () => Promise<void>;
  cancelGitConsent: () => void;
  /** Local branch names per folder, for the checkout menu. */
  gitBranches: Record<string, string[]>;
  loadGitBranches: (projectPath: string) => Promise<void>;

  /**
   * Folder checkpoints (git-checkpoint plan step 21).
   *
   * Keyed by project folder, like `git`, and bounded the same way: only the
   * recent few folders are ever on screen. The `undoRestore` ref is kept
   * separately because it belongs to a *toast*, not to a timeline row — the
   * pre-restore snapshot is real, but offering to restore it from the list
   * would be confusing.
   */
  checkpoints: Record<string, CheckpointState>;
  /** A failed checkpoint action worth showing in the section. */
  checkpointsError: string | null;
  /** Hydrates the section on mount (and after a relaunch, before any push). */
  loadCheckpoints: (projectPath: string) => Promise<void>;
  /** Applies a pushed state, or one returned by a request. */
  applyCheckpointState: (state: unknown) => void;
  /** Re-reads the timeline now. */
  refreshCheckpoints: (projectPath: string) => Promise<void>;
  /** Takes a manual snapshot. */
  createCheckpoint: (projectPath: string, label?: string) => Promise<CheckpointActionResult>;
  /** What a restore would change, for the confirm dialog. */
  previewCheckpoint: (projectPath: string, ref: string) => Promise<CheckpointPreviewState | null>;
  /**
   * Restores one checkpoint. Main always snapshots `pre-restore` first, and the
   * returned ref becomes {@link checkpointsUndoRef} so the toast can offer Undo.
   */
  restoreCheckpoint: (
    projectPath: string,
    ref: string,
    options?: { removeAdded?: boolean },
  ) => Promise<CheckpointActionResult>;
  /** Restores the pre-restore snapshot from the last restore (the Undo action). */
  undoRestoreCheckpoint: (projectPath: string) => Promise<CheckpointActionResult>;
  /** Drops checkpoints past the configured limits. */
  pruneCheckpoints: (projectPath: string) => Promise<CheckpointActionResult>;
  /**
   * The pre-restore ref the last successful restore produced, per folder. Kept
   * outside the timeline so "Undo restore" survives a refresh.
   */
  checkpointsUndoRef: Record<string, string>;
  /** Dismisses the section's error line. */
  clearCheckpointsError: () => void;
  /**
   * The one path every checkpoint action takes: sends it, refreshes the
   * timeline, and surfaces a failure without throwing (the section renders the
   * message). Public because the rail calls it for actions with no dedicated
   * wrapper, and because a test can assert the single dispatch point.
   */
  runCheckpointAction: (
    projectPath: string,
    action: CheckpointAction,
  ) => Promise<CheckpointActionResult>;

  /** Web tabs (plan step 21): the live state of each isolated page view. */
  webTabStates: Record<string, WebTabState>;
  /** A navigation main refused because it leaves the review, awaiting an answer. */
  webNavigationPrompt: WebNavigationRequest | null;
  /** Whether the manual "Open URL in a tab…" dialog is open. */
  webUrlDialogOpen: boolean;
  /** Applies one pushed web-tab state. */
  applyWebTabState: (state: WebTabState) => void;
  /** Opens a page in a web tab, reusing an existing tab for the same URL. */
  openWebTab: (input: WebTabOpenInput) => Promise<boolean>;
  /**
   * Opens a loopback URL a notification or tool result mentioned (plan step 21),
   * without stealing focus from a tab that already shows it.
   */
  openLoopbackUrl: (url: string, sessionTabId: string | null) => void;
  /** Runs a chrome command against a web tab. */
  webCommand: (tabId: string, command: WebCommand) => void;
  /** Records the rectangle the native view occupies; fire-and-forget. */
  setWebTabBounds: (tabId: string, bounds: WebTabBounds) => void;
  /** Answers a pending navigation request (in-tab, new tab, browser, dismiss). */
  answerWebNavigation: (action: WebNavigationAction) => Promise<void>;
  /** Drops the pending navigation request without acting. */
  dismissWebNavigation: () => void;
  openWebUrlDialog: () => void;
  closeWebUrlDialog: () => void;

  /** Packages (plan step 14): what Pi is configured to load, and its state. */
  packages: PackageSummary[];
  packagesLoaded: boolean;
  packagesBusy: boolean;
  packagesError: string | null;
  /** The project context the list was read for. */
  packagesCwd: string | null;
  /** The progress frame of the operation currently running, if any. */
  packageProgress: PackageProgressEvent | null;
  /** The pending consent dialog, or null when nothing is waiting. */
  packageConsent: PackageConsentRequest | null;
  loadPackages: (options?: { refresh?: boolean }) => Promise<void>;
  /** Opens the consent dialog for an install; nothing is installed yet. */
  requestPackageInstall: (
    source: string,
    scope: PackageScope,
    cwd?: string | null,
    options?: { integration?: "office" },
  ) => void;
  /** Opens the consent dialog for an update (one package, or all with null). */
  requestPackageUpdate: (source: string | null, scope: PackageScope, cwd?: string | null) => void;
  /** Sends the consent the dialog displayed and runs the operation. */
  confirmPackageConsent: () => Promise<boolean>;
  cancelPackageConsent: () => void;
  removePackage: (summary: PackageSummary, cwd?: string | null) => Promise<boolean>;
  /** Reinstall at the installed version (npm only); opens the consent dialog. */
  pinPackage: (summary: PackageSummary, cwd?: string | null) => void;
  /** Reinstall floating on latest (npm only); opens the consent dialog. */
  unpinPackage: (summary: PackageSummary, cwd?: string | null) => void;

  /** Themes (plan step 15): the catalogue with the active theme marked. */
  themes: ThemesSnapshot;
  themesLoaded: boolean;
  themesBusy: boolean;
  themesError: string | null;
  loadThemes: (options?: { refresh?: boolean }) => Promise<void>;
  /** Activates a theme through the `theme` setting, then recolours the chrome. */
  setActiveTheme: (name: string) => Promise<boolean>;
  /** Imports a `.json` theme file into the profile and selects it. */
  importTheme: (filename: string, content: string) => Promise<boolean>;

  /** Keybindings (plan step 15): the profile's overrides with validation. */
  keybindings: KeybindingsSnapshot | null;
  keybindingsLoaded: boolean;
  keybindingsBusy: boolean;
  keybindingsError: string | null;
  loadKeybindings: (options?: { refresh?: boolean }) => Promise<void>;
  saveKeybindings: (bindings: Record<string, string[]>) => Promise<boolean>;
  resetKeybindings: () => Promise<void>;

  /** Extension shortcuts (plan step 15): listed from the live session. */
  shortcuts: ShortcutsSnapshot;
  shortcutsLoaded: boolean;
  shortcutsBusy: boolean;
  shortcutsError: string | null;
  /**
   * The tab the current `shortcuts` were listed from. `loadShortcuts` reuses
   * them for that tab and only refetches for another tab or a `refresh`, so a
   * tab activation costs one request at most (mirrors `resourcesTabId`).
   */
  shortcutsTabId: string | null;
  loadShortcuts: (options?: { refresh?: boolean }) => Promise<void>;
  invokeShortcut: (key: string) => Promise<boolean>;
  /** The shortcuts help dialog (Ctrl+/). */
  shortcutsHelpOpen: boolean;
  setShortcutsHelpOpen: (open: boolean) => void;
  /** Inserts `/skill:<name>` into the active session's composer. */
  runSkill: (name: string) => void;
  /** Recolours the chrome from the active Pi theme (data-theme + tokens). */
  applyChromeTheme: () => void;

  /** Extension UI (plan step 16): per-tab state pushed by each session host. */
  extensionUi: Record<string, ExtensionUiSnapshot>;
  /** Dialogs waiting for an answer, oldest first. */
  extensionDialogs: ExtensionDialogRequest[];
  /** Notification history (the toast centre's backing list). */
  extensionNotifications: ExtensionNotification[];
  /** Fetches `oi.state` for a tab (called on activation). */
  loadExtensionUi: (tabId: string) => Promise<void>;
  /** Applies one `oi.*` host event (dialog, notification, state, theme, shutdown). */
  handleExtensionUiEvent: (tabId: string, entry: SessionEventEntry) => void;
  /** Answers a dialog through `oi.respond`; `cancelled` closes it unanswered. */
  answerExtensionDialog: (
    dialog: ExtensionDialogRequest,
    answer: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ) => Promise<void>;
  clearExtensionNotifications: () => void;
  /** Mirrors the composer text back to the host for `ctx.ui.getEditorText()`. */
  reportEditorText: (tabId: string, text: string) => void;
  /** Runs extension autocomplete providers in the host (plan step 16). */
  extensionCompletion: (
    tabId: string,
    request: ExtensionCompletionRequest,
  ) => Promise<ExtensionCompletionSuggestions | null>;
  /** Applies the extension chain's own completion to the buffer. */
  extensionApplyCompletion: (
    tabId: string,
    request: ExtensionCompletionApplyRequest,
  ) => Promise<ExtensionCompletionResult | null>;

  /**
   * Extension TUI surface (plan step 17): per-tab ANSI frames rendered by
   * `ctx.ui.custom()` and the footer/editor slots. `EMPTY_TUI_SURFACE` means no
   * extension component is mounted, so the composer behaves as before.
   */
  tuiSurfaces: Record<string, TuiSurfaceSnapshot>;
  /** Fetches `tui.state` for a tab (called on activation). */
  loadTuiSurface: (tabId: string) => Promise<void>;
  /** Reports the renderer's measured grid so overlays re-resolve. */
  resizeTuiSurface: (tabId: string, rows: number, cols: number) => void;
  /** Sends raw terminal bytes to the tab's focused component. */
  sendTuiInput: (tabId: string, data: string) => void;

  /**
   * Extension-owned renderers (plan step 18). `extensionRender` runs a
   * registered `renderCall`/`renderResult`/message/entry renderer in the host
   * and returns its ANSI frame; `null`/`rendered:false` means the item has no
   * renderer and the native card stays. `extensionMarkdown` applies the
   * registered markdown transformers before the renderer parses assistant text.
   */
  extensionRender: (tabId: string, request: RenderRequest) => Promise<RenderedFrame | null>;
  extensionMarkdown: (
    tabId: string,
    request: MarkdownTransformRequest,
  ) => Promise<MarkdownTransformResult | null>;
  /**
   * The app's expand-all state per tab (plan step 18). `null`/absent means each
   * card keeps its own default (an error card starts open); a boolean forces
   * every tool card. `app.tools.expand` and the view mode drive it.
   */
  toolsExpanded: Record<string, boolean | null>;
  /** Flips expand-all for a tab and mirrors it to `ctx.ui.getToolsExpanded()`. */
  toggleToolsExpanded: (tabId: string) => void;

  createSessionTab: (kind?: TabKind) => Promise<void>;
  activateTab: (tabId: string) => Promise<void>;
  /**
   * Ensures a tab has a live host and an open session. Interaction calls it
   * without a status gate; `force` bypasses the throttle (send/tab switch).
   */
  ensureSession: (tabId: string, options?: { force?: boolean }) => Promise<boolean>;
  /** Reconciles the tab table after sleep/resume/window focus, then ensures the active tab. */
  resyncSessions: () => Promise<void>;
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
    options?: {
      summarize?: boolean;
      label?: string;
      customInstructions?: string;
      replaceInstructions?: boolean;
    },
  ) => Promise<void>;
  /** Cancels an in-flight branch summary (plan step 17). */
  abortBranchSummary: (tabId: string) => Promise<void>;
  /** True while `navigateTree` is summarizing; the row offers Cancel. */
  sessionTreeBusy: boolean;
  setEntryLabel: (tabId: string, targetId: string, label: string | null) => Promise<void>;
  /** The fork dialog: Pi's user messages, then fork at the chosen entry. */
  openFork: (tabId: string) => Promise<void>;
  closeFork: () => void;
  forkFrom: (tabId: string, entryId: string) => Promise<void>;
  /** Export the session to HTML and reveal the written file. */
  exportSessionHtml: (tabId: string) => Promise<void>;
  /** JSONL export (`/export jsonl`, plan step 14). */
  exportSessionJsonl: (tabId: string) => Promise<void>;
  /** A pending `/import`: the path is confirmed before the session is replaced. */
  importPrompt: { tabId: string; path: string } | null;
  /** Picks a JSONL file (or uses `path`) and asks for confirmation. */
  requestImport: (tabId: string, path?: string) => Promise<void>;
  confirmImport: () => Promise<void>;
  cancelImport: () => void;
}

/** Why a tab's `/session` dialog is empty or failed. */
export interface SessionInfoView {
  tabId: string;
  sessionId: string | null;
  sessionFile: string | null;
  sessionName: string | null;
  cwd: string;
  model: { id?: string; provider?: string; name?: string } | null;
  thinkingLevel: string | null;
  messageCount: number;
  toolCount: number;
  streaming: boolean;
  pendingMessages: number;
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | null;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    cost: number;
  } | null;
  steeringMode: string | null;
  followUpMode: string | null;
  autoCompaction: boolean;
  autoRetry: boolean;
}

/** How long a `files.list` result is reused before it is fetched again. */
export const FILE_CACHE_TTL_MS = 30_000;

/**
 * Persistent, per-tab explanation for a host that predates
 * `commands.complete` (2026-10-24 stale-host plan). A banner, not a hint: the
 * silent empty menu is what made the original failure look like a routing bug.
 */
export const HOST_STALE_MESSAGE =
  "This session's host is a stale build, so command suggestions or model scope may be unavailable. Restart the session to load the current host build.";

/**
 * A renderer that hot-reloaded after a main-process build once showed the
 * model-scope stars while main still rejected `model.scope.toggle` (2026-10-25).
 * The banner names the real fix: restart the app, not the session.
 */
export const MAIN_OUTDATED_MESSAGE =
  "This window is newer than the app's main process, so model scope is unavailable. Restart the app (in development, restart `npm run dev`) to load the current build.";

/** The host methods model scope needs from the main process's allowlist. */
export const REQUIRED_MAIN_METHODS: readonly HostMethod[] = [
  "model.scope.apply",
  "model.scope.toggle",
];

/**
 * Whether the loaded `AppInfo` says main accepts `method`. Before `AppInfo`
 * arrives (`null`) the answer is "unknown, let the call through": a real old
 * main is then classified from the error by `toggleModelScope`, so a slow
 * `getAppInfo` cannot disable the star with a false banner.
 */
export function mainSupports(info: AppInfo | null, method: HostMethod): boolean {
  if (!info) return true;
  return Array.isArray(info.hostMethods) && info.hostMethods.includes(method);
}

/** The main-process side of the old-main failure (thrown by `src/main/ipc.ts`). */
function isMainUnsupportedScopeError(message: string): boolean {
  return /unsupported host method model\.scope\.(?:apply|toggle)/i.test(message);
}

/** The banner message for a loaded `AppInfo` that predates model scope. */
export function mainOutdatedMessage(info: AppInfo | null): string | null {
  if (!info) return null;
  return REQUIRED_MAIN_METHODS.some((method) => !mainSupports(info, method))
    ? MAIN_OUTDATED_MESSAGE
    : null;
}

/** True when a request failed because the live host predates the method. */
function isStaleHostError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    /(?:not implemented yet|unknown method): (?:commands\.complete|model\.scope\.(?:apply|toggle))/i.test(
      message,
    ) || /(?:the |changing the )?model scope is not supported/i.test(message)
  );
}

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

/**
 * A package operation waiting for the user to acknowledge what it will run
 * (plan step 14). The dialog shows `source` verbatim; confirming echoes it back,
 * so the host refuses anything the user did not actually see.
 */
export interface PackageConsentRequest {
  kind: "install" | "update";
  /** The normalised source, exactly as the dialog shows it. */
  source: string;
  /** The package name for the heading (`*` for update-all). */
  name: string;
  scope: PackageScope;
  cwd: string | null;
  /**
   * Set when this install is an integration's package (plan step 19), so a
   * successful run can be recorded in app state. The dialog is unchanged.
   */
  integration?: "office";
}

function bridge(): Window["pi"] | undefined {
  return typeof window === "undefined" ? undefined : window.pi;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Element-wise comparison for the small string lists the host reports. */
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
 * Host events that belong to the extension UI rather than the transcript (plan
 * step 16). `extension_error` is deliberately absent: it renders as a notice.
 */
const EXTENSION_UI_EVENTS = new Set<string>([
  EXTENSION_UI_REQUEST_EVENT,
  EXTENSION_UI_STATE_EVENT,
  // `oi.notify` is deliberately absent: command output is transcript content
  // (2026-10-24 command parity plan). `handleExtensionUiEvent` still archives it
  // and toasts warnings/errors.
  EXTENSION_UI_THEME_EVENT,
  SESSION_SHUTDOWN_REQUEST_EVENT,
  // The extension TUI surface (plan step 17) is rendered by its own component,
  // never by the transcript reducer.
  TUI_STATE_EVENT,
]);

/**
 * Warnings and errors get transient attention; info output already lands in the
 * transcript (Pi parity). The history panel keeps every notification.
 */
function notifyToast(message: string, type: ExtensionNotification["type"]): void {
  if (type === "error") toast.error(message);
  else if (type === "warning") toast.warning(message);
}

/** Records one executed send in the draft history, exactly once. */
function rememberDraft(tabId: string, text: string): void {
  const trimmed = text.trim();
  const history = useAppStore.getState().draftHistory[tabId] ?? [];
  useAppStore.setState({
    draftHistory: {
      ...useAppStore.getState().draftHistory,
      [tabId]: [trimmed, ...history].slice(0, 50),
    },
    historyIndex: { ...useAppStore.getState().historyIndex, [tabId]: -1 },
  });
}

/**
 * Every send that clears the composer bumps its tab's sequence. A late refusal
 * restores the text only when no newer send has started, so an old rejection
 * can never clobber a draft the user typed afterwards (2026-10-26 composer plan).
 */
const draftSendSequences = new Map<string, number>();

function beginDraftSend(tabId: string): number {
  const sequence = (draftSendSequences.get(tabId) ?? 0) + 1;
  draftSendSequences.set(tabId, sequence);
  return sequence;
}

/** Puts a refused send back above anything typed since it was cleared. */
function restoreDraftAfterRefusal(tabId: string, previous: string, sequence: number): void {
  if (previous.length === 0 || draftSendSequences.get(tabId) !== sequence) return;
  const store = useAppStore.getState();
  const current = store.prefs.drafts[tabId] ?? "";
  if (current === previous) return;
  store.setDraft(tabId, current.length > 0 ? `${previous}\n\n${current}` : previous);
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

/** The write target for a tab's model/scope/thinking settings. */
export function settingsTargetForTab(
  state: Pick<AppStateShape, "tabs" | "projects">,
  tabId: string,
): SettingsScope {
  const tab = state.tabs.find((entry) => entry.id === tabId);
  return settingsTargetForProject(state, tab?.cwd ?? null);
}

/** The write target for a project path. Default is the shared global file. */
export function settingsTargetForProject(
  state: Pick<AppStateShape, "projects">,
  path: string | null | undefined,
): SettingsScope {
  const project = findProject(state.projects, path ?? null);
  return project?.useProjectSettings === true ? "project" : "global";
}

/**
 * The project context packages are listed/installed for: the active project, or
 * the active session tab's folder when the project list is not loaded.
 */
function packageCwd(state: AppStateShape): string | null {
  const active = state.tabs.find((tab) => tab.id === state.activeTabId);
  return state.project?.path ?? active?.cwd ?? null;
}

export const useAppStore = create<AppStateShape>()((set, get) => ({
  view: "welcome",
  project: null,
  projects: [],
  projectsLoaded: false,
  projectInspections: {},
  projectInspectionErrors: {},
  projectSettingsBusy: {},
  trustPrompt: null,
  trustBusy: false,
  sessionTrust: [],
  prefs: { ...DEFAULT_PREFS },
  prefsLoaded: false,
  onboardingStep: null,
  paletteOpen: false,
  extensionsFocus: null,
  info: null,
  mainOutdated: null,
  hint: null,
  offlineNotice: null,
  staleHosts: {},
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
  sessionTreeBusy: false,
  forkOpen: false,
  forkCandidates: [],
  importPrompt: null,
  pasteBodies: {},
  pasteCounter: 1,
  expandedEditorOpen: false,
  expandedEditorError: null,
  expandedEditorBusy: false,
  shareOpen: false,
  shareMode: "share",
  shareStatus: "idle",
  shareResult: null,
  shareError: null,
  shareErrorCode: null,
  shareIncludeTranscript: false,
  shareHint: null,
  changelogOpen: false,
  changelogPath: null,
  changelogText: null,
  changelogError: null,
  sessionInfoOpen: false,
  sessionInfoTabId: null,
  sessionInfoData: null,
  sessionInfoError: null,
  sendModes: {},
  draftHistory: {},
  historyIndex: {},
  completionCommands: {},
  completionFiles: {},
  modelCatalog: {},
  providerAuth: {},
  thinkingLevels: {},
  modelScope: {},
  modelScopePatterns: {},
  modelScopeTarget: {},
  modelScopeBusy: {},
  picker: null,
  pickerError: null,
  pickerSearch: "",
  connectionsFocus: null,
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
  packages: [],
  packagesLoaded: false,
  packagesBusy: false,
  packagesError: null,
  packagesCwd: null,
  packageProgress: null,
  packageConsent: null,
  integrations: emptyIntegrationsState(),
  integrationsLoaded: false,
  officeDocuments: null,
  officeDocumentsLoaded: false,
  promotingOfficeHost: false,
  diagnostics: null,
  diagnosticsError: null,
  update: null,
  blobs: {},
  git: {},
  gitError: null,
  gitWatched: null,
  gitDiff: null,
  gitDiffLoading: false,
  gitLog: {},
  gitConsentGranted: false,
  gitConsentPrompt: null,
  gitBranches: {},
  checkpoints: {},
  checkpointsError: null,
  checkpointsUndoRef: {},
  webTabStates: {},
  webNavigationPrompt: null,
  webUrlDialogOpen: false,
  themes: EMPTY_THEMES,
  themesLoaded: false,
  themesBusy: false,
  themesError: null,
  keybindings: null,
  keybindingsLoaded: false,
  keybindingsBusy: false,
  keybindingsError: null,
  shortcuts: EMPTY_SHORTCUTS,
  shortcutsLoaded: false,
  shortcutsBusy: false,
  shortcutsError: null,
  shortcutsTabId: null,
  shortcutsHelpOpen: false,
  extensionUi: {},
  extensionDialogs: [],
  extensionNotifications: [],
  tuiSurfaces: {},
  toolsExpanded: {},

  setView: (view) =>
    set({
      view,
      hint: null,
      // A `/login` focus belongs to the Connections visit that created it.
      ...(view === "connections" ? {} : { connectionsFocus: null }),
    }),
  focusIntegrations: () => set({ view: "extensions", extensionsFocus: "integrations", hint: null }),
  clearExtensionsFocus: () => set({ extensionsFocus: null }),
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set({ paletteOpen: !get().paletteOpen }),

  setPrefs: (patch) => {
    const prefs = { ...get().prefs, ...patch };
    set({ prefs });
    void bridge()?.prefs.set(patch);
  },

  toggleSidebar: () => get().setPrefs({ sidebarCollapsed: !get().prefs.sidebarCollapsed }),

  setInfo: (info) => set({ info, mainOutdated: mainOutdatedMessage(info) }),

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
      get().noteFailure(error);
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

  activateProject: async (path, options = {}) => {
    const api = bridge();
    if (!api?.projects) return;
    try {
      get().applyProjects(await api.projects.mutate({ action: "activate", path }));
      if (!path) return;
      set({ view: "session", hint: null });
      void get().inspectProject(path);
      // The rail is project-scoped (2026-10-30 plan), so selecting a project also
      // selects a session in it. `focusSession: false` is for callers that are
      // about to create a session themselves ("New session here"): clearing the
      // selection first would flash Welcome.
      if (options.focusSession !== false) await get().focusProjectSession(path);
    } catch (error) {
      get().noteFailure(error);
    }
  },

  selectProjectForCwd: async (cwd) => {
    if (cwd.length === 0) return;
    const current = get().project;
    if (current && sameFolder(current.path, cwd)) return;
    const known = findProject(get().projects, cwd);
    if (!known) {
      // A session can run in a folder that was never saved as a project; the rail
      // still needs a scope, so the ref is set locally and never persisted.
      set({ project: { path: cwd, name: projectNameOf(cwd) } });
      return;
    }
    const api = bridge();
    if (!api?.projects) {
      set({ project: { path: known.path, name: known.name } });
      return;
    }
    try {
      get().applyProjects(await api.projects.mutate({ action: "activate", path: known.path }));
    } catch (error) {
      // A session click must still move the rail even if the project write fails.
      set({ project: { path: known.path, name: known.name } });
      get().noteFailure(error);
    }
  },

  focusProjectSession: async (path) => {
    const tab = mostRecentTabForFolder(get().tabs, path);
    if (tab) {
      await get().activateTab(tab.id);
      return;
    }
    await get().clearActiveTab();
  },

  clearActiveTab: async () => {
    const api = bridge();
    const activeId = get().activeTabId;
    set({ activeTabId: null });
    if (!api?.sessions || activeId === null) return;
    try {
      get().applyTabs(await api.sessions.deactivate());
    } catch (error) {
      // Losing a cleared selection is harmless; the tabs themselves are intact.
      get().noteFailure(error);
    }
  },

  removeProject: async (path) => {
    const api = bridge();
    if (!api?.projects) return;
    try {
      get().applyProjects(await api.projects.mutate({ action: "remove", path }));
    } catch (error) {
      get().noteFailure(error);
    }
  },

  reorderProject: async (path, toIndex) => {
    const api = bridge();
    if (!api?.projects) return;
    try {
      get().applyProjects(await api.projects.mutate({ action: "reorder", path, toIndex }));
    } catch (error) {
      get().noteFailure(error);
    }
  },

  updateProjectConfig: async (path, patch) => {
    const api = bridge();
    if (!api?.projects) return;
    try {
      get().applyProjects(await api.projects.mutate({ action: "update", path, patch }));
    } catch (error) {
      get().noteFailure(error);
    }
  },

  setProjectSettingsEnabled: async (path, enabled) => {
    const api = bridge();
    if (!api?.projects || !api.sessions) {
      set({ hint: "The preload bridge is unavailable." });
      return false;
    }
    if (get().projectSettingsBusy[path]) return false;
    set({ projectSettingsBusy: { ...get().projectSettingsBusy, [path]: true } });
    try {
      const result = await api.projects.setSettings({ path, enabled });
      get().applyProjects(result);
      await get().inspectProject(path);
      await get().loadSettings({ refresh: true });
      await get().applyModelScopeToTabs();
      if (get().resourcesLoaded) await get().loadResources({ refresh: true });
      if (get().packagesLoaded) await get().loadPackages({ refresh: true });

      // The whole project document changed: reload any live tab rooted there so
      // non-scope settings (theme, extensions, tools) also take effect.
      const targets = get().tabs.filter(
        (tab) =>
          tab.cwd === path &&
          tab.kind !== "web" &&
          (tab.status === "idle" || tab.status === "running"),
      );
      await Promise.all(
        targets.map(async (tab) => {
          try {
            await api.sessions.request({ tabId: tab.id, method: "session.reload" });
          } catch {
            return undefined;
          }
          await Promise.all([get().loadExtensionUi(tab.id), get().loadTuiSurface(tab.id)]);
          get().invalidateCommands(tab.id);
          return undefined;
        }),
      );
      if (targets.length > 0) await get().loadShortcuts({ refresh: true });

      const message = !enabled
        ? result.saved
          ? "Project settings saved and disabled; using global settings."
          : "Using global settings for this project."
        : result.restored
          ? "Project settings restored."
          : result.keptCurrent
            ? "Project settings enabled; the current project file was kept."
            : "Project settings enabled.";
      toast.success(message);
      return true;
    } catch (error) {
      get().noteFailure(error);
      return false;
    } finally {
      const busy = { ...get().projectSettingsBusy };
      delete busy[path];
      set({ projectSettingsBusy: busy });
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
      get().noteFailure(error);
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
      get().noteFailure(error);
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
      get().noteFailure(error);
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
      get().noteFailure(error);
    } finally {
      set({ trustBusy: false });
    }
  },

  dismissTrust: () => set({ trustPrompt: null }),

  setHint: (hint) => set({ hint }),

  noteFailure: (error) => {
    const message = error instanceof Error ? error.message : String(error);
    set({
      hint: message,
      ...(isOfflineError(message) ? { offlineNotice: message } : {}),
    });
    // Report to main so the failure shows up in Diagnostics (plan step 22).
    // Fire-and-forget: reporting a failure must never itself surface an error.
    void bridge()
      ?.diagnostics?.record({
        kind: classifyFailure(message),
        message,
        ...(error instanceof Error && error.stack ? { detail: error.stack } : {}),
      })
      .catch(() => undefined);
  },

  clearOffline: () => set({ offlineNotice: null }),

  noteStaleHost: (tabId) => {
    if (get().staleHosts[tabId]) return;
    set({ staleHosts: { ...get().staleHosts, [tabId]: HOST_STALE_MESSAGE } });
    // Record once, directly with the tab id. `noteFailure` would add a
    // transient hint on top of the banner and lose the tab association.
    void bridge()
      ?.diagnostics?.record({
        kind: "host_stale",
        message: HOST_STALE_MESSAGE,
        tabId,
      })
      .catch(() => undefined);
  },

  clearStaleHost: (tabId) => {
    if (!(tabId in get().staleHosts)) return;
    const { [tabId]: _removed, ...rest } = get().staleHosts;
    set({ staleHosts: rest });
  },

  loadPrefs: async () => {
    const api = bridge();
    if (!api) {
      set({ prefsLoaded: true });
      return;
    }
    try {
      const prefs = await api.prefs.get();
      set({ prefs, prefsLoaded: true });
      // Preferences can arrive after a transcript was already hydrated (tabs and
      // history load independently). Re-annotate it, so a reopened command
      // prompt is collapsed without fetching history again.
      if (Object.keys(prefs.promptOrigins).length > 0) {
        set((state) => ({
          transcripts: Object.fromEntries(
            Object.entries(state.transcripts).map(([tabId, transcript]) => [
              tabId,
              applyPromptOrigins(transcript, prefs.promptOrigins),
            ]),
          ),
        }));
      }
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

  applyTabs: (envelope) => {
    const ids = new Set(envelope.tabs.map((tab) => tab.id));
    // A tab that went to sleep or errored must re-check on the next interaction;
    // a `ready` state change does not clear an in-flight ensure's timestamp.
    const previousStatus = new Map(get().tabs.map((tab) => [tab.id, tab.status]));
    for (const tab of envelope.tabs) {
      if (previousStatus.get(tab.id) === tab.status) continue;
      if (tab.status === "stopped" || tab.status === "crashed" || tab.status === "failed") {
        sessionEnsuredAt.delete(tab.id);
      }
    }
    // Web-tab state and any pending navigation belong to a tab that still
    // exists; a closed tab must not leave a stale native view or dialog behind.
    const webTabStates = Object.fromEntries(
      Object.entries(get().webTabStates).filter(([id]) => ids.has(id)),
    );
    const prompt = get().webNavigationPrompt;
    set({
      tabs: envelope.tabs,
      activeTabId: envelope.activeTabId,
      webTabStates,
      ...(prompt && !ids.has(prompt.tabId) ? { webNavigationPrompt: null } : {}),
    });
  },

  applySessionEvents: (envelope) => {
    // The control host is addressed like a tab but has no transcript: its events
    // are provider-login progress and prompts (plan step 9).
    if (envelope.tabId === CONTROL_TAB_ID) {
      for (const entry of envelope.events) get().applyControlEvent(entry);
      return;
    }
    if (envelope.events.some((entry) => entry.event === "session.recovered")) {
      get().clearStaleHost(envelope.tabId);
      get().invalidateCommands(envelope.tabId);
    }
    // An extension (or `/clone`, `/new`, `/import`) can replace the session
    // behind this tab. When the session id actually changed, the old transcript
    // belongs to a different conversation: reset it and hydrate the new one
    // (plan step 13). A same-id rebind keeps its rows and just says so.
    const replaced = envelope.events.filter((entry) => entry.event === "session_replaced").at(-1);
    let replacedReset = false;
    if (replaced) {
      const next = (replaced.payload ?? {}) as { sessionId?: string | null };
      const nextId = typeof next.sessionId === "string" ? next.sessionId : null;
      const previous = (
        get().sessionStates[envelope.tabId] as { sessionId?: string | null } | undefined
      )?.sessionId;
      const previousId = typeof previous === "string" ? previous : null;
      if (nextId !== null && nextId !== previousId) {
        get().resetTranscript(envelope.tabId);
        get().invalidateCommands(envelope.tabId);
        void get().hydrateTranscript(envelope.tabId);
        replacedReset = true;
      }
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
    // Extension UI events are not transcript content: dialogs, notifications,
    // status/widget snapshots and theme switches are applied here (plan step 16).
    for (const entry of envelope.events) get().handleExtensionUiEvent(envelope.tabId, entry);
    const modelScopeChange = envelope.events
      .filter((entry) => entry.event === "model_scope_changed")
      .at(-1);
    if (modelScopeChange) {
      get().setModelScopeSnapshot(
        envelope.tabId,
        (modelScopeChange.payload ?? {}) as { enabledModels?: unknown; scoped?: unknown },
      );
    }
    const rest = envelope.events.filter(
      (entry) =>
        entry.event !== "project_trust" &&
        entry.event !== "model_scope_changed" &&
        // A replaced session's notice would land on the fresh transcript before
        // hydration and read as if something went wrong; the rows themselves
        // are the announcement (plan step 13).
        !(replacedReset && entry.event === "session_replaced") &&
        !EXTENSION_UI_EVENTS.has(entry.event),
    );
    if (rest.length === 0) return;
    // Extension output can carry a review URL too (a tool result, not only a
    // notification); open loopback URLs the same way (plan step 21).
    for (const entry of rest) {
      if (entry.event !== "tool_execution_end") continue;
      const payload = entry.payload as { result?: unknown } | undefined;
      const loopback = firstLoopbackUrl(textOfPartial(payload?.result));
      if (loopback) get().openLoopbackUrl(loopback, envelope.tabId);
    }
    const current = get().transcripts[envelope.tabId] ?? createTranscriptState();
    // Persist command-prompt origins so reopening the session keeps the
    // collapsed row. The live transcript already carries the host tag; the map
    // is only for hydration after an app restart (2026-10-26 composer plan).
    let promptOrigins = get().prefs.promptOrigins;
    let originsChanged = false;
    for (const entry of rest) {
      if (entry.event !== "message_start") continue;
      const payload = (entry.payload ?? {}) as { promptOrigin?: unknown; message?: unknown };
      if (typeof payload.promptOrigin !== "string" || payload.promptOrigin.length === 0) continue;
      if ((payload.message as { role?: unknown } | undefined)?.role !== "user") continue;
      promptOrigins = rememberPromptOrigin(
        promptOrigins,
        transcriptTextOf(payload.message),
        payload.promptOrigin,
      );
      originsChanged = true;
    }
    if (originsChanged) get().setPrefs({ promptOrigins });
    set({
      transcripts: {
        ...get().transcripts,
        [envelope.tabId]: reduceSessionEvents(current, rest, envelope.seq),
      },
    });
  },

  applySessionState: (envelope) => {
    // A model switch can change the thinking levels a session accepts. The host
    // sends them in every snapshot, but `ThinkingPicker` prefers this cache, so
    // refresh it here — and only when the list actually changed, because this
    // runs on every state frame (including `message_end` while streaming).
    const state = envelope.state as { thinkingLevels?: unknown } | null | undefined;
    const levels = Array.isArray(state?.thinkingLevels) ? thinkingLevelsOf(state) : null;
    const cached = get().thinkingLevels[envelope.tabId];
    const thinkingLevels =
      levels && (!cached || levels.length !== cached.length || !sameStrings(levels, cached))
        ? { ...get().thinkingLevels, [envelope.tabId]: levels }
        : get().thinkingLevels;
    set({
      sessionStates: { ...get().sessionStates, [envelope.tabId]: envelope.state },
      thinkingLevels,
    });
  },

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
          [tabId]: hydrateMessages(base, result.messages ?? [], get().prefs.promptOrigins),
        },
      });
    } catch {
      // A session that cannot report history still streams, so this is best
      // effort — but a failed read must not be cached as "no history": after a
      // relaunch the host may still be starting, and the view retries hydration
      // when the tab status changes (plan step 25).
      const base = get().transcripts[tabId] ?? createTranscriptState();
      set({
        transcripts: { ...get().transcripts, [tabId]: { ...base, hydrated: false } },
      });
    }
  },

  abortTab: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      await api.sessions.request({ tabId, method: "abort" });
    } catch (error) {
      get().noteFailure(error);
    }
  },

  restartTab: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    // The banner's action is an explicit fix; drop it before the IPC so it disappears
    // immediately and a failed restart surfaces through `noteFailure` instead.
    get().clearStaleHost(tabId);
    try {
      await api.sessions.restart(tabId);
      // The host is new, so the transcript has to be rebuilt from `messages.get`
      // on the next view (history lives in the JSONL, not in this window).
      const base = get().transcripts[tabId];
      if (base) {
        set({
          transcripts: { ...get().transcripts, [tabId]: { ...base, hydrated: false } },
        });
      }
      // A restarted host rebinds its extensions, so any shortcut registered by
      // the fresh session must be re-listed (the previous list may be stale).
      if (get().activeTabId === tabId) void get().loadShortcuts({ refresh: true });
      get().invalidateCommands(tabId);
      // A restart is also the documented fix for a bridge that never bound the
      // port (2026-10-30 rail-headers plan), so read the registry now instead of
      // leaving the Documents panel on the old probe until the next 5 s poll.
      void get().refreshOfficeDocuments();
    } catch (error) {
      get().noteFailure(error);
    }
  },

  loadExtensionUi: async (tabId) => {
    const api = bridge();
    if (!api?.sessions || tabId === CONTROL_TAB_ID) return;
    try {
      const result = await api.sessions.request({ tabId, method: "oi.state" });
      const snapshot = sanitizeExtensionUiSnapshot(result);
      set({ extensionUi: { ...get().extensionUi, [tabId]: snapshot } });
      if (snapshot.title && get().activeTabId === tabId) void api.setTitle(snapshot.title);
    } catch {
      // A host without the extension UI port still streams; keep the empty state.
      set({ extensionUi: { ...get().extensionUi, [tabId]: { ...EMPTY_EXTENSION_UI } } });
    }
  },

  handleExtensionUiEvent: (tabId, entry) => {
    if (entry.event === TUI_STATE_EVENT) {
      // The whole surface is pushed after every change, so no reconciliation.
      set({
        tuiSurfaces: { ...get().tuiSurfaces, [tabId]: sanitizeTuiSurfaceSnapshot(entry.payload) },
      });
      return;
    }
    if (entry.event === EXTENSION_UI_STATE_EVENT) {
      const snapshot = sanitizeExtensionUiSnapshot(entry.payload);
      const previousTitle = get().extensionUi[tabId]?.title ?? null;
      set({ extensionUi: { ...get().extensionUi, [tabId]: snapshot } });
      // An extension can force the expand state (`ctx.ui.setToolsExpanded`), so
      // the app's Ctrl+O state follows a non-null snapshot value (plan step 18).
      if (snapshot.toolsExpanded !== null) {
        set({ toolsExpanded: { ...get().toolsExpanded, [tabId]: snapshot.toolsExpanded } });
      }
      // `ctx.ui.setTitle` sets the window title while its tab is focused.
      if (snapshot.title && snapshot.title !== previousTitle && get().activeTabId === tabId) {
        void bridge()?.setTitle(snapshot.title);
      }
      const command = snapshot.editor;
      if (command && command.seq > (appliedEditorSeq.get(tabId) ?? 0)) {
        appliedEditorSeq.set(tabId, command.seq);
        get().setDraft(tabId, command.text);
      }
      return;
    }
    if (entry.event === EXTENSION_UI_REQUEST_EVENT) {
      const dialog = parseExtensionDialogRequest(entry.payload, tabId);
      if (!dialog) return;
      set({ extensionDialogs: [...get().extensionDialogs, dialog] });
      // The extension's own timeout is enforced here, not in the dock: a
      // background tab's dock is not mounted, but the extension must still be
      // unblocked when the countdown expires.
      clearExtensionDialogTimer(dialog.id);
      if (dialog.timeout !== null && dialog.timeout > 0) {
        const timer = setTimeout(() => {
          extensionDialogTimers.delete(dialog.id);
          void get().answerExtensionDialog(dialog, { cancelled: true });
        }, dialog.timeout);
        extensionDialogTimers.set(dialog.id, timer);
      }
      // A dialog belongs to its tab, so bring that tab forward rather than
      // letting the extension block behind a background tab (plan risk R5).
      if (get().activeTabId !== tabId) void get().activateTab(tabId);
      return;
    }
    if (entry.event === EXTENSION_UI_NOTIFY_EVENT) {
      const notification = parseExtensionNotification(entry.payload, tabId);
      if (!notification) return;
      set({
        extensionNotifications: [notification, ...get().extensionNotifications].slice(0, 100),
      });
      notifyToast(notification.message, notification.type);
      // Plannotator notifies its review URL, so the URL arriving in a
      // notification is the signal to open it in an in-app tab (plan step 21)
      // instead of handing it to the system browser.
      const loopback = firstLoopbackUrl(notification.message);
      if (loopback) get().openLoopbackUrl(loopback, tabId);
      return;
    }
    if (entry.event === EXTENSION_UI_THEME_EVENT) {
      const payload = entry.payload as { name?: unknown } | undefined;
      if (typeof payload?.name === "string") void get().setActiveTheme(payload.name);
      return;
    }
    if (entry.event === SESSION_SHUTDOWN_REQUEST_EVENT) {
      // An extension asked to quit; the session host is the app's unit of work,
      // so closing its tab is the desktop equivalent of Pi's shutdown.
      void get().closeTab(tabId);
    }
  },

  answerExtensionDialog: async (dialog, answer) => {
    clearExtensionDialogTimer(dialog.id);
    const api = bridge();
    set({ extensionDialogs: get().extensionDialogs.filter((entry) => entry.id !== dialog.id) });
    if (!api?.sessions) return;
    try {
      await api.sessions.request({
        tabId: dialog.tabId,
        method: "oi.respond",
        params: { id: dialog.id, ...answer },
      });
    } catch (error) {
      get().noteFailure(error);
    }
  },

  clearExtensionNotifications: () => set({ extensionNotifications: [] }),

  reportEditorText: (tabId, text) => {
    const request = bridge()?.sessions?.request({
      tabId,
      method: "oi.editorText",
      params: { text },
    });
    if (request) void request.then(undefined, () => undefined);
  },

  extensionCompletion: async (tabId, request) => {
    const api = bridge();
    if (!api?.sessions) return null;
    try {
      const result = await api.sessions.request({
        tabId,
        method: "completion.suggest",
        params: request,
      });
      return sanitizeCompletionSuggestions(result);
    } catch {
      return null;
    }
  },

  extensionApplyCompletion: async (tabId, request) => {
    const api = bridge();
    if (!api?.sessions) return null;
    try {
      const result = (await api.sessions.request({
        tabId,
        method: "completion.apply",
        params: request,
      })) as Partial<ExtensionCompletionResult> | null;
      if (
        !result ||
        !Array.isArray(result.lines) ||
        typeof result.cursorLine !== "number" ||
        typeof result.cursorCol !== "number"
      ) {
        return null;
      }
      return {
        lines: result.lines.filter((line): line is string => typeof line === "string"),
        cursorLine: result.cursorLine,
        cursorCol: result.cursorCol,
      };
    } catch {
      return null;
    }
  },

  loadTuiSurface: async (tabId) => {
    const api = bridge();
    if (!api?.sessions || tabId === CONTROL_TAB_ID) return;
    try {
      const result = await api.sessions.request({ tabId, method: "tui.state" });
      set({
        tuiSurfaces: { ...get().tuiSurfaces, [tabId]: sanitizeTuiSurfaceSnapshot(result) },
      });
    } catch {
      // A host without a TUI surface still streams; keep the empty surface.
      set({ tuiSurfaces: { ...get().tuiSurfaces, [tabId]: { ...EMPTY_TUI_SURFACE } } });
    }
  },

  resizeTuiSurface: (tabId, rows, cols) => {
    // Fire-and-forget: a resize must never block a keystroke.
    const request = bridge()?.sessions?.request({
      tabId,
      method: "tui.resize",
      params: { rows, cols },
    });
    if (request) void request.then(undefined, () => undefined);
  },

  sendTuiInput: (tabId, data) => {
    if (data.length === 0) return;
    const request = bridge()?.sessions?.request({
      tabId,
      method: "tui.input",
      params: { data },
    });
    if (request) void request.then(undefined, () => undefined);
  },

  extensionRender: async (tabId, request) => {
    const api = bridge();
    if (!api?.sessions || tabId === CONTROL_TAB_ID) return null;
    try {
      const result = await api.sessions.request({
        tabId,
        method: "render.request",
        params: request,
      });
      return sanitizeRenderedFrame(result);
    } catch {
      // A host without the renderer registry (or a renderer that threw before
      // answering) leaves the native card in place, exactly as Pi falls back.
      return null;
    }
  },

  extensionMarkdown: async (tabId, request) => {
    const api = bridge();
    if (!api?.sessions || tabId === CONTROL_TAB_ID) return null;
    try {
      const result = await api.sessions.request({
        tabId,
        method: "render.markdown",
        params: request,
      });
      return sanitizeMarkdownTransformResult(result);
    } catch {
      return null;
    }
  },

  toggleToolsExpanded: (tabId) => {
    const next = !(get().toolsExpanded[tabId] ?? false);
    set({ toolsExpanded: { ...get().toolsExpanded, [tabId]: next } });
    // Mirror it to the host so `ctx.ui.getToolsExpanded()` is truthful; the
    // host pushes the same value back through `oi.state`, which is idempotent.
    const request = bridge()?.sessions?.request({
      tabId,
      method: "oi.setToolsExpanded",
      params: { expanded: next },
    });
    if (request) void request.then(undefined, () => undefined);
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
    // Mirror the composer back to the host so `ctx.ui.getEditorText()` is
    // truthful (plan step 16). Debounced per tab, never per keystroke.
    const pending = editorTextTimers.get(tabId);
    if (pending) clearTimeout(pending);
    editorTextTimers.set(
      tabId,
      setTimeout(() => {
        editorTextTimers.delete(tabId);
        // The host's `getEditorText()` must see the body, not the marker
        // (plan step 20, D15: the textarea is the display).
        const draft = useAppStore.getState().prefs.drafts[tabId] ?? "";
        get().reportEditorText(tabId, get().expandPastes(tabId, draft));
      }, EDITOR_TEXT_DELAY_MS),
    );
  },

  openPicker: (picker, options = {}) =>
    set({ picker, pickerError: null, pickerSearch: options.search ?? "" }),
  closePicker: () => set({ picker: null, pickerError: null, pickerSearch: "" }),

  openConnections: (focus) =>
    set({ view: "connections", hint: null, connectionsFocus: focus ?? null }),
  clearConnectionsFocus: () => set({ connectionsFocus: null }),

  setModelScopeSnapshot: (tabId, payload) => {
    const scoped = Array.isArray(payload.scoped) ? payload.scoped : [];
    const patterns = Array.isArray(payload.enabledModels)
      ? normalizeScopePatterns(payload.enabledModels)
      : scopeKeys(scoped);
    set({
      modelScope: { ...get().modelScope, [tabId]: scopeStarKeys(patterns, scoped) },
      modelScopePatterns: { ...get().modelScopePatterns, [tabId]: patterns },
      modelScopeTarget: {
        ...get().modelScopeTarget,
        [tabId]: settingsTargetForTab(get(), tabId),
      },
    });
  },

  loadModels: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      const response = (await api.sessions.request({ tabId, method: "model.available" })) as
        | {
            models?: unknown[];
            scoped?: unknown[];
            enabledModels?: unknown;
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
      get().setModelScopeSnapshot(tabId, response ?? {});
    } catch (error) {
      get().noteFailure(error);
    }
  },

  setModel: async (tabId, entry, options = {}) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      const response = await api.sessions.request({
        tabId,
        method: "model.set",
        params: {
          model: entry.raw,
          persist: options.persist === true,
          scope: settingsTargetForTab(get(), tabId),
        },
      });
      // Defence in depth (plan step 4): the host also emits a `state` event,
      // but the response alone must move the UI — otherwise a missed or
      // coalesced event leaves the header on the old model.
      get().applySessionState({ tabId, state: response });
      // A persisted pick rewrites Pi's default; refresh settings so the
      // Settings view shows the new `defaultModel` (plan step 7).
      if (options.persist === true) void get().loadSettings({ refresh: true });
      // A different model can mean a different set of thinking levels, so the
      // clamp is re-read from the state the host returns instead of cached.
      set({
        picker: null,
        thinkingLevels: { ...get().thinkingLevels, [tabId]: thinkingLevelsOf(response) },
      });
    } catch (error) {
      set({ pickerError: errorMessage(error) });
      get().noteFailure(error);
    }
  },

  setThinking: async (tabId, level, options = {}) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      await api.sessions.request({
        tabId,
        method: "thinking.set",
        params: {
          level,
          persist: options.persist === true,
          scope: settingsTargetForTab(get(), tabId),
        },
      });
      set({ picker: null });
    } catch (error) {
      get().noteFailure(error);
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
      get().noteFailure(error);
    }
  },

  cycleThinking: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      await api.sessions.request({ tabId, method: "thinking.cycle", params: { persist: false } });
    } catch (error) {
      get().noteFailure(error);
    }
  },

  renameSession: async (tabId, name) => {
    const api = bridge();
    const trimmed = name.trim();
    if (!api?.sessions || trimmed.length === 0) return;
    try {
      await api.sessions.request({ tabId, method: "session.rename", params: { name: trimmed } });
    } catch (error) {
      get().noteFailure(error);
    }
  },

  toggleModelScope: async (tabId, provider, id) => {
    const api = bridge();
    if (!api?.sessions) return;
    // A hot-reloaded renderer can outlive the main process that was started
    // before `model.scope.toggle` existed. Block before IPC and name the fix.
    if (!mainSupports(get().info, "model.scope.toggle")) {
      set({ pickerError: MAIN_OUTDATED_MESSAGE, hint: MAIN_OUTDATED_MESSAGE });
      return;
    }
    // One settings rewrite per tab at a time: a second click could interleave
    // two writes and lose one of them.
    if (get().modelScopeBusy[tabId]) return;
    const key = `${provider}/${id}`;
    const before = get().modelScope[tabId] ?? [];
    const enabled = !before.includes(key);
    const optimistic = enabled ? [...before, key] : before.filter((entry) => entry !== key);
    set({
      modelScope: { ...get().modelScope, [tabId]: optimistic },
      modelScopeBusy: { ...get().modelScopeBusy, [tabId]: key },
      pickerError: null,
    });
    try {
      const response = (await api.sessions.request({
        tabId,
        method: "model.scope.toggle",
        params: { provider, id, enabled, scope: settingsTargetForTab(get(), tabId) },
      })) as { scoped?: unknown[]; enabledModels?: unknown } | undefined;
      get().setModelScopeSnapshot(tabId, response ?? {});
      await get().loadSettings({ refresh: true });
      await get().applyModelScopeToTabs(tabId);
    } catch (error) {
      const message = errorMessage(error);
      set({
        modelScope: { ...get().modelScope, [tabId]: before },
        pickerError: message,
        ...(isMainUnsupportedScopeError(message) ? { mainOutdated: MAIN_OUTDATED_MESSAGE } : {}),
      });
      if (!isMainUnsupportedScopeError(message) && isStaleHostError(message)) {
        get().noteStaleHost(tabId);
      }
      get().noteFailure(error);
    } finally {
      const busy = { ...get().modelScopeBusy };
      delete busy[tabId];
      set({ modelScopeBusy: busy });
    }
  },

  applyModelScopeToTabs: async (exceptTabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    if (!mainSupports(get().info, "model.scope.apply")) return;
    // Office tabs are host-backed sessions too; only a web tab has no Pi host.
    const targets = get().tabs.filter((tab) => tab.id !== exceptTabId && tab.kind !== "web");
    await Promise.all(
      targets.map(async (tab) => {
        try {
          const response = (await api.sessions.request({
            tabId: tab.id,
            method: "model.scope.apply",
          })) as { scoped?: unknown[]; enabledModels?: unknown } | undefined;
          get().setModelScopeSnapshot(tab.id, response ?? {});
        } catch (error) {
          // A starting/crashed tab has no live session; it converges on its
          // next session or /reload, so one dead tab must not fail the star.
          // A host that predates `model.scope.apply` still deserves the banner.
          if (isStaleHostError(error)) get().noteStaleHost(tab.id);
        }
        return undefined;
      }),
    );
  },

  /**
   * Pushes `steeringMode` / `followUpMode` into the live agents (plan step 9).
   *
   * A Settings write goes through the control host, so the open sessions keep
   * the modes they were constructed with until reload. Terminal Pi applies both
   * live (`setSteeringMode`/`setFollowUpMode`); the fan-out mirrors
   * `applyModelScopeToTabs`, skipping web tabs and tolerating a dead one.
   */
  applyQueueModeToTabs: async (exceptTabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    const settings = get().settings;
    const read = (key: "steeringMode" | "followUpMode"): string | null => {
      const value = settings?.project?.[key] ?? settings?.global?.[key];
      return typeof value === "string" ? value : null;
    };
    const steering = read("steeringMode");
    const followUp = read("followUpMode");
    if (!steering && !followUp) return;
    const targets = get().tabs.filter((tab) => tab.id !== exceptTabId && tab.kind !== "web");
    await Promise.all(
      targets.map(async (tab) => {
        try {
          if (steering) {
            await api.sessions.request({
              tabId: tab.id,
              method: "session.queueMode",
              params: { kind: "steering", mode: steering },
            });
          }
          if (followUp) {
            await api.sessions.request({
              tabId: tab.id,
              method: "session.queueMode",
              params: { kind: "followUp", mode: followUp },
            });
          }
        } catch {
          // A starting/crashed tab converges on its next session or /reload.
        }
        return undefined;
      }),
    );
  },

  restoreQueue: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      const result = (await api.sessions.request({ tabId, method: "clearQueue" })) as {
        cleared?: { steering?: string[]; followUp?: string[] };
      };
      // Terminal Pi restores steering first, then follow-ups, each on its own
      // line, so the order the user queued them survives.
      const restored = [
        ...(result?.cleared?.steering ?? []),
        ...(result?.cleared?.followUp ?? []),
      ].join("\n\n");
      if (restored.length === 0) return;
      const current = get().prefs.drafts[tabId] ?? "";
      get().setDraft(tabId, current.length > 0 ? `${restored}\n\n${current}` : restored);
    } catch (error) {
      get().noteFailure(error);
    }
  },

  syncModelScopesFromDisk: async () => {
    const now = Date.now();
    if (now - lastScopeSyncAt < 2_000) return;
    lastScopeSyncAt = now;
    await get().applyModelScopeToTabs();
  },

  setViewMode: (mode) => {
    set({ prefs: { ...get().prefs, viewMode: mode } });
    void bridge()?.prefs.set({ viewMode: mode });
  },

  sendPromptNow: async (tabId, text, options = {}) => {
    const api = bridge();
    const trimmed = text.trim();
    const tab = get().tabs.find((entry) => entry.id === tabId);
    if (!api?.sessions || !tab || trimmed.length === 0) return false;
    // Terminal Pi's editor clears in `submitValue` before dispatching. Do the
    // same before any await: a slow wake or a long run must never leave the text
    // in the composer. A refusal restores it above anything typed since.
    const previous = get().prefs.drafts[tabId] ?? "";
    const sequence = beginDraftSend(tabId);
    get().setDraft(tabId, "");
    rememberDraft(tabId, trimmed);
    // A stale idle/stopped tab is verified and repaired before the prompt; the
    // main-side request path is a second safety net, not the first interaction.
    if (tab.status !== "running") {
      const ready = await get().ensureSession(tabId, { force: true });
      if (!ready) {
        restoreDraftAfterRefusal(tabId, previous, sequence);
        return false;
      }
    }
    // Re-read after the ensure: the host may already be streaming while the
    // renderer still showed idle, and a streamed send needs a delivery mode.
    const running = get().tabs.find((entry) => entry.id === tabId)?.status === "running";
    const mode = running ? (options.mode ?? get().sendModes[tabId] ?? "steer") : undefined;
    // A `[paste #N …]` marker is display sugar: the model must receive the body
    // (plan step 20).
    const params: Record<string, unknown> = {
      text: get().expandPastes(tabId, trimmed),
      // The host resolves this request at the SDK preflight, so the composer is
      // free again immediately (2026-10-26 composer plan).
      ack: "preflight",
    };
    if (options.images && options.images.length > 0) params.images = options.images;
    if (mode) params.streamingBehavior = mode;
    const origin = options.promptOrigin?.trim();
    if (origin) params.promptOrigin = origin;
    try {
      await api.sessions.request({ tabId, method: "prompt", params });
      return true;
    } catch (error) {
      restoreDraftAfterRefusal(tabId, previous, sequence);
      get().noteFailure(error);
      return false;
    }
  },

  /**
   * The send path (plan step 7): a leading `/` is resolved before anything is
   * sent, so an unknown command becomes a hint instead of a literal prompt.
   */
  sendPrompt: async (tabId, text, options = {}) => {
    const trimmedInput = text.trim();
    if (trimmedInput.startsWith("!")) {
      const excludeFromContext = trimmedInput.startsWith("!!");
      const command = trimmedInput.slice(excludeFromContext ? 2 : 1).trim();
      if (command.length === 0) return false;
      const api = bridge();
      if (!api?.sessions) return false;
      const tab = get().tabs.find((entry) => entry.id === tabId);
      if (!tab) return false;
      // Terminal Pi refuses a second command while one runs. Refusing here too
      // keeps the text in the composer instead of bouncing it off the host.
      const state = get().sessionStates[tabId] as { bashRunning?: boolean } | undefined;
      if (state?.bashRunning === true) {
        set({ hint: "A shell command is already running — press Esc to cancel it first." });
        return false;
      }
      // Clear before any await (terminal's editor clears in submitValue): a
      // long command must not hold the text (or the composer's send lock)
      // until the shell exits.
      const previous = get().prefs.drafts[tabId] ?? "";
      const sequence = beginDraftSend(tabId);
      get().setDraft(tabId, "");
      rememberDraft(tabId, trimmedInput);
      if (tab.status !== "running") {
        const ready = await get().ensureSession(tabId, { force: true });
        if (!ready) {
          restoreDraftAfterRefusal(tabId, previous, sequence);
          return false;
        }
      }
      try {
        await api.sessions.request({
          tabId,
          method: "bash.run",
          params: { command, excludeFromContext, ack: "started" },
        });
        return true;
      } catch (error) {
        restoreDraftAfterRefusal(tabId, previous, sequence);
        get().noteFailure(error);
        return false;
      }
    }
    if (trimmedInput.startsWith("/")) {
      const outcome = await get().runCommandInput(tabId, text, options);
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
      get().noteFailure(error);
      return cached ?? [];
    }
  },

  invalidateCommands: (tabId) => {
    const { [tabId]: _removed, ...rest } = get().completionCommands;
    set({ completionCommands: rest });
  },

  completeCommandArguments: async (tabId, name, prefix) => {
    const api = bridge();
    if (!api?.sessions) return null;
    try {
      const response = await api.sessions.request({
        tabId,
        method: "commands.complete",
        params: { name, prefix },
      });
      if (isUnsupportedCommandComplete(response)) {
        get().noteStaleHost(tabId);
        return null;
      }
      get().clearStaleHost(tabId);
      return parseCommandCompleteResult(response);
    } catch (error) {
      if (isStaleHostError(error)) get().noteStaleHost(tabId);
      return null;
    }
  },

  completeAppCommandArguments: async (tabId, name, prefix) => {
    // The catalog is fetched lazily: a command line should not issue a host
    // request per keystroke, only the first `/model` completion of a tab.
    if (name === "model" && get().modelCatalog[tabId] === undefined) {
      await get().loadModels(tabId);
    }
    if (name === "login" && !get().providersLoaded) {
      await get().loadProviders();
    }
    const state = get();
    const levels = state.thinkingLevels[tabId] ?? thinkingLevelsOf(state.sessionStates[tabId]);
    return appArgumentItems(name, prefix, {
      models: state.modelCatalog[tabId] ?? [],
      thinkingLevels: levels,
      providers: state.providers,
    });
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
      get().noteFailure(error);
      return cached ?? null;
    }
  },

  runCommandInput: async (tabId, text, options = {}) => {
    const preferredSource = options.preferredSource;
    const context = (hostCommands: HostCommandEntry[]) =>
      resolveCommandInput(text, {
        hostCommands,
        ...(preferredSource ? { preferredSource } : {}),
      });
    const hostCommands = await get().loadCommands(tabId);
    const resolution = context(hostCommands);

    if (resolution.kind === "not-a-command") return { handled: false, sent: false };

    if (resolution.kind === "unknown") {
      // The cache can be stale after `/reload` or a resumed session. Refresh
      // once; a valid command must never be swallowed as a typo.
      const fresh = await get().loadCommands(tabId, { refresh: true });
      const retry = context(fresh);
      if (retry.kind !== "unknown") return get().runCommandInput(tabId, text, options);
      set({ hint: `Unknown command /${resolution.name} — press / to list commands.` });
      return { handled: true, sent: false };
    }

    // Extension commands run directly in the host, exactly like terminal Pi:
    // this works while the agent is streaming and needs no send mode. Prompt
    // templates and /skill:* keep the `prompt` path so the SDK expands them.
    if (resolution.kind === "host") {
      const { name, argument, command } = resolution;
      if (command.source !== "extension") {
        const sent = await get().sendPromptNow(tabId, text, {
          ...options,
          promptOrigin: text.trim(),
        });
        return { handled: true, sent };
      }

      const api = bridge();
      if (!api?.sessions) {
        set({ hint: "The preload bridge is unavailable." });
        return { handled: true, sent: false };
      }

      let state: "ran" | "missing" | "unavailable";
      try {
        const response = await api.sessions.request({
          tabId,
          method: "commands.run",
          params: { name, args: argument, ack: "started" },
        });
        state = parseCommandRunResult(response).ran ? "ran" : "missing";
      } catch {
        // An older host answers `not_implemented`; fall through to `prompt` so
        // idle use still works after a downgrade.
        state = "unavailable";
      }

      if (state === "ran") {
        get().setDraft(tabId, "");
        rememberDraft(tabId, text);
        return { handled: true, sent: true };
      }

      if (state === "missing") {
        const fresh = await get().loadCommands(tabId, { refresh: true });
        const retry = context(fresh);
        if (retry.kind === "host" && retry.command.source === "extension") {
          try {
            const response = await api.sessions.request({
              tabId,
              method: "commands.run",
              params: { name: retry.name, args: retry.argument, ack: "started" },
            });
            if (parseCommandRunResult(response).ran) {
              get().setDraft(tabId, "");
              rememberDraft(tabId, text);
              return { handled: true, sent: true };
            }
          } catch {
            state = "unavailable";
          }
        }
        if (state === "missing") {
          if (retry.kind === "unknown") {
            set({ hint: `/${name} is no longer available — run /reload and try again.` });
            return { handled: true, sent: false };
          }
          // The command changed kind (e.g. became a prompt template): dispatch
          // again against the freshly cached list.
          if (retry.kind !== "host" || retry.command.source !== "extension") {
            return get().runCommandInput(tabId, text, options);
          }
          set({ hint: `/${name} is no longer available — run /reload and try again.` });
          return { handled: true, sent: false };
        }
      }

      // Direct execution is unavailable (an older host): keep the legacy prompt
      // path, with the caller's mode/images forwarded so it still works while
      // streaming.
      const sent = await get().sendPromptNow(tabId, text, {
        ...options,
        promptOrigin: text.trim(),
      });
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
      // `/login <provider>` opens the provider's sheet; an unknown or ambiguous
      // ref seeds the Connections search instead (the desktop equivalent of
      // Pi's provider selector). Bare `/login` keeps today's view.
      if (
        action.view === "connections" &&
        command.argumentKind === "provider" &&
        argument.length > 0
      ) {
        if (!get().providersLoaded) await get().loadProviders();
        const reference = argument.trim().toLowerCase();
        const matches = get().providers.filter(
          (provider) =>
            provider.id.toLowerCase() === reference || provider.label.toLowerCase() === reference,
        );
        if (matches.length === 1 && matches[0]) {
          get().openConnections({ providerId: matches[0].id });
        } else {
          get().openConnections({ query: argument });
        }
        return { handled: true, sent: false };
      }
      set({ view: action.view, hint: null });
      return { handled: true, sent: false };
    }
    // The unified scope editor is the model picker: scoped models first, the
    // star toggles them. It must never take `/model`'s exact-match shortcut, or
    // `/scoped-models provider/id` would switch the model instead of filtering.
    if (action.kind === "scope") {
      if (argument.length > 0) {
        get().openPicker("model", { search: argument });
      } else {
        get().openPicker("model");
      }
      void get().loadModels(tabId);
      return { handled: true, sent: false };
    }
    if (action.kind === "picker") {
      if (action.picker === "model") {
        // `/model provider/id` sets an exact match directly; anything else
        // opens the picker with the search prefilled (Pi's handleModelCommand).
        if (argument.length > 0) {
          if (get().modelCatalog[tabId] === undefined) await get().loadModels(tabId);
          const exact = findExactModelEntry(get().modelCatalog[tabId] ?? [], argument);
          if (exact) {
            set({ pickerError: null });
            await get().setModel(tabId, exact, { persist: false });
            const failure = get().pickerError;
            if (failure) {
              get().openPicker("model", { search: argument });
              set({ pickerError: failure });
              return { handled: true, sent: false };
            }
            return { handled: true, sent: true };
          }
          get().openPicker("model", { search: argument });
          void get().loadModels(tabId);
          return { handled: true, sent: false };
        }
        get().openPicker("model");
        void get().loadModels(tabId);
        return { handled: true, sent: false };
      }

      // `/thinking <level>` sets an exact level; an unknown level is an error
      // with the available list (Pi's handleThinkingCommand).
      if (argument.length > 0) {
        const levels = get().thinkingLevels[tabId] ?? thinkingLevelsOf(get().sessionStates[tabId]);
        const wanted = argument.trim().toLowerCase();
        const level = levels.find((candidate) => candidate.toLowerCase() === wanted);
        if (level) {
          await get().setThinking(tabId, level, { persist: false });
          return { handled: true, sent: true };
        }
        set({
          hint:
            levels.length > 0
              ? `Unknown thinking level "${argument}". Available: ${levels.join(", ")}.`
              : `Unknown thinking level "${argument}". This model reports no thinking levels.`,
        });
        return { handled: true, sent: false };
      }
      get().openPicker("thinking");
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
      const format = argument.trim().toLowerCase();
      if (format.length === 0 || format === "html") {
        await get().exportSessionHtml(tabId);
      } else if (format === "jsonl") {
        await get().exportSessionJsonl(tabId);
      } else {
        set({ hint: `Unknown export format "${format}". Use /export html or /export jsonl.` });
      }
      return { handled: true, sent: false };
    }
    if (action.kind === "import") {
      await get().requestImport(tabId, argument.length > 0 ? argument : undefined);
      return { handled: true, sent: false };
    }
    if (action.kind === "changelog") {
      await get().openChangelog();
      return { handled: true, sent: false };
    }
    if (action.kind === "hotkeys") {
      set({ shortcutsHelpOpen: true });
      return { handled: true, sent: false };
    }
    if (action.kind === "quit") {
      await get().closeTab(tabId);
      return { handled: true, sent: false };
    }
    if (action.kind === "share") {
      await get().openShare(tabId);
      return { handled: true, sent: false };
    }
    if (action.kind === "bug") {
      await get().openBugReport(tabId, argument);
      return { handled: true, sent: false };
    }
    if (action.kind === "copyLast") {
      await get().copyLastAssistant(tabId);
      return { handled: true, sent: false };
    }
    if (action.kind === "sessionInfo") {
      await get().openSessionInfo(tabId);
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
      // A new/cloned/reloaded session has a fresh extension runner.
      if (
        action.method === "session.new" ||
        action.method === "session.clone" ||
        action.method === "session.reload"
      ) {
        get().invalidateCommands(tabId);
      }
      return { handled: true, sent: true };
    } catch (error) {
      get().noteFailure(error);
      return { handled: true, sent: false };
    }
  },

  stopRun: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      // Esc while a `!` command runs cancels the command, not the agent turn.
      const state = get().sessionStates[tabId] as
        { bashRunning?: boolean; retrying?: boolean; compacting?: boolean } | undefined;
      if (state?.bashRunning === true) {
        await api.sessions.request({ tabId, method: "bash.abort" });
        return;
      }
      // A retry/compaction is a run of its own: cancel it rather than aborting a
      // turn that has not started yet (terminal Pi's Esc does the same).
      if (state?.retrying === true) {
        await api.sessions.request({ tabId, method: "session.abortRetry" });
        return;
      }
      if (state?.compacting === true) {
        await api.sessions.request({ tabId, method: "session.abortCompaction" });
        return;
      }
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
      get().noteFailure(error);
    }
  },

  clearQueue: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      await api.sessions.request({ tabId, method: "clearQueue" });
    } catch (error) {
      get().noteFailure(error);
    }
  },

  abortRetry: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      await api.sessions.request({ tabId, method: "session.abortRetry" });
    } catch (error) {
      get().noteFailure(error);
    }
  },

  abortCompaction: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      await api.sessions.request({ tabId, method: "session.abortCompaction" });
    } catch (error) {
      get().noteFailure(error);
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
      get().noteFailure(error);
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
      get().noteFailure(error);
    }
  },

  applyControlEvent: (entry) => {
    if (entry.event === PACKAGE_PROGRESS_EVENT) {
      const progress = sanitizePackageProgress(entry.payload);
      if (!progress) return;
      // A finished operation clears the indicator; the request's own resolution
      // also clears it, so a dropped event can never wedge the UI.
      set({
        packageProgress:
          progress.phase === "complete" || progress.phase === "error" ? null : progress,
      });
      return;
    }

    if (entry.event === PACKAGES_CHANGED_EVENT) {
      // Another window (or the host itself) changed the package list.
      void get().loadPackages({ refresh: true });
      return;
    }

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
      // The scope lives on the live session too. A Settings edit must reach the
      // open tabs without waiting for a reload, or the dialog's stars and the
      // extension pickers would disagree with the file.
      if (key === "enabledModels") {
        await get().applyModelScopeToTabs();
      }
      // Queue delivery modes are copied into the agent at construction; a
      // settings edit must reach the live sessions without a reload.
      if (key === "steeringMode" || key === "followUpMode") {
        await get().applyQueueModeToTabs();
      }
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
    await get().applyModelScopeToTabs();
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
      const external = snapshot.files.global.mtimeMs !== before.global;
      if (external) {
        set({ settingsExternalEdit: true });
        void get().applyModelScopeToTabs();
      }
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
    if (
      scope === "project" &&
      settingsTargetForProject(get(), get().project?.path ?? null) !== "project"
    ) {
      set({
        resourcesError:
          "Enable project settings for this project before toggling a project resource.",
      });
      return false;
    }
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
      // Extensions may have appeared or disappeared; the next `/` or argument
      // completion must rebuild `commands.list` instead of serving a stale one.
      get().invalidateCommands(target);
    }
    await get().loadResources({ refresh: true });
    const change = diffResources(before, get().resources.resources);
    set({ resourcesChange: isResourceChangeEmpty(change) ? null : change });
  },

  // ---- Skills, themes and keybindings (plan step 15) ----

  loadThemes: async () => {
    const api = bridge();
    if (!api?.sessions) return;
    const current = get();
    if (current.themesLoaded && !current.themesError) return;
    set({ themesBusy: true, themesError: null });
    try {
      const target = resourcesTarget(get());
      const cwd = resourcesCwd(get(), target);
      const raw = await api.sessions.request({
        tabId: target,
        method: "themes.list",
        params: { cwd },
      });
      const themes = sanitizeThemesSnapshot(raw);
      set({ themes, themesLoaded: true, themesBusy: false, themesError: null });
      get().applyChromeTheme();
    } catch (error) {
      set({ themesBusy: false, themesLoaded: true, themesError: errorMessage(error) });
    }
  },

  setActiveTheme: async (name) => {
    if (!get().settings) await get().loadSettings();
    const settings = get().settings;
    void settings;
    const scope = settingsTargetForProject(get(), get().project?.path ?? null);
    const ok = await get().setSetting("theme", name, scope as SettingsScope);
    if (ok) {
      const themes = {
        ...get().themes,
        active: name,
        themes: get().themes.themes.map((entry) => ({ ...entry, active: entry.name === name })),
      };
      set({ themes });
      get().applyChromeTheme();
    }
    return ok;
  },

  importTheme: async (filename, content) => {
    const api = bridge();
    if (!api?.sessions) {
      set({ themesError: "The preload bridge is unavailable." });
      return false;
    }
    set({ themesBusy: true, themesError: null });
    try {
      const result = (await api.sessions.request({
        tabId: CONTROL_TAB_ID,
        method: "themes.import",
        params: { filename, content },
      })) as { name: string };
      set({ themesBusy: false, themesLoaded: false });
      await get().loadThemes();
      return await get().setActiveTheme(result.name);
    } catch (error) {
      set({ themesBusy: false, themesError: errorMessage(error) });
      return false;
    }
  },

  loadKeybindings: async (options) => {
    const api = bridge();
    if (!api?.sessions) return;
    const current = get();
    if (options?.refresh !== true && current.keybindingsLoaded) return;
    set({ keybindingsBusy: true, keybindingsError: null });
    try {
      const raw = await api.sessions.request({
        tabId: CONTROL_TAB_ID,
        method: "keybindings.get",
      });
      set({
        keybindings: sanitizeKeybindingsSnapshot(raw),
        keybindingsLoaded: true,
        keybindingsBusy: false,
        keybindingsError: null,
      });
    } catch (error) {
      set({
        keybindingsBusy: false,
        keybindingsLoaded: true,
        keybindingsError: errorMessage(error),
      });
    }
  },

  saveKeybindings: async (bindings) => {
    const api = bridge();
    if (!api?.sessions) {
      set({ keybindingsError: "The preload bridge is unavailable." });
      return false;
    }
    set({ keybindingsBusy: true, keybindingsError: null });
    try {
      const raw = await api.sessions.request({
        tabId: CONTROL_TAB_ID,
        method: "keybindings.set",
        params: { bindings },
      });
      set({
        keybindings: sanitizeKeybindingsSnapshot(raw),
        keybindingsBusy: false,
        keybindingsError: null,
      });
      return true;
    } catch (error) {
      set({ keybindingsBusy: false, keybindingsError: errorMessage(error) });
      return false;
    }
  },

  resetKeybindings: async () => {
    const api = bridge();
    if (!api?.sessions) return;
    set({ keybindingsBusy: true, keybindingsError: null });
    try {
      const raw = await api.sessions.request({
        tabId: CONTROL_TAB_ID,
        method: "keybindings.reset",
      });
      set({
        keybindings: sanitizeKeybindingsSnapshot(raw),
        keybindingsBusy: false,
        keybindingsError: null,
      });
    } catch (error) {
      set({ keybindingsBusy: false, keybindingsError: errorMessage(error) });
    }
  },

  loadShortcuts: async (options) => {
    const api = bridge();
    if (!api?.sessions) return;
    const target = resourcesTarget(get());
    const current = get();
    // A control host has no extension runner, so `shortcuts.list` would fail
    // with `not_implemented`; leave the (empty) list alone rather than flapping
    // into an error state on every activation without a session.
    if (target === CONTROL_TAB_ID && !options?.refresh) {
      if (!current.shortcutsLoaded) set({ shortcutsLoaded: true, shortcutsTabId: CONTROL_TAB_ID });
      return;
    }
    // The list belongs to a tab: reuse it for the same tab and only refetch on a
    // refresh or when the active session changed. This is what makes it cheap to
    // call from `activateTab` (plan step 7). A failed attempt is never latched:
    // when the last attempt for this tab errored (`shortcutsError`), the next
    // call retries instead of returning the empty list forever (2026-10-20
    // startup-tab-cycle plan).
    if (
      options?.refresh !== true &&
      current.shortcutsLoaded &&
      current.shortcutsTabId === target &&
      !current.shortcutsError &&
      // An empty successful response is not a reason to stop asking: a session
      // that resumed before its extension runner bound can answer `{shortcuts: []}`
      // once, and the composer's Tab fallback needs the retry (2026-10-24 plan).
      current.shortcuts.shortcuts.length > 0
    ) {
      return;
    }
    if (current.shortcutsBusy) return;
    set({ shortcutsBusy: true, shortcutsError: null });
    try {
      const raw = await api.sessions.request({ tabId: target, method: "shortcuts.list" });
      set({
        shortcuts: sanitizeShortcutsSnapshot(raw),
        shortcutsLoaded: true,
        shortcutsBusy: false,
        shortcutsError: null,
        shortcutsTabId: target,
      });
    } catch (error) {
      set({
        shortcutsBusy: false,
        shortcutsLoaded: true,
        shortcutsError: errorMessage(error),
        shortcuts: EMPTY_SHORTCUTS,
        shortcutsTabId: target,
      });
    }
  },

  invokeShortcut: async (key) => {
    const api = bridge();
    if (!api?.sessions) return false;
    const target = resourcesTarget(get());
    if (target === CONTROL_TAB_ID) return false;
    try {
      await api.sessions.request({ tabId: target, method: "shortcuts.invoke", params: { key } });
      return true;
    } catch {
      return false;
    }
  },

  setShortcutsHelpOpen: (open) => set({ shortcutsHelpOpen: open }),

  runSkill: (name) => {
    const state = get();
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (!active || active.kind !== "session") {
      set({ view: "skills", hint: `Open a session first, then run /skill:${name}.` });
      return;
    }
    // Insert, don't send: the skill may take arguments the user must supply.
    state.setDraft(active.id, `/skill:${name} `);
    set({ view: "session", hint: null });
  },

  applyChromeTheme: () => {
    const snapshot = get().themes;
    const active = activeThemeSwatches(snapshot);
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    if (!active) {
      root.removeAttribute("data-theme");
      return;
    }
    const variables: Record<string, string> = themeCssVariables(active.swatches, active.variant);
    for (const [key, value] of Object.entries(variables)) {
      if (key === "data-theme") root.setAttribute("data-theme", value);
      else if (value) root.style.setProperty(key, value);
    }
  },

  // ---- Packages (plan step 14) ----

  installRecommendedPackage: (entry) => {
    get().requestPackageInstall(entry.source, "user");
  },

  // ---- Integrations (plan step 19) ----

  installOfficeBridge: () => {
    get().requestPackageInstall(officeBridgePackageSource(), "user", null, {
      integration: "office",
    });
  },

  loadIntegrations: async () => {
    const api = bridge();
    if (!api?.integrations) return;
    if (get().integrationsLoaded) return;
    try {
      const state = await api.integrations.get();
      set({ integrations: sanitizeIntegrationsState(state), integrationsLoaded: true });
    } catch {
      // An unreadable record must never block the card: Pi's settings still say
      // whether the bridge is installed, so the app keeps its defaults.
      set({ integrationsLoaded: true });
    }
  },

  recordOfficeIntegration: async (patch) => {
    const api = bridge();
    if (!api?.integrations) return;
    try {
      const state = await api.integrations.recordOffice(patch);
      set({ integrations: sanitizeIntegrationsState(state), integrationsLoaded: true });
    } catch (error) {
      set({ packagesError: errorMessage(error) });
    }
  },

  openOfficeSession: async () => {
    const existing = get().tabs.find((tab) => tab.kind === "office");
    if (existing) {
      await get().activateTab(existing.id);
      set({ view: "session" });
      return;
    }
    await get().createSessionTab("office");
  },

  promoteToOfficeHost: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return false;
    // Promotion restarts two hosts and re-binds a port, so a second click while
    // one is in flight would demote and re-spawn the same tabs twice.
    if (get().promotingOfficeHost) return false;
    set({ promotingOfficeHost: true });
    try {
      const envelope = await api.sessions.promoteOfficeHost(tabId);
      get().applyTabs(envelope);
      // The IPC returns when the host is spawned, not when `/health` answers: the
      // bridge still has to load and bind 38617. Saying the bridge *is* ready was
      // the promise behind "the Documents menu disappeared" (2026-10-30
      // rail-headers plan), so the copy states the delay and the panel — not the
      // toast — is the live truth.
      const message =
        "This session is now the Office host. The bridge re-binds port 38617 in a few seconds.";
      set({ hint: message });
      toast.success(message);
      // The pane registry is served by the new host, so the old pane list is
      // stale until the next probe. Ask for one now rather than waiting 5 s.
      void get().refreshOfficeDocuments();
      return true;
    } catch (error) {
      const message = errorMessage(error);
      // The takeover really terminates the port's owner, so a failure has to be
      // loud: the hint is transient, the toast is what a user notices.
      set({ hint: message });
      toast.error(message);
      // A failed takeover rolls back to the previous host, so re-probe to show
      // whatever bridge is actually answering now.
      void get().refreshOfficeDocuments();
      return false;
    } finally {
      set({ promotingOfficeHost: false });
    }
  },

  // ---- Live Office pane registry (plan step 20) ----

  loadDiagnostics: async () => {
    const api = bridge();
    if (!api?.diagnostics) return;
    try {
      set({ diagnostics: await api.diagnostics.get(), diagnosticsError: null });
    } catch (error) {
      set({ diagnosticsError: errorMessage(error) });
    }
  },

  // ---- Updates (plan step 26) ----

  loadUpdateState: async () => {
    const api = bridge();
    if (!api?.updates) return;
    try {
      set({ update: sanitizeUpdateState(await api.updates.get()) });
    } catch {
      // An updater that cannot be reached is not a user-visible failure: the
      // banner simply stays absent.
    }
  },

  applyUpdateState: (state) => set({ update: sanitizeUpdateState(state) }),

  checkForUpdates: async () => {
    const api = bridge();
    if (!api?.updates) return;
    try {
      const next = sanitizeUpdateState(await api.updates.check());
      set({ update: next });
      // A finished check is feedback even when there is nothing to install; the
      // banner only carries the actionable phases.
      if (next.phase === "up-to-date") set({ hint: "Pi Desktop is up to date." });
      else if (next.phase === "unsupported")
        set({ hint: "Updates are checked in installed builds only." });
      else if (next.phase === "error") set({ hint: next.error ?? "The update check failed." });
    } catch (error) {
      get().noteFailure(error);
    }
  },

  downloadUpdate: async () => {
    const api = bridge();
    if (!api?.updates) return;
    try {
      set({ update: sanitizeUpdateState(await api.updates.download()) });
    } catch (error) {
      get().noteFailure(error);
    }
  },

  installUpdate: async () => {
    const api = bridge();
    if (!api?.updates) return;
    try {
      // A successful install quits the app; a false answer means nothing was
      // ready, so the state did not move and nothing needs saying.
      await api.updates.install();
    } catch (error) {
      get().noteFailure(error);
    }
  },

  // ---- Onboarding (plan step 26) ----

  startOnboarding: () => {
    const { prefs, providers, projects } = get();
    set({
      onboardingStep: firstOnboardingStep({
        providersConfigured: providers.some((provider) => provider.configured),
        hasProjects: projects.length > 0,
        completedAt: prefs.onboardingCompletedAt,
      }),
    });
  },

  setOnboardingStep: (step) => set({ onboardingStep: step }),

  nextOnboarding: () => {
    const step = get().onboardingStep;
    if (!step) return;
    const next = nextOnboardingStep(step);
    // The last step has no next; finishing is the explicit button's job.
    if (next) set({ onboardingStep: next });
  },

  previousOnboarding: () => {
    const step = get().onboardingStep;
    if (!step) return;
    const previous = previousOnboardingStep(step);
    // The first step has no previous; stay put rather than closing.
    if (previous) set({ onboardingStep: previous });
  },

  dismissOnboarding: () => set({ onboardingStep: null }),

  completeOnboarding: async () => {
    const completedAt = Date.now();
    set({
      onboardingStep: null,
      prefs: { ...get().prefs, onboardingCompletedAt: completedAt },
    });
    const api = bridge();
    if (!api?.prefs) return;
    try {
      set({ prefs: await api.prefs.set({ onboardingCompletedAt: completedAt }) });
    } catch (error) {
      get().noteFailure(error);
    }
  },

  chooseProfileMode: async (mode) => {
    const previous = get().prefs.profileMode;
    set({ prefs: { ...get().prefs, profileMode: mode } });
    const api = bridge();
    if (api?.prefs) {
      try {
        set({ prefs: await api.prefs.set({ profileMode: mode }) });
      } catch (error) {
        // Put the old value back so the UI never lies about what is stored.
        set({ prefs: { ...get().prefs, profileMode: previous } });
        get().noteFailure(error);
      }
    }
    // The running app resolved its profile at launch; a difference needs a restart.
    return mode !== get().info?.profileMode;
  },

  relaunchApp: async () => {
    await bridge()?.relaunch();
  },

  loadBlob: async (tabId, ref) => {
    const path = ref.$blob;
    if (get().blobs[path]) return;
    set((state) => ({ blobs: { ...state.blobs, [path]: { status: "loading" } } }));
    const api = bridge();
    if (!api?.sessions) {
      set((state) => ({
        blobs: {
          ...state.blobs,
          [path]: { status: "error", error: "Sessions are unavailable." },
        },
      }));
      return;
    }
    try {
      const result = (await api.sessions.request({
        tabId,
        method: "host.blobs.read",
        params: { path },
      })) as { contents?: unknown } | null;
      const contents = typeof result?.contents === "string" ? result.contents : null;
      set((state) => ({
        blobs: {
          ...state.blobs,
          [path]:
            contents === null
              ? { status: "error", error: "The spilled result is no longer on disk." }
              : { status: "ready", contents },
        },
      }));
    } catch (error) {
      set((state) => ({
        blobs: { ...state.blobs, [path]: { status: "error", error: errorMessage(error) } },
      }));
    }
  },

  loadOfficeDocuments: async () => {
    const api = bridge();
    if (!api?.office) return;
    if (get().officeDocumentsLoaded) return;
    try {
      const view = await api.office.documents();
      set({ officeDocuments: view, officeDocumentsLoaded: true });
      // A bridge that already has panes attached opens the rail on Documents.
      if (view.panes.length > 0) get().openRailMenu("documents");
    } catch {
      // The panel is an enhancement: an unreadable registry must never block
      // the session, so the store keeps its empty view.
      set({ officeDocumentsLoaded: true });
    }
  },

  applyOfficeDocuments: (view) => {
    set({ officeDocuments: view, officeDocumentsLoaded: true });
    // A bridge that already has panes attached opens the rail on Documents.
    if (view.panes.length > 0) get().openRailMenu("documents");
  },

  refreshOfficeDocuments: async () => {
    const api = bridge();
    if (!api?.office) return;
    try {
      const view = await api.office.refreshDocuments();
      get().applyOfficeDocuments(view);
    } catch {
      // Same as above: a failed probe leaves the last known registry in place.
    }
  },

  // ---- Docked panel rail ----

  toggleRail: () => get().setRailOpen(!get().prefs.rail.open),

  setRailOpen: (open) => {
    if (get().prefs.rail.open === open) return;
    get().setPrefs({ rail: { ...get().prefs.rail, open } });
  },

  openRailMenu: (id) => {
    const rail = get().prefs.rail;
    if (rail.open && rail.activeMenu === id) return;
    get().setPrefs({ rail: { ...rail, open: true, activeMenu: id } });
  },

  toggleRailMenu: (id) => {
    const rail = get().prefs.rail;
    // The active entry collapses the body (the strip stays); any other entry
    // switches to it and expands.
    if (rail.open && rail.activeMenu === id) {
      get().setPrefs({ rail: { ...rail, open: false } });
      return;
    }
    get().setPrefs({ rail: { ...rail, open: true, activeMenu: id } });
  },

  setRailMenuOrder: (order) => {
    const rail = get().prefs.rail;
    const next = sanitizeRailMenuOrder(order);
    if (next.length === rail.order.length && next.every((id, i) => id === rail.order[i])) return;
    get().setPrefs({ rail: { ...rail, order: next } });
  },

  setRailWidth: (width) => {
    const rail = get().prefs.rail;
    const clamped = clampRailWidth(width);
    if (clamped === rail.width) return;
    get().setPrefs({ rail: { ...rail, width: clamped } });
  },

  setRailSplit: (split) => {
    const rail = get().prefs.rail;
    const clamped = clampRailSplit(split);
    if (clamped.top === rail.split.top && clamped.middle === rail.split.middle) return;
    get().setPrefs({ rail: { ...rail, split: clamped } });
  },

  setSourceControlCollapsed: (group, collapsed) => {
    const rail = get().prefs.rail;
    if (rail.collapsed[group] === collapsed) return;
    get().setPrefs({ rail: { ...rail, collapsed: { ...rail.collapsed, [group]: collapsed } } });
  },

  // ---- Source control (git-checkpoint plan step 9) ----

  loadGit: async (projectPath) => {
    const api = bridge()?.git;
    if (!api) return;
    try {
      get().applyGitSnapshot(await api.snapshot(projectPath));
    } catch (error) {
      // The rail is an enhancement: an unreadable registry must never block the
      // session, so the failure is classified and shown, not thrown.
      get().noteFailure(error);
    }
  },

  applyGitSnapshot: (snapshot) => {
    const parsed = sanitizeGitSnapshot(snapshot);
    if (parsed.projectPath.length === 0) return;
    const next: Record<string, GitSnapshot> = { ...get().git, [parsed.projectPath]: parsed };
    // Bound the map: a long app session visits many folders, and only the recent
    // few are ever on screen.
    for (const stale of Object.keys(next).slice(
      0,
      Math.max(0, Object.keys(next).length - MAX_GIT_SNAPSHOTS),
    )) {
      delete next[stale];
    }
    set({
      git: next,
      gitError: parsed.error
        ? parsed.error.fix
          ? `${parsed.error.message} ${parsed.error.fix}`
          : parsed.error.message
        : get().gitError,
    });
  },

  refreshGit: async (projectPath) => {
    const api = bridge()?.git;
    if (!api) return;
    try {
      get().applyGitSnapshot(await api.refresh(projectPath));
    } catch (error) {
      get().noteFailure(error);
    }
  },

  watchGit: async (projectPath) => {
    const api = bridge()?.git;
    if (!api) return;
    const previous = get().gitWatched;
    if (previous === projectPath) return;
    // Record the new target first: a failure while stopping the old one must not
    // leave the store believing it is still watching the previous folder.
    set({ gitWatched: projectPath });
    try {
      if (previous) await api.watch(previous, false);
      if (projectPath) await api.watch(projectPath, true);
    } catch (error) {
      get().noteFailure(error);
    }
  },

  runGitAction: async (projectPath, action) => {
    const api = bridge()?.git;
    if (!api) {
      return {
        ok: false,
        error: {
          code: "not_a_repo",
          message: "The preload bridge is unavailable in this window.",
          recoverable: false,
        },
      };
    }
    try {
      const result = await api.action(projectPath, action);
      if (result.ok) {
        set({ gitError: null });
        // main pushes a refreshed snapshot for a *watched* folder; an explicit
        // read keeps an unwatched one (a background project) honest too.
        await get().refreshGit(projectPath);
      } else if (result.error) {
        set({
          gitError: result.error.fix
            ? `${result.error.message} ${result.error.fix}`
            : result.error.message,
        });
      }
      return result;
    } catch (error) {
      get().noteFailure(error);
      return {
        ok: false,
        error: {
          code: "unknown",
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
        },
      };
    }
  },

  openGitDiff: async (projectPath, request) => {
    const api = bridge()?.git;
    if (!api) return;
    set({ gitDiffLoading: true, gitError: null });
    try {
      const diff = await api.diff(projectPath, request);
      set({ gitDiff: { projectPath, request, diff }, gitDiffLoading: false });
    } catch (error) {
      set({ gitDiffLoading: false });
      get().noteFailure(error);
    }
  },

  closeGitDiff: () => set({ gitDiff: null, gitDiffLoading: false }),

  loadGitLog: async (projectPath, options = {}) => {
    const api = bridge()?.git;
    if (!api) return;
    const page = get().gitLog[projectPath] ?? EMPTY_GIT_LOG_PAGE;
    const more = options.more === true && page.entries.length > 0;
    set({ gitLog: { ...get().gitLog, [projectPath]: { ...page, loading: true } } });
    try {
      const entries = await api.log(projectPath, {
        limit: GIT_LOG_PAGE_SIZE,
        ...(more ? { skip: page.entries.length } : {}),
      });
      set({
        gitLog: {
          ...get().gitLog,
          [projectPath]: {
            entries: more ? [...page.entries, ...entries] : entries,
            loading: false,
            hasMore: entries.length >= GIT_LOG_PAGE_SIZE,
          },
        },
      });
    } catch (error) {
      set({ gitLog: { ...get().gitLog, [projectPath]: { ...page, loading: false } } });
      get().noteFailure(error);
    }
  },

  clearGitError: () => set({ gitError: null }),

  performGitAction: async (projectPath, action) => {
    // Reads never reach this method, so gating here means exactly "writes".
    if (isMutatingGitAction(action.kind) && !get().gitConsentGranted) {
      set({ gitConsentPrompt: { projectPath, action } });
      // Null (not a failure): the caller must not treat this as a refusal and
      // must not carry on as if the write had happened.
      return null;
    }
    return get().runGitAction(projectPath, action);
  },

  confirmGitConsent: async () => {
    const prompt = get().gitConsentPrompt;
    // Grant first: the write itself must not be able to leave the app asking
    // the same question again.
    set({ gitConsentGranted: true, gitConsentPrompt: null });
    if (prompt) await get().runGitAction(prompt.projectPath, prompt.action);
  },

  cancelGitConsent: () => set({ gitConsentPrompt: null }),

  loadGitBranches: async (projectPath) => {
    const api = bridge()?.git;
    if (!api) return;
    try {
      const branches = await api.branches(projectPath);
      set({ gitBranches: { ...get().gitBranches, [projectPath]: branches } });
    } catch (error) {
      get().noteFailure(error);
    }
  },

  loadHeadCommitMessage: async (projectPath) => {
    const api = bridge()?.git;
    if (!api) return null;
    try {
      return await api.headMessage(projectPath);
    } catch (error) {
      get().noteFailure(error);
      return null;
    }
  },

  // ---- Folder checkpoints (git-checkpoint plan step 21) ----

  loadCheckpoints: async (projectPath) => {
    const api = bridge()?.checkpoints;
    if (!api) return;
    // Idempotent: the panel mounts this on expand and the strip seeds it for its
    // count badge, so a second call for a folder already read must not refetch.
    // `refreshCheckpoints` is the forced read.
    if (get().checkpoints[projectPath]) return;
    try {
      get().applyCheckpointState(await api.get(projectPath));
    } catch (error) {
      // The section is an enhancement: an unreadable store must not block the
      // session, so the failure is classified and shown, never thrown.
      get().noteFailure(error);
    }
  },

  applyCheckpointState: (state) => {
    const parsed = sanitizeCheckpointState(state);
    if (parsed.projectPath.length === 0) return;
    const next: Record<string, CheckpointState> = {
      ...get().checkpoints,
      [parsed.projectPath]: parsed,
    };
    for (const stale of Object.keys(next).slice(
      0,
      Math.max(0, Object.keys(next).length - MAX_GIT_SNAPSHOTS),
    )) {
      delete next[stale];
    }
    set({ checkpoints: next });
  },

  refreshCheckpoints: async (projectPath) => {
    const api = bridge()?.checkpoints;
    if (!api) return;
    try {
      get().applyCheckpointState(await api.refresh(projectPath));
    } catch (error) {
      get().noteFailure(error);
    }
  },

  createCheckpoint: async (projectPath, label) => {
    return get().runCheckpointAction(
      projectPath,
      label && label.trim().length > 0
        ? { kind: "create", label: label.trim() }
        : { kind: "create" },
    );
  },

  previewCheckpoint: async (projectPath, ref) => {
    const api = bridge()?.checkpoints;
    if (!api) return null;
    try {
      const result = await api.action(projectPath, {
        kind: "preview",
        ref,
      });
      if (!result.ok || !result.preview) {
        set({ checkpointsError: result.error ?? "The preview could not be read." });
        return null;
      }
      set({ checkpointsError: null });
      return result.preview;
    } catch (error) {
      get().noteFailure(error);
      return null;
    }
  },

  restoreCheckpoint: async (projectPath, ref, options = {}) => {
    const result = await get().runCheckpointAction(projectPath, {
      kind: "restore",
      ref,
      ...(options.removeAdded === true ? { removeAdded: true } : {}),
    });
    if (result.ok && result.undoRef) {
      set({
        checkpointsUndoRef: { ...get().checkpointsUndoRef, [projectPath]: result.undoRef },
      });
    }
    return result;
  },

  undoRestoreCheckpoint: async (projectPath) => {
    const ref = get().checkpointsUndoRef[projectPath];
    if (!ref) return { ok: false, error: "There is no restore to undo." };
    const result = await get().runCheckpointAction(projectPath, {
      kind: "restore",
      ref,
    });
    if (result.ok) {
      const next = { ...get().checkpointsUndoRef };
      // The undo is itself one level only: a second Undo would restore the
      // snapshot the undo just took, which is not what the label promises.
      delete next[projectPath];
      set({ checkpointsUndoRef: next });
    }
    return result;
  },

  pruneCheckpoints: async (projectPath) => {
    return get().runCheckpointAction(projectPath, { kind: "prune" });
  },

  clearCheckpointsError: () => set({ checkpointsError: null }),

  runCheckpointAction: async (projectPath, action) => {
    const api = bridge()?.checkpoints;
    if (!api) {
      return { ok: false, error: "The preload bridge is unavailable in this window." };
    }
    try {
      const result = await api.action(projectPath, action);
      // Every action can change the timeline (a snapshot adds a row, a restore
      // rewrites the tree), so one refresh after it keeps the section honest
      // even when main's push is coalesced.
      await get().refreshCheckpoints(projectPath);
      set({ checkpointsError: result.ok ? null : (result.error ?? "The action failed.") });
      return result;
    } catch (error) {
      get().noteFailure(error);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  // ---- Web tabs (plan step 21) ----

  applyWebTabState: (state) =>
    set({ webTabStates: { ...get().webTabStates, [state.tabId]: state } }),

  openWebTab: async (input) => {
    const api = bridge();
    if (!api?.web) {
      set({ hint: "The preload bridge is unavailable." });
      return false;
    }
    // Opening the same page twice focuses the tab that already shows it, so a
    // repeated notification cannot spawn a second review view.
    const existing = get().tabs.find((tab) => tab.kind === "web" && tab.url === input.url);
    if (existing) {
      await get().activateTab(existing.id);
      return true;
    }
    try {
      get().applyTabs(await api.web.open(input));
      set({ view: "session", hint: null });
      return true;
    } catch (error) {
      set({ hint: errorMessage(error) });
      return false;
    }
  },

  openLoopbackUrl: (url, sessionTabId) => {
    const parsed = sanitizeWebUrl(url);
    if (!parsed) return;
    // Already open: leave the user where they are instead of re-focusing the tab
    // on every repeated mention.
    const existing = get().tabs.find((tab) => tab.kind === "web" && tab.url === parsed);
    if (existing) return;
    void get().openWebTab({ url: parsed, ...(sessionTabId ? { sessionTabId } : {}) });
  },

  webCommand: (tabId, command) => {
    const request = bridge()?.web?.command(tabId, command);
    if (request) void request.catch(() => undefined);
  },

  setWebTabBounds: (tabId, bounds) => {
    const request = bridge()?.web?.setBounds(tabId, bounds);
    if (request) void request.catch(() => undefined);
  },

  answerWebNavigation: async (action) => {
    const prompt = get().webNavigationPrompt;
    const api = bridge();
    set({ webNavigationPrompt: null });
    if (!prompt || !api?.web) return;
    const sessionTabId =
      action === "new-tab" ? (get().webTabStates[prompt.tabId]?.sessionTabId ?? null) : null;
    try {
      await api.web.decideNavigation({
        tabId: prompt.tabId,
        url: prompt.url,
        action,
        ...(sessionTabId ? { sessionTabId } : {}),
      });
    } catch (error) {
      set({ hint: errorMessage(error) });
    }
  },

  dismissWebNavigation: () => set({ webNavigationPrompt: null }),
  openWebUrlDialog: () => set({ webUrlDialogOpen: true }),
  closeWebUrlDialog: () => set({ webUrlDialogOpen: false }),

  chatAboutDocument: (pane) => {
    const tabId = get().activeTabId;
    if (!tabId) {
      set({ hint: "Open a session before chatting about a document." });
      return null;
    }
    // Only the session that owns bridge port 38617 can serve the `office_*` call
    // the tag implies. Anywhere else the draft would carry a prompt that cannot
    // be answered, so point at the Documents scope row instead of writing it.
    const state = get();
    const { host, isHost } = officeDocumentScope(
      state.officeDocuments?.panes ?? [],
      state.tabs,
      tabId,
    );
    if (!isHost) {
      set({
        hint: host
          ? `Only the Office host session (“${host.title}”) can use this document. Use “Use this session instead” in the Documents menu to move the bridge here.`
          : "No session is running the Office bridge. Start an Office session from the Documents menu first.",
      });
      return null;
    }
    const tag = officeDocumentTag(pane);
    if (!tag) {
      set({ hint: "That document has no host app, so it cannot be targeted." });
      return null;
    }
    const draft = get().prefs.drafts[tabId] ?? "";
    if (draft.includes(tag)) return tabId;
    const next = draft.trim().length > 0 ? `${tag} ${draft}` : `${tag} `;
    get().setDraft(tabId, next);
    set({ view: "session", hint: null });
    return tabId;
  },

  loadPackages: async (options) => {
    const api = bridge();
    if (!api?.sessions) return;
    const cwd = packageCwd(get());
    const current = get();
    if (options?.refresh !== true && current.packagesLoaded && current.packagesCwd === cwd) return;
    set({ packagesBusy: true, packagesError: null });
    try {
      const raw = await api.sessions.request({
        tabId: CONTROL_TAB_ID,
        method: "packages.list",
        params: { cwd },
      });
      const snapshot = sanitizePackagesSnapshot(raw);
      set({
        packages: snapshot.packages,
        packagesLoaded: true,
        packagesBusy: false,
        packagesError: null,
        packagesCwd: cwd,
      });
    } catch (error) {
      set({ packagesBusy: false, packagesLoaded: true, packagesError: errorMessage(error) });
    }
  },

  requestPackageInstall: (source, scope, cwd, options) => {
    if (
      scope === "project" &&
      settingsTargetForProject(get(), cwd ?? packageCwd(get())) !== "project"
    ) {
      set({
        packagesError:
          "Enable project settings in the project panel before installing a project package.",
      });
      return;
    }
    let normalized: string;
    try {
      normalized = normalizePackageSource(source);
    } catch (error) {
      set({ packagesError: errorMessage(error) });
      return;
    }
    set({
      packagesError: null,
      packageConsent: {
        kind: "install",
        source: normalized,
        name: normalized,
        scope,
        cwd: cwd ?? packageCwd(get()),
        ...(options?.integration ? { integration: options.integration } : {}),
      },
    });
  },

  requestPackageUpdate: (source, scope, cwd) => {
    let normalized: string | null = null;
    if (source !== null) {
      try {
        normalized = normalizePackageSource(source);
      } catch (error) {
        set({ packagesError: errorMessage(error) });
        return;
      }
    }
    set({
      packagesError: null,
      packageConsent: {
        kind: "update",
        source: normalized ?? "*",
        name: normalized ?? "all configured packages",
        scope,
        cwd: cwd ?? packageCwd(get()),
      },
    });
  },

  confirmPackageConsent: async () => {
    const consent = get().packageConsent;
    const api = bridge();
    if (!consent || !api?.sessions) return false;
    set({ packageConsent: null, packagesBusy: true, packagesError: null, packageProgress: null });
    // The echo is the whole point: the host refuses an install whose consent does
    // not name the exact source this dialog displayed (plan step 14).
    const echoed = { source: consent.source, systemAccess: true };
    const params =
      consent.kind === "update"
        ? {
            ...(consent.source === "*" ? {} : { source: consent.source }),
            scope: consent.scope,
            cwd: consent.cwd,
            consent: echoed,
          }
        : { source: consent.source, scope: consent.scope, cwd: consent.cwd, consent: echoed };
    try {
      await api.sessions.request({
        tabId: CONTROL_TAB_ID,
        method: consent.kind === "update" ? "packages.update" : "packages.install",
        params,
      });
      await get().loadPackages({ refresh: true });
      await get().loadSettings();
      await get().loadResources({ refresh: true });
      // An integration's bridge install is recorded in app state as soon as the
      // consented run succeeds (plan step 19); Pi's settings remain the source
      // of truth for whether the package is installed.
      if (consent.kind === "install" && consent.integration === "office") {
        await get().recordOfficeIntegration({ bridgeInstalledAt: new Date().toISOString() });
      }
      set({ packagesBusy: false, packageProgress: null });
      return true;
    } catch (error) {
      set({ packagesBusy: false, packageProgress: null, packagesError: errorMessage(error) });
      return false;
    }
  },

  cancelPackageConsent: () => set({ packageConsent: null }),

  removePackage: async (summary, cwd) => {
    const api = bridge();
    if (!api?.sessions) {
      set({ packagesError: "The preload bridge is unavailable." });
      return false;
    }
    set({ packagesBusy: true, packagesError: null, packageProgress: null });
    try {
      await api.sessions.request({
        tabId: CONTROL_TAB_ID,
        method: "packages.remove",
        params: { source: summary.source, scope: summary.scope, cwd: cwd ?? packageCwd(get()) },
      });
      await get().loadPackages({ refresh: true });
      await get().loadResources({ refresh: true });
      set({ packagesBusy: false, packageProgress: null });
      return true;
    } catch (error) {
      set({ packagesBusy: false, packageProgress: null, packagesError: errorMessage(error) });
      return false;
    }
  },

  pinPackage: (summary, cwd) => {
    const source = pinnedPackageSource(summary);
    if (source) get().requestPackageInstall(source, summary.scope, cwd);
  },

  unpinPackage: (summary, cwd) => {
    const source = unpinnedPackageSource(summary);
    if (source) get().requestPackageInstall(source, summary.scope, cwd);
  },

  createSessionTab: async (kind) => {
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
    if (kind && kind !== "session") input.kind = kind;
    // Project defaults now live in the project's `.pi/settings.json` when its
    // settings toggle is on; the session manager reads them at creation.
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
    const tab = get().tabs.find((entry) => entry.id === tabId);
    if (tab?.kind === "web") return;
    // The rail and the sidebar follow the session that is on screen (2026-10-30
    // project-scoped rail plan): clicking a session in another project also
    // selects that project. Fire-and-forget so waking the host is not delayed.
    if (tab) void get().selectProjectForCwd(tab.cwd);
    // Switching tabs always re-checks; the ensure refreshes extension UI, the
    // TUI surface, shortcuts and the command cache after the host is awake.
    await get().ensureSession(tabId, { force: true });
  },

  ensureSession: async (tabId, options = {}) => {
    const api = bridge();
    const tab = get().tabs.find((entry) => entry.id === tabId);
    if (!api?.sessions || !tab || tab.kind === "web") return false;
    // A crashed/failed tab needs the explicit Restart action (or the banner),
    // not an accidental spawn from a keystroke.
    if (tab.status === "crashed" || tab.status === "failed") return false;
    const inFlight = sessionEnsuring.get(tabId);
    if (inFlight) return inFlight;
    if (!options.force && (tab.status === "idle" || tab.status === "running")) {
      const last = sessionEnsuredAt.get(tabId) ?? 0;
      if (Date.now() - last < SESSION_ENSURE_THROTTLE_MS) return true;
    }
    const run = (async () => {
      try {
        get().applyTabs(await api.sessions.activate(tabId));
        await Promise.all([
          get().loadShortcuts({ refresh: true }),
          get().loadExtensionUi(tabId),
          get().loadTuiSurface(tabId),
        ]);
        get().invalidateCommands(tabId);
        // An ensure may spawn a host from the current bundle, so any stale-host
        // banner for the previous process is obsolete.
        get().clearStaleHost(tabId);
        sessionEnsuredAt.set(tabId, Date.now());
        const current = get().tabs.find((entry) => entry.id === tabId);
        return current?.status !== "failed";
      } catch (error) {
        get().noteFailure(error);
        return false;
      } finally {
        sessionEnsuring.delete(tabId);
      }
    })();
    sessionEnsuring.set(tabId, run);
    return run;
  },

  resyncSessions: async () => {
    const api = bridge();
    if (!api?.sessions) return;
    const now = Date.now();
    if (now - lastSessionResyncAt < SESSION_RESYNC_THROTTLE_MS) return;
    lastSessionResyncAt = now;
    try {
      get().applyTabs(await api.sessions.reconcile());
    } catch {
      // A failed reconcile must not break the shell; fall back to the plain list.
      await get().loadTabs();
    }
    const activeId = get().activeTabId;
    const active = activeId ? get().tabs.find((tab) => tab.id === activeId) : undefined;
    if (activeId && active && active.kind !== "web") {
      await get().ensureSession(activeId, { force: true });
    }
  },

  closeTab: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      get().applyTabs(await api.sessions.close(tabId));
    } catch (error) {
      get().noteFailure(error);
    }
    if (!get().tabs.some((tab) => tab.id === tabId)) {
      purgeClosedTabDialogs(new Set(get().tabs.map((tab) => tab.id)));
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
      get().noteFailure(error);
    }
    purgeClosedTabDialogs(new Set(get().tabs.map((tab) => tab.id)));
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
      get().noteFailure(error);
      void get().loadTabs();
    }
  },

  duplicateTab: async (tabId) => {
    const tab = get().tabs.find((entry) => entry.id === tabId);
    const api = bridge();
    if (!tab || !api?.sessions) return;
    const input: CreateTabInput = { cwd: tab.cwd };
    if (get().sessionTrust.includes(tab.cwd)) input.trust = "session";
    try {
      get().applyTabs(await api.sessions.create(input));
      set({ view: "session", hint: null });
    } catch (error) {
      get().noteFailure(error);
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
      get().noteFailure(error);
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
      get().noteFailure(error);
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
      get().noteFailure(error);
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
      get().noteFailure(error);
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
    // Terminal Pi treats navigating to the current leaf as a no-op (plan step 17).
    if (get().sessionTreeLeafId === targetId) {
      set({ hint: "Already at this point." });
      return;
    }
    set({ sessionTreeBusy: true });
    try {
      const params: Record<string, unknown> = { targetId };
      if (options.summarize) params.summarize = true;
      if (options.label) params.label = options.label;
      if (options.customInstructions) params.customInstructions = options.customInstructions;
      if (options.replaceInstructions) params.replaceInstructions = true;
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
      get().noteFailure(error);
    } finally {
      set({ sessionTreeBusy: false });
    }
  },

  abortBranchSummary: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      await api.sessions.request({ tabId, method: "session.abortBranchSummary" });
      set({ hint: "Branch summary cancelled." });
    } catch (error) {
      get().noteFailure(error);
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
      get().noteFailure(error);
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
      get().noteFailure(error);
    }
  },

  closeFork: () => set({ forkOpen: false, forkCandidates: [] }),

  openSessionInfo: async (tabId) => {
    const api = bridge();
    set({
      sessionInfoOpen: true,
      sessionInfoTabId: tabId,
      sessionInfoData: null,
      sessionInfoError: null,
    });
    if (!api?.sessions) {
      set({ sessionInfoError: "The preload bridge is unavailable." });
      return;
    }
    try {
      const stats = (await api.sessions.request({ tabId, method: "stats.get" })) as Record<
        string,
        unknown
      >;
      const tab = get().tabs.find((entry) => entry.id === tabId);
      const state = get().sessionStates[tabId] as
        | { sessionId?: string | null; sessionFile?: string | null; sessionName?: string | null }
        | undefined;
      const tokens = (stats.tokens ?? null) as SessionInfoView["tokens"];
      set({
        sessionInfoData: {
          tabId,
          sessionId: state?.sessionId ?? null,
          sessionFile: state?.sessionFile ?? null,
          sessionName: state?.sessionName ?? null,
          cwd: tab?.cwd ?? "",
          model: (stats.model ?? null) as SessionInfoView["model"],
          thinkingLevel: typeof stats.thinkingLevel === "string" ? stats.thinkingLevel : null,
          messageCount: typeof stats.messageCount === "number" ? stats.messageCount : 0,
          toolCount: typeof stats.toolCount === "number" ? stats.toolCount : 0,
          streaming: stats.streaming === true,
          pendingMessages: typeof stats.pendingMessages === "number" ? stats.pendingMessages : 0,
          contextUsage: (stats.contextUsage ?? null) as SessionInfoView["contextUsage"],
          tokens,
          steeringMode: typeof stats.steeringMode === "string" ? stats.steeringMode : null,
          followUpMode: typeof stats.followUpMode === "string" ? stats.followUpMode : null,
          autoCompaction: stats.autoCompaction === true,
          autoRetry: stats.autoRetry === true,
        },
        sessionInfoError: null,
      });
    } catch (error) {
      set({ sessionInfoError: errorMessage(error) });
    }
  },

  closeSessionInfo: () =>
    set({ sessionInfoOpen: false, sessionInfoTabId: null, sessionInfoData: null }),

  copyLastAssistant: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return false;
    try {
      const result = (await api.sessions.request({
        tabId,
        method: "session.lastAssistantText",
      })) as { text?: string | null } | undefined;
      const text = typeof result?.text === "string" ? result.text : "";
      if (text.trim().length === 0) {
        set({ hint: "There is no assistant message to copy yet." });
        return false;
      }
      await navigator.clipboard.writeText(text);
      set({ hint: "Copied the last answer." });
      return true;
    } catch (error) {
      get().noteFailure(error);
      return false;
    }
  },

  forkFrom: async (tabId, entryId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      await api.sessions.request({ tabId, method: "session.fork", params: { entryId } });
      get().resetTranscript(tabId);
      await get().hydrateTranscript(tabId);
      set({ forkOpen: false, forkCandidates: [], hint: null });
    } catch (error) {
      get().noteFailure(error);
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
      get().noteFailure(error);
    }
  },

  exportSessionJsonl: async (tabId) => {
    const api = bridge();
    if (!api?.sessions) return;
    try {
      const result = (await api.sessions.request({
        tabId,
        method: "session.exportJsonl",
      })) as { path?: unknown } | undefined;
      const path = typeof result?.path === "string" ? result.path : null;
      if (!path) {
        set({ hint: "The session was exported but the file path was not reported." });
        return;
      }
      await api.revealPath(path);
      set({ hint: `Exported to ${path}` });
    } catch (error) {
      get().noteFailure(error);
    }
  },

  requestImport: async (tabId, path) => {
    let target = path?.trim() ?? "";
    if (target.length === 0) {
      const picked = await bridge()?.pickFile({
        title: "Import a session",
        extensions: ["jsonl"],
      });
      if (!picked) return;
      target = picked;
    }
    // Replacing the open conversation is destructive; ask first (plan step 14).
    set({ importPrompt: { tabId, path: target } });
  },

  cancelImport: () => set({ importPrompt: null }),

  confirmImport: async () => {
    const prompt = get().importPrompt;
    if (!prompt) return;
    const api = bridge();
    set({ importPrompt: null });
    if (!api?.sessions) return;
    try {
      await api.sessions.request({
        tabId: prompt.tabId,
        method: "session.importJsonl",
        params: { path: prompt.path },
      });
      get().resetTranscript(prompt.tabId);
      get().invalidateCommands(prompt.tabId);
      await get().hydrateTranscript(prompt.tabId);
      set({ hint: `Imported ${prompt.path}` });
    } catch (error) {
      get().noteFailure(error);
    }
  },

  openExpandedEditor: (tabId) => {
    const draft = get().prefs.drafts[tabId] ?? "";
    set({ expandedEditorOpen: true, expandedEditorError: null, expandedEditorBusy: false });
    void draft;
  },

  closeExpandedEditor: () =>
    set({ expandedEditorOpen: false, expandedEditorError: null, expandedEditorBusy: false }),

  saveExpandedEditor: (tabId, text) => {
    // A pasted document edited in the dialog is collapsed again on the way back,
    // so the composer never holds a multi-MB buffer (plan step 20's rule).
    const collapsed = collapsePastes(text, (body) => get().registerPaste(tabId, body));
    get().setDraft(tabId, collapsed);
    set({ expandedEditorOpen: false, expandedEditorError: null, expandedEditorBusy: false });
  },

  openExternalEditor: async (tabId) => {
    const api = bridge();
    const setting = get().effectiveSetting("externalEditor");
    if (!api?.share) {
      get().openExpandedEditor(tabId);
      return;
    }
    const draft = get().expandPastes(tabId, get().prefs.drafts[tabId] ?? "");
    set({ expandedEditorBusy: true, expandedEditorError: null });
    try {
      const result = await api.share.editor(draft, typeof setting === "string" ? setting : null);
      if (result.ok && typeof result.text === "string") {
        get().saveExpandedEditor(tabId, result.text);
        return;
      }
      // No OS editor configured (or it failed): keep the in-app editor as the
      // guaranteed path and say what happened. `openExpandedEditor` resets the
      // error slot, so it must run before the error is written.
      get().openExpandedEditor(tabId);
      set({ expandedEditorBusy: false, expandedEditorError: result.error ?? "The editor failed." });
    } catch (error) {
      get().openExpandedEditor(tabId);
      set({ expandedEditorBusy: false, expandedEditorError: errorMessage(error) });
    }
  },

  registerPaste: (tabId, text) => {
    const id = get().pasteCounter;
    const marker = pasteMarkerText(id, text);
    set({
      pasteCounter: id + 1,
      pasteBodies: {
        ...get().pasteBodies,
        [tabId]: { ...(get().pasteBodies[tabId] ?? {}), [id]: text },
      },
    });
    return marker;
  },

  expandPastes: (tabId, text) => {
    const bodies = get().pasteBodies[tabId] ?? {};
    const map = new Map(Object.entries(bodies).map(([key, value]) => [Number(key), value]));
    return map.size === 0 ? text : expandPasteMarkers(text, map);
  },

  openShare: async (tabId) => {
    const api = bridge();
    const sessionFile = get().tabs.find((tab) => tab.id === tabId)?.sessionFile ?? null;
    set({
      shareOpen: true,
      shareMode: "share",
      shareStatus: "running",
      shareResult: null,
      shareError: null,
      shareErrorCode: null,
      shareHint: null,
    });
    if (!api?.share || !sessionFile) {
      set({
        shareStatus: "error",
        shareError: sessionFile
          ? "The preload bridge is unavailable."
          : "This session has no file on disk yet — send a prompt first.",
      });
      return;
    }
    try {
      const result = await api.share.session(sessionFile);
      if (result.ok) {
        set({ shareStatus: "done", shareResult: result });
      } else {
        set({
          shareStatus: "error",
          shareError: result.detail ?? result.error ?? "Sharing failed.",
          shareErrorCode: result.error ?? null,
        });
      }
    } catch (error) {
      set({ shareStatus: "error", shareError: errorMessage(error) });
    }
  },

  openBugReport: async (tabId, hint) => {
    set({
      shareOpen: true,
      shareMode: "bug",
      shareStatus: "idle",
      shareResult: null,
      shareError: null,
      shareErrorCode: null,
      shareHint: hint?.trim() ? hint.trim() : null,
    });
    void tabId;
  },

  setShareIncludeTranscript: (include) => set({ shareIncludeTranscript: include }),

  runBugReport: async () => {
    const api = bridge();
    const state = get();
    const tabId = state.activeTabId;
    const sessionFile = tabId
      ? (state.tabs.find((tab) => tab.id === tabId)?.sessionFile ?? null)
      : null;
    set({ shareStatus: "running", shareError: null, shareErrorCode: null });
    if (!api?.share) {
      set({ shareStatus: "error", shareError: "The preload bridge is unavailable." });
      return;
    }
    try {
      const result = await api.share.bugReport({
        sessionFile,
        includeTranscript: state.shareIncludeTranscript,
        hint: state.shareHint,
        versions: {
          app: state.info?.version ?? null,
          electron: state.info?.electron ?? null,
          node: state.info?.node ?? null,
          chrome: state.info?.chrome ?? null,
          platform: state.info?.platform ?? null,
        },
        diagnostics: state.info ?? null,
      });
      if (result.ok && result.path) {
        set({ shareStatus: "done", shareResult: { path: result.path, bytes: result.bytes } });
        await api.revealPath(result.path);
      } else {
        set({
          shareStatus: "error",
          shareError: result.error ?? "The bug report could not be created.",
        });
      }
    } catch (error) {
      set({ shareStatus: "error", shareError: errorMessage(error) });
    }
  },

  closeShare: () => set({ shareOpen: false }),

  openChangelog: async () => {
    const api = bridge();
    set({ changelogOpen: true, changelogError: null, changelogText: null });
    if (!api?.sessions) {
      set({ changelogError: "The preload bridge is unavailable." });
      return;
    }
    // Any open session host can answer; the changelog is package-level, not
    // session content. Fall back to the control host when no session is open.
    const tabId = get().activeTabId ?? CONTROL_TAB_ID;
    try {
      const result = (await api.sessions.request({
        tabId,
        method: "session.changelog",
      })) as { path?: unknown; text?: unknown } | undefined;
      set({
        changelogPath: typeof result?.path === "string" ? result.path : null,
        changelogText: typeof result?.text === "string" ? result.text : null,
      });
    } catch (error) {
      set({ changelogError: errorMessage(error) });
    }
  },

  closeChangelog: () => set({ changelogOpen: false }),

  resetTranscript: (tabId) => {
    set({
      transcripts: { ...get().transcripts, [tabId]: createTranscriptState() },
    });
  },
}));

/** Imperative access for non-React callers (menu commands, keyboard shortcuts). */
export const appStore = useAppStore;
