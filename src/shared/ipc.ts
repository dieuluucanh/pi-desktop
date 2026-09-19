import type { OfficeSetupStepId, OfficeSetupView } from "./office-setup";

/**
 * The IPC surface between the Electron main process and the renderer.
 *
 * Everything the renderer is allowed to do must be listed here:
 * `src/preload/index.ts` exposes exactly these calls on `window.pi`, and
 * `src/main/ipc.ts` registers exactly these channels. Adding a channel means
 * touching all three files — that is the allowlist (plan step 22).
 */

export const IPC = {
  /** Renderer → main: application, version and profile information. */
  appInfo: "app:info",
  /** Renderer → main: open a URL in the user's browser (validated in main). */
  openExternal: "app:open-external",
  /** Main → renderer: window focus / maximise / fullscreen changes. */
  windowState: "app:window-state",

  /** Office wizard (plan step 3). */
  officeGet: "office:get",
  officeStart: "office:start",
  officeRetry: "office:retry",
  officeCancel: "office:cancel",
  officeRefreshHealth: "office:refresh-health",
  officeUnsideload: "office:unsideload",
  officeDiagnostics: "office:diagnostics",
  officeReveal: "office:reveal",
  /** Main → renderer: a new wizard state. */
  officeState: "office:state",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

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

/** Pi for Office setup wizard (plan step 3). */
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
  onState(listener: (view: OfficeSetupView) => void): () => void;
}

/** The complete API exposed to the renderer as `window.pi`. */
export interface PiDesktopBridge {
  getAppInfo(): Promise<AppInfo>;
  openExternal(url: string): Promise<boolean>;
  onWindowState(listener: (state: WindowState) => void): () => void;
  office: OfficeBridge;
}
