import type { OfficeSetupStepId, OfficeSetupView } from "./office-setup";
import type { OfficeStopResult } from "./office-bridge";
import type { OfficeDocumentsView } from "./office-documents";
import type { IntegrationsState, OfficeIntegrationRecordPatch } from "./integrations";
import type { UiPrefs } from "./prefs";
import type {
  CloneProjectInput,
  CreateProjectInput,
  ProjectActionInput,
  ProjectMutation,
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
  /** Renderer → main: reveal a path in the OS file manager. */
  appRevealPath: "app:reveal-path",
  /** Renderer → main: set the window title (app chrome owns it, not the menu). */
  appSetTitle: "app:set-title",
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
  // Session history (plan step 11).
  "session-tree",
  "session-fork",
  "session-export",
  // Model / thinking cycling (plan step 8). The Electron menu owns the
  // accelerators; the renderer never registers a second key handler for them.
  "model-cycle-forward",
  "model-cycle-backward",
  "thinking-cycle",
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
  userDataDir: string;
  /** The user's home folder (`app.getPath("home")`), for “quick session in home”. */
  homeDir: string;
  logsDir: string;
  blobCacheDir: string;
  /** `~/.pi/agent` unless `PI_CODING_AGENT_DIR` overrides it (plan D8). */
  profileDir: string;
  /** Pi files inside the profile, resolved by the main process (plan step 1). */
  settingsFile: string;
  authFile: string;
  modelsFile: string;
  appStateFile: string;
  /** Bundled runtime status (plan step 2). */
  runtimeSource: string | null;
  runtimeNodeVersion: string | null;
  runtimeProblems: string[];
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
  restore(): Promise<SessionTabsEnvelope>;
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

/** The complete API exposed to the renderer as `window.pi`. */
export interface PiDesktopBridge {
  getAppInfo(): Promise<AppInfo>;
  openExternal(url: string): Promise<boolean>;
  /** Native folder picker; resolves to null when the user cancels. */
  pickDirectory(): Promise<string | null>;
  revealPath(path: string): Promise<boolean>;
  setTitle(title: string): Promise<boolean>;
  onWindowState(listener: (state: WindowState) => void): () => void;
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
  prefs: PrefsBridge;
  sessions: SessionsBridge;
  projects: ProjectsBridge;
  office: OfficeBridge;
  integrations: IntegrationsBridge;
  web: WebBridge;
}
