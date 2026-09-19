import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, shell } from "electron";
import { IPC, type AppInfo, type WindowState } from "../shared/ipc";
import type { OfficeStopResult } from "../shared/office-bridge";
import { createHostSupervisor } from "./host-supervisor";
import { broadcastToWindows, registerIpcHandlers } from "./ipc";
import { createOfficeSetupService } from "./office/setup-service";
import { appPaths, isSafeMode, resolveAppRoots, type AppPaths, type AppRoots } from "./paths";
import { resolveAppRuntime, type RuntimeResolution } from "./runtime";

/**
 * Electron main process entry.
 *
 * Responsibilities: window lifecycle, the allowlisted IPC surface, app/profile
 * paths, the bundled-runtime resolution and the Office setup service. Tab
 * management, web tabs and the Pi host supervisor are wired in by later steps.
 */

const currentDir = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const safeMode = isSafeMode();
const paths: AppPaths = appPaths();
const roots: AppRoots = resolveAppRoots({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  mainDir: currentDir,
});
const runtime: RuntimeResolution = resolveAppRuntime({
  isPackaged: app.isPackaged,
  resourcesPath: roots.resourcesDir,
  appRoot: roots.appRoot,
});

let mainWindow: BrowserWindow | null = null;

/**
 * One host process per session tab (plan step 4). Hosts are started by the tab
 * layer (plan step 11); main owns their lifetime so a quit always cleans up.
 */
const hosts = runtime.nodePath
  ? createHostSupervisor({
      nodePath: runtime.nodePath,
      hostPath: runtime.piHostPath,
      binDir: runtime.binDir,
      logDir: paths.logs,
      blobDir: paths.blobCache,
      profileDir: paths.profileDir,
    })
  : null;

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
    runtimeSource: runtime.source,
    runtimeNodeVersion: runtime.nodeVersion,
    runtimeProblems: runtime.problems,
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

const officeSetup = createOfficeSetupService({
  agentDir: paths.profileDir,
  cwd: app.getPath("home"),
  manifestPath: roots.manifestPath,
  nodePath: runtime.nodePath,
  npmCliPath: runtime.npmCliPath,
  dryRun: process.env.PI_DESKTOP_OFFICE_DRY_RUN === "1",
  backupDir: join(paths.userData, "backups"),
  openPath: (target) => shell.openPath(target),
  openExternal: async (url) => {
    await shell.openExternal(url);
  },
  appInfo: {
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron ?? null,
    node: process.versions.node,
    chrome: process.versions.chrome ?? null,
    platform: process.platform,
    arch: process.arch,
    osRelease: process.getSystemVersion?.() ?? null,
  },
  onView: (view) => broadcastToWindows(IPC.officeState, view),
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    registerIpcHandlers({
      appInfo: currentAppInfo,
      openExternal,
      officeSetup,
      // The Office session owns the bridge and the app owns the session, so Stop
      // aborts that session's run — which ends a pane's answer for every bridge
      // version (protocol v3 additionally lets a pane stop its own run).
      officeRun: {
        stop: async (): Promise<OfficeStopResult> => {
          const host = hosts?.get("office");
          if (!host) return { ok: false, reason: "idle" };
          try {
            await host.request("abort");
            return { ok: true };
          } catch (error) {
            return {
              ok: false,
              reason: "failed",
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
      },
    });
    mainWindow = createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    void hosts?.stopAll();
  });
}
