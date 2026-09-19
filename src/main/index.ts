import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { IPC, type AppInfo, type WindowState } from "../shared/ipc";
import { appPaths, isSafeMode, type AppPaths } from "./paths";

/**
 * Electron main process entry.
 *
 * Responsibilities for this step: window lifecycle, the allowlisted IPC surface,
 * app/profile paths and safe-mode detection. Tab management, web tabs, the host
 * supervisor and the Office wizard panel are wired into this file by later steps.
 */

const currentDir = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const safeMode = isSafeMode();
const paths: AppPaths = appPaths();

let mainWindow: BrowserWindow | null = null;

/** Only these schemes may be handed to the operating system (plan step 22). */
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export async function openExternal(rawUrl: unknown): Promise<boolean> {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (!EXTERNAL_PROTOCOLS.has(url.protocol)) return false;
  await shell.openExternal(url.toString());
  return true;
}

function currentAppInfo(): AppInfo {
  return {
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron ?? "unknown",
    chrome: process.versions.chrome ?? "unknown",
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    isDev,
    safeMode,
    userDataDir: paths.userData,
    logsDir: paths.logs,
    blobCacheDir: paths.blobCache,
    profileDir: paths.profileDir,
    appStateFile: paths.appStateFile,
  };
}

function windowStateOf(window: BrowserWindow): WindowState {
  return {
    focused: window.isFocused(),
    maximized: window.isMaximized(),
    fullScreen: window.isFullScreen(),
  };
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: "#0f1115",
    title: "Pi Desktop",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(currentDir, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: false,
    },
  });

  window.once("ready-to-show", () => window.show());

  const forwardState = (): void => {
    if (!window.isDestroyed()) window.webContents.send(IPC.windowState, windowStateOf(window));
  };
  window.on("focus", forwardState);
  window.on("blur", forwardState);
  window.on("maximize", forwardState);
  window.on("unmaximize", forwardState);
  window.on("enter-full-screen", forwardState);
  window.on("leave-full-screen", forwardState);

  // The app chrome never opens windows itself; anything that wants a browser
  // goes through the OS, and web tabs are created deliberately (plan step 20).
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url);
    return { action: "deny" };
  });

  window.on("closed", () => {
    mainWindow = null;
  });

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(currentDir, "../renderer/index.html"));
  }

  return window;
}

function registerIpc(): void {
  ipcMain.handle(IPC.appInfo, () => currentAppInfo());
  ipcMain.handle(IPC.openExternal, (_event, url: unknown) => openExternal(url));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    registerIpc();
    mainWindow = createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
