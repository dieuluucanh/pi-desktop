import type { OfficeSetupStepId, OfficeSetupView } from "./office-setup";
import type { OfficeStopResult } from "./office-bridge";
import type { OfficeDocumentsView } from "./office-documents";
import type { DiagnosticsExport, DiagnosticsSnapshot } from "./diagnostics";
import type { IntegrationsState, OfficeIntegrationRecordPatch } from "./integrations";
import type { UiPrefs } from "./prefs";
import type { ProfileMode } from "./profile";
import type {
  GitAction,
  GitActionResult,
  GitCommitEntry,
  GitDiff,
  GitDiffRequest,
  GitLogRequest,
  GitSnapshot,
} from "./git";
import type { CheckpointAction, CheckpointActionResult, CheckpointState } from "./checkpoints";
import type { HostMethod } from "./host-protocol";
import type { UpdateState } from "./updates";
import type {
  CloneProjectInput,
  CreateProjectInput,
  ProjectActionInput,
  ProjectMutation,
  ProjectSettingsToggleInput,
  ProjectSettingsToggleResult,
  ProjectsSnapshot,
} from "./projects";
import type {
  CreateTabInput,
  SessionEventEnvelope,
  SessionRequestInput,
  SessionStateEnvelope,
  SessionTabsEnvelope,
} from "./session-ipc";
import type {
  WebCommand,
  WebNavigationDecision,
  WebNavigationRequest,
  WebTabBounds,
  WebTabState,
} from "./web-tabs";

/**
 * The IPC surface between the Electron main process and the renderer.
 *
 * Everything the renderer is allowed to do must be listed here:
 * `src/preload/index.ts` exposes exactly these calls on `window.pi`, and
 * `src/main/ipc.ts` registers exactly these channels. Adding a channel means
 * touching all three files — that is the allowlist (plan step 23).
 */

