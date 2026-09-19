import type { OfficeSetupStepId, OfficeSetupView } from "./office-setup";
import type { OfficeStopResult } from "./office-bridge";
import type { UiPrefs } from "./prefs";
import type {
  CreateTabInput,
  SessionEventEnvelope,
  SessionRequestInput,
  SessionStateEnvelope,
  SessionTabsEnvelope,
} from "./session-ipc";

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
  sessionActivate: "session:activate",
  sessionRestore: "session:restore",
  sessionRequest: "session:request",
  /** Main → renderer: a batch of host events for one tab. */
  sessionEvent: "session:event",
  /** Main → renderer: the latest state snapshot for one tab. */
  sessionState: "session:state",
  /** Main → renderer: the tab table changed (created, closed, status). */
  sessionTabsChanged: "session:tabs-changed",

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
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/** Commands the application menu can send to the renderer. */
export const MENU_COMMANDS = [
  "new-session",
  "open-project",
  "close-session",
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
  activate(tabId: string): Promise<SessionTabsEnvelope>;
  restore(): Promise<SessionTabsEnvelope>;
  /** Runs any host protocol method against a tab's host. */
  request(input: SessionRequestInput): Promise<unknown>;
  onEvent(listener: (envelope: SessionEventEnvelope) => void): () => void;
  onState(listener: (envelope: SessionStateEnvelope) => void): () => void;
  onTabs(listener: (envelope: SessionTabsEnvelope) => void): () => void;
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
}

/** UI preferences persisted by the main process (plan step 1). */
export interface PrefsBridge {
  get(): Promise<UiPrefs>;
  set(patch: Partial<UiPrefs>): Promise<UiPrefs>;
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
  office: OfficeBridge;
}
