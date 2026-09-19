/**
 * The IPC surface between the Electron main process and the renderer.
 *
 * Everything the renderer is allowed to do must be listed here:
 * `src/preload/index.ts` exposes exactly these calls on `window.pi`, and
 * `src/main/index.ts` registers exactly these channels. Adding a channel means
 * touching all three files — that is the allowlist (plan step 22).
 */

export const IPC = {
  /** Renderer → main: application, version and profile information. */
  appInfo: "app:info",
  /** Renderer → main: open a URL in the user's browser (validated in main). */
  openExternal: "app:open-external",
  /** Main → renderer: window focus / maximise / fullscreen changes. */
  windowState: "app:window-state",
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
}

export interface WindowState {
  focused: boolean;
  maximized: boolean;
  fullScreen: boolean;
}

/** The complete API exposed to the renderer as `window.pi`. */
export interface PiDesktopBridge {
  getAppInfo(): Promise<AppInfo>;
  openExternal(url: string): Promise<boolean>;
  onWindowState(listener: (state: WindowState) => void): () => void;
}