export const IPC = {
  /** Renderer → main: application, version and profile information. */
  appInfo: "app:info",
  /** Renderer → main: open a URL in the user's browser (validated in main). */
  openExternal: "app:open-external",
  /** Renderer → main: native folder picker; resolves to null when cancelled. */
  appPickDirectory: "app:pick-directory",
  /** Renderer → main: native file picker (session JSONL import). */
  appPickFile: "app:pick-file",
  /** Renderer → main: upload a session file as a secret gist (`/share`). */
  shareSession: "share:session",
  /** Renderer → main: build a local bug-report zip (`/bug`). */
  shareBugReport: "share:bug-report",
  /** Renderer → main: open the draft in the configured OS editor and wait. */
  editorOpen: "editor:open",
  /** Renderer → main: reveal a path in the OS file manager. */
  appRevealPath: "app:reveal-path",
  /** Renderer → main: set the window title (app chrome owns it, not the menu). */
  appSetTitle: "app:set-title",
  /** Renderer → main: relaunch the app (a profile change needs a restart). */
  appRelaunch: "app:relaunch",
  /** Renderer → main: read the persisted UI preferences. */
  prefsGet: "prefs:get",
  /** Renderer → main: merge a partial preference patch (closed key set). */
  prefsSet: "prefs:set",
  /** Main → renderer: window focus / maximise / fullscreen changes. */
  windowState: "app:window-state",
  /** Main → renderer: an application-menu command (New Session, Settings, …). */
  appMenuCommand: "app:menu-command",

  /** Sessions (plan step 3): tabs are the renderer's handle on a Pi host. */
  sessionTabs: "session:tabs",
  sessionCreate: "session:create",
  sessionClose: "session:close",
  /** Closes every tab except one (plan step 11). */
  sessionCloseOthers: "session:close-others",
  /** Moves a tab to a new index (plan step 11 drag-reorder). */
  sessionReorder: "session:reorder",
  /** Makes one tab the single Office host, owning the bridge port (plan step 20). */
  sessionPromoteOffice: "session:promote-office",
  sessionActivate: "session:activate",
  sessionRestore: "session:restore",
  /** Re-checks host/session readiness after suspend or a missed push (no spawn). */
  sessionReconcile: "session:reconcile",
  /** Stops and re-spawns a tab's host, resuming its session (plan step 22). */
  sessionRestart: "session:restart",
  sessionRequest: "session:request",
  /** Deletes a session to the OS trash (plan step 11; validated in main). */
  sessionDelete: "session:delete",
  /** Main → renderer: a batch of host events for one tab. */
  sessionEvent: "session:event",
  /** Main → renderer: the latest state snapshot for one tab. */
  sessionState: "session:state",
  /** Main → renderer: the tab table changed (created, closed, status). */
  sessionTabsChanged: "session:tabs-changed",

  /** Projects and workspace management (plan step 10). */
  projectsGet: "projects:get",
  projectsMutate: "projects:mutate",
  projectsCreate: "projects:create",
  projectsClone: "projects:clone",
  projectsAction: "projects:action",
  /** Enables/disables project-scoped settings for one project. */
  projectsSetSettings: "projects:set-settings",

  /** Office wizard (plan step 1 UI, step 19 card). */
  officeGet: "office:get",
  officeStart: "office:start",
  officeRetry: "office:retry",
  officeCancel: "office:cancel",
  officeRefreshHealth: "office:refresh-health",
  officeUnsideload: "office:unsideload",
  officeDiagnostics: "office:diagnostics",
  officeReveal: "office:reveal",
  officeStopRun: "office:stop-run",
  /** Main → renderer: a new wizard state. */
  officeState: "office:state",

  /**
   * The live Office pane registry (plan step 20). The main process polls the
   * bridge's `/health` and pushes the projected view; the Documents panel and
   * the `#` completion source read it from the renderer store.
   */
  officeDocuments: "office:documents",
  officeDocumentsRefresh: "office:documents-refresh",
  /** Main → renderer: the pane registry changed. */
  officeDocumentsState: "office:documents-state",

  /**
   * Integrations (plan step 19): the app's own record of a consented install,
   * separate from Pi's settings (which the package manager owns).
   */
  integrationsGet: "integrations:get",
  integrationsRecordOffice: "integrations:record-office",

  /** Web tabs (plan step 21): isolated views for localhost/Plannotator pages. */
  webOpen: "web:open",
  webSetBounds: "web:set-bounds",
  webCommand: "web:command",
  webNavigationDecision: "web:navigation-decision",
  /** Main → renderer: one web tab's state changed. */
  webState: "web:state",
  /** Main → renderer: a navigation left the review and needs a decision. */
  webNavigationRequest: "web:navigation-request",

  /**
   * Diagnostics (plan step 22): the app-wide snapshot, the redacted export
   * bundle, a file-save step and renderer-reported incidents.
   */
  diagnosticsGet: "diagnostics:get",
  diagnosticsExport: "diagnostics:export",
  diagnosticsSave: "diagnostics:save",
  diagnosticsRecord: "diagnostics:record",

  /** Updates (plan step 26): checking GitHub Releases and installing a build. */
  updatesGet: "updates:get",
  updatesCheck: "updates:check",
  updatesDownload: "updates:download",
  updatesInstall: "updates:install",
  /** Main → renderer: the updater's state changed. */
  updatesState: "updates:state",

  /**
   * Source control (git-checkpoint plan step 7). The renderer addresses a
   * *project folder*, never a repository path or an argv: main resolves the work
   * tree, validates every action against it, and answers with the snapshot the
   * rail renders.
   */
  gitSnapshot: "git:snapshot",
  /** Re-reads now, bypassing the main-process memo. */
  gitRefresh: "git:refresh",
  /** Starts/stops the background status poll for one folder. */
  gitWatch: "git:watch",
  /** Runs one validated action from the closed `GitAction` union. */
  gitAction: "git:action",
  /** One diff side, for the viewer. */
  gitDiff: "git:diff",
  /** One page of the commit log. */
  gitLog: "git:log",
  /** HEAD's full commit message, for the amend box. */
  gitHeadMessage: "git:head-message",
  /** Local branch names, for the checkout menu. */
  gitBranches: "git:branches",
  /** Main → renderer: a folder's snapshot changed. */
  gitPushed: "git:state",

  /**
   * Folder checkpoints (git-checkpoint plan step 21). Same shape as git: a
   * hydration pair (`get`/`refresh`) plus a push, so the section can render
   * immediately after a relaunch and still update live.
   */
  checkpointsGet: "checkpoints:get",
  checkpointsRefresh: "checkpoints:refresh",
  /** Runs one validated action from the closed `CheckpointAction` union. */
  checkpointsAction: "checkpoints:action",
  /** Main → renderer: a project's checkpoint state changed. */
  checkpointsPushed: "checkpoints:state",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/** Commands the application menu can send to the renderer. */
export const MENU_COMMANDS = [
  "new-session",
  "open-project",
  "open-web-url",
  "close-session",
  "view-sessions",
  "next-tab",
  "previous-tab",
  "command-palette",
  "toggle-sidebar",
  "view-settings",
  "view-extensions",
  "view-connections",
  "view-skills",
  "view-diagnostics",
  "view-office",
  "shortcuts",
  // Updates (plan step 26).
  "check-updates",
  // Session history (plan step 11).
  "session-tree",
  "session-fork",
  "session-export",
  // Model / thinking cycling (plan step 8). The Electron menu owns the
  // accelerators; the renderer never registers a second key handler for them.
  "model-cycle-forward",
  "model-cycle-backward",
  "thinking-cycle",
  // The right rail (git-checkpoint plan step 10): one toggle plus the two
  // commands that open it on a specific section.
  "toggle-rail",
  "view-source-control",
  "view-checkpoints",
] as const;

export type MenuCommand = (typeof MENU_COMMANDS)[number];

export function isMenuCommand(value: unknown): value is MenuCommand {
  return typeof value === "string" && (MENU_COMMANDS as readonly string[]).includes(value);
}

export interface AppInfo {
  name: string;
  version: string;
  /** Versions of the Electron app process — not of the bundled Pi host runtime. */
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  isDev: boolean;
  safeMode: boolean;
  /** True when `PI_OFFLINE` disables Pi's startup network calls (plan step 22). */
  piOffline: boolean;
  userDataDir: string;
  /** The user's home folder (`app.getPath("home")`), for “quick session in home”. */
  homeDir: string;
  logsDir: string;
  blobCacheDir: string;
  /** `~/.pi/agent` unless `PI_CODING_AGENT_DIR` overrides it (plan D8). */
  profileDir: string;
  /** Which profile strategy resolved {@link profileDir} (`shared` or `app`). */
  profileMode: ProfileMode;
  /** Pi files inside the profile, resolved by the main process (plan step 1). */
  settingsFile: string;
  authFile: string;
  modelsFile: string;
  appStateFile: string;
  /** Bundled runtime status (plan step 2). */
  runtimeSource: string | null;
  runtimeNodeVersion: string | null;
  runtimeProblems: string[];
  /**
   * The host methods this main process accepts (`HOST_METHODS` as compiled into
   * main). The renderer compares this with the methods it needs: in development
   * a hot-reloaded renderer can be newer than a main process started before the
   * method was added, and without this check the user sees a raw
   * `session: unsupported host method …` IPC error.
   */
  hostMethods: HostMethod[];
}

export interface WindowState {
  focused: boolean;
  maximized: boolean;
  fullScreen: boolean;
}

/** Session tabs and host events (plan step 3). */
export interface SessionsBridge {
  list(): Promise<SessionTabsEnvelope>;
  create(input: CreateTabInput): Promise<SessionTabsEnvelope>;
  close(tabId: string): Promise<SessionTabsEnvelope>;
  /** Closes every tab except `tabId`, keeping that one active. */
  closeOthers(tabId: string): Promise<SessionTabsEnvelope>;
  /** Moves a tab within the strip; persisted so the order survives a relaunch. */
  reorder(tabId: string, toIndex: number): Promise<SessionTabsEnvelope>;
  /** Makes this tab the single Office host (plan step 20), restarting its host. */
  promoteOfficeHost(tabId: string): Promise<SessionTabsEnvelope>;
  activate(tabId: string): Promise<SessionTabsEnvelope>;
  /** Makes the tab table truthful after sleep/resume or a lost host. */
  reconcile(): Promise<SessionTabsEnvelope>;
  restore(): Promise<SessionTabsEnvelope>;
  /** Recovers a crashed/wedged host by re-spawning it (plan step 22). */
  restart(tabId: string): Promise<SessionTabsEnvelope>;
  /** Runs any host protocol method against a tab's host. */
  request(input: SessionRequestInput): Promise<unknown>;
  /**
   * Deletes a session file to the OS trash (plan step 11). The control host
   * validates the path against Pi's session index; main does the recoverable
   * delete. Returns the resolved path, or a reason it was refused.
   */
  deleteSession(sessionFile: string): Promise<SessionDeleteResult>;
  onEvent(listener: (envelope: SessionEventEnvelope) => void): () => void;
  onState(listener: (envelope: SessionStateEnvelope) => void): () => void;
  onTabs(listener: (envelope: SessionTabsEnvelope) => void): () => void;
}

/** The outcome of a session deletion (plan step 11). */
export interface SessionDeleteResult {
  ok: boolean;
  /** The trashed session file, when `ok` is true. */
  path?: string;
  /** A user-readable reason the deletion was refused. */
  error?: string;
}

/** Pi for Office setup wizard (plan step 1 UI, step 19 card). */
export interface OfficeBridge {
  get(): Promise<OfficeSetupView>;
  start(): Promise<OfficeSetupView>;
  retry(step: OfficeSetupStepId): Promise<OfficeSetupView>;
  cancel(): Promise<OfficeSetupView>;
  refreshHealth(): Promise<OfficeSetupView>;
  unsideload(): Promise<OfficeSetupView>;
  diagnostics(): Promise<string>;
  /** Reveals a generated file (manifest copy, settings.json) in the file manager. */
  reveal(path: string): Promise<boolean>;
  /**
   * Stops the Office session's current run — the one a task pane started. The app
   * owns that session, so this works against every bridge version; protocol v3
   * additionally lets a pane stop its own run.
   */
  stopRun(): Promise<OfficeStopResult>;
  onState(listener: (view: OfficeSetupView) => void): () => void;
  /** The last pane-registry probe (plan step 20); never null. */
  documents(): Promise<OfficeDocumentsView>;
  /** Probes `/health` now and resolves with the fresh registry. */
  refreshDocuments(): Promise<OfficeDocumentsView>;
  /** Main → renderer: the pane registry changed. */
  onDocuments(listener: (view: OfficeDocumentsView) => void): () => void;
}

/** UI preferences persisted by the main process (plan step 1). */
export interface PrefsBridge {
  get(): Promise<UiPrefs>;
  set(patch: Partial<UiPrefs>): Promise<UiPrefs>;
}

/**
 * Integrations (plan step 19). The record is the app's own note that the user
 * consented to the Office bridge install and when setup last completed; Pi's
 * settings.json remains the record of *whether* the package is installed.
 */
export interface IntegrationsBridge {
  get(): Promise<IntegrationsState>;
  recordOffice(patch: OfficeIntegrationRecordPatch): Promise<IntegrationsState>;
}

/** A create/clone result plus the project list it produced (plan step 10). */
export interface ProjectOpResponse extends ProjectsSnapshot {
  ok: boolean;
  path: string | null;
  error?: string;
}

/** Projects and workspace management (plan step 10). */
export interface ProjectsBridge {
  get(): Promise<ProjectsSnapshot>;
  mutate(input: ProjectMutation): Promise<ProjectsSnapshot>;
  create(input: CreateProjectInput): Promise<ProjectOpResponse>;
  clone(input: CloneProjectInput): Promise<ProjectOpResponse>;
  action(input: ProjectActionInput): Promise<boolean>;
  /** Snapshot/empty or restore the project's `.pi/settings.json`. */
  setSettings(input: ProjectSettingsToggleInput): Promise<ProjectSettingsToggleResult>;
}

/** Web tabs (plan step 21) — the renderer's handle on an isolated `WebContentsView`. */
export interface WebTabOpenInput {
  url: string;
  /** The project the tab belongs to, when one is open. */
  cwd?: string;
  /** The session tab this web tab links back to (Plannotator). */
  sessionTabId?: string | null;
}

export interface WebBridge {
  /** Opens a page in a new web tab (or reuses an existing one for the same URL). */
  open(input: WebTabOpenInput): Promise<SessionTabsEnvelope>;
  /** Tells main where the active view's rectangle is; fire-and-forget. */
  setBounds(tabId: string, bounds: WebTabBounds): Promise<boolean>;
  /** Runs a chrome command (back/forward/reload/stop/zoom/navigate). */
  command(tabId: string, command: WebCommand): Promise<boolean>;
  /** Answers a navigation-request: open in tab, external browser, or dismiss. */
  decideNavigation(decision: WebNavigationDecision): Promise<boolean>;
  onState(listener: (state: WebTabState) => void): () => void;
  onNavigationRequest(listener: (request: WebNavigationRequest) => void): () => void;
}

/** `/share` and `/bug` (2026-10-26 session-parity plan step 18). */
export interface ShareBridge {
  /** Uploads the session JSONL as a **secret** gist and returns the viewer URL. */
  session(sessionFile: string): Promise<{
    ok: boolean;
    gistUrl?: string;
    viewerUrl?: string;
    file?: string;
    error?: string;
    detail?: string;
  }>;
  /** Builds a local bug-report zip; the path is revealed by the caller. */
  bugReport(input: {
    sessionFile?: string | null;
    includeTranscript: boolean;
    hint?: string | null;
    versions: Record<string, string | null | undefined>;
    diagnostics?: unknown;
  }): Promise<{ ok: boolean; path?: string; bytes?: number; error?: string }>;
  /**
   * Opens the draft in the configured OS editor and resolves when it exits.
   * `ok: false` with `error: "no_editor"` means "use the in-app editor".
   */
  editor(
    draft: string,
    setting?: string | null,
  ): Promise<{
    ok: boolean;
    text?: string;
    error?: string;
    source?: string | null;
  }>;
}

/** The complete API exposed to the renderer as `window.pi`. */
export interface DiagnosticsSaveResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/** Diagnostics (plan step 22). */
export interface DiagnosticsBridge {
  /** The current snapshot: hosts, logs, incidents, Office state, environment. */
  get(): Promise<DiagnosticsSnapshot>;
  /** The redacted support bundle, without writing anything. */
  export(): Promise<DiagnosticsExport>;
  /** Asks the user where to save, then writes the bundle there. */
  save(): Promise<DiagnosticsSaveResult>;
  /** Reports a renderer failure (unhandled rejection) into the incident list. */
  record(incident: {
    kind?: string;
    message: string;
    detail?: string;
    tabId?: string;
  }): Promise<boolean>;
}

/** Updates (plan step 26): checking GitHub Releases and installing a build. */
export interface UpdatesBridge {
  /** The current updater state (never throws; unsupported in a dev build). */
  get(): Promise<UpdateState>;
  /** Starts a check; resolves with the state once the feed answers. */
  check(): Promise<UpdateState>;
  /** Downloads the offered update. */
  download(): Promise<UpdateState>;
  /** Quits and installs a downloaded update; false when none is ready. */
  install(): Promise<boolean>;
  /** Main → renderer: the updater's state changed. */
  onState(listener: (state: UpdateState) => void): () => void;
}

/**
 * Source control (git-checkpoint plan step 7).
 *
 * `projectPath` is the *folder* the user opened (a tab's cwd or a remembered
 * project), never a repository path: main resolves the work tree itself, so a
 * renderer cannot point git at an arbitrary directory.
 */
export interface GitBridge {
  /** The folder's snapshot; never throws (an unavailable state carries a reason). */
  snapshot(projectPath: string): Promise<GitSnapshot>;
  /** Re-reads immediately, bypassing main's short-lived memo. */
  refresh(projectPath: string): Promise<GitSnapshot>;
  /**
   * Starts or stops the background poll. The rail watches only while its Git
   * section is visible, so a hidden panel costs nothing.
   */
  watch(projectPath: string, enabled: boolean): Promise<boolean>;
  /** Runs one action from the closed union; resolves to a classified result. */
  action(projectPath: string, action: GitAction): Promise<GitActionResult>;
  /** One diff side, for the viewer. */
  diff(projectPath: string, request: GitDiffRequest): Promise<GitDiff>;
  /** One page of the commit log. */
  log(projectPath: string, request?: GitLogRequest): Promise<GitCommitEntry[]>;
  /**
   * HEAD's complete commit message, or null when there is no commit yet. Used to
   * prefill the amend box: a subject-only prefill would drop the body.
   */
  headMessage(projectPath: string): Promise<string | null>;
  /** Local branch names, sorted, for the checkout menu. */
  branches(projectPath: string): Promise<string[]>;
  /** Main → renderer: a watched folder's snapshot changed. */
  onSnapshot(listener: (snapshot: GitSnapshot) => void): () => void;
}

/**
 * Folder checkpoints (git-checkpoint plan step 21).
 *
 * The pair `get`/`refresh` exists for the same reason `office.documents()` /
 * `refreshDocuments()` exists: the section has to render something on mount,
 * after a relaunch, before any push arrives.
 */
export interface CheckpointsBridge {
  /** The folder's checkpoint surface; never throws (a disabled state says why). */
  get(projectPath: string): Promise<CheckpointState>;
  /** Re-reads the timeline and the usage numbers. */
  refresh(projectPath: string): Promise<CheckpointState>;
  /** Runs one action from the closed union. */
  action(projectPath: string, action: CheckpointAction): Promise<CheckpointActionResult>;
  /** Main → renderer: a project's checkpoint state changed. */
  onState(listener: (state: CheckpointState) => void): () => void;
}

/** The complete API exposed to the renderer as `window.pi`. */
export interface PiDesktopBridge {
  getAppInfo(): Promise<AppInfo>;
  openExternal(url: string): Promise<boolean>;
  /** Native folder picker; resolves to null when the user cancels. */
  pickDirectory(): Promise<string | null>;
  /** Native file picker for a session JSONL import; null when cancelled. */
  pickFile(options?: { title?: string; extensions?: string[] }): Promise<string | null>;
  revealPath(path: string): Promise<boolean>;
  setTitle(title: string): Promise<boolean>;
  /** Relaunches the app; used after a profile-mode change (plan step 26). */
  relaunch(): Promise<boolean>;
  onWindowState(listener: (state: WindowState) => void): () => void;
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
  prefs: PrefsBridge;
  sessions: SessionsBridge;
  share: ShareBridge;
  projects: ProjectsBridge;
  office: OfficeBridge;
  integrations: IntegrationsBridge;
  web: WebBridge;
  diagnostics: DiagnosticsBridge;
  updates: UpdatesBridge;
  git: GitBridge;
  checkpoints: CheckpointsBridge;
}
