import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, clipboard, dialog, shell } from "electron";
import { IPC, type AppInfo, type ProjectOpResponse, type WindowState } from "../shared/ipc";
import type { OfficeStopResult } from "../shared/office-bridge";
import type {
  CloneProjectInput,
  CreateProjectInput,
  ProjectActionInput,
  ProjectMutation,
} from "../shared/projects";
import type { CreateTabInput } from "../shared/session-ipc";
import { createAppStore } from "./app-store";
import { createNodeFsPort } from "./fs-port";
import { createHostSupervisor } from "./host-supervisor";
import {
  broadcastToWindows,
  registerIpcHandlers,
  revealPathWithShell,
  sanitizeTitle,
  type IpcSessionDeps,
} from "./ipc";
import { installAppMenu } from "./menu";
import { createCommandRunner } from "./office/exec";
import { createProjectOps } from "./project-ops";
import { createProjectsService } from "./projects-service";
import {
  createSessionService,
  type SessionEmitChannel,
  type SessionService,
} from "./session-service";
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

// Electron's own state directory can be redirected from the environment. The E2E
// harness needs a guaranteed-private userData (a Chromium switch after the app
// path is not reliably honoured), and it doubles as profile isolation later.
const userDataOverride = process.env.PI_DESKTOP_USER_DATA_DIR?.trim();
if (userDataOverride) app.setPath("userData", userDataOverride);

const paths: AppPaths = appPaths();

// E2E runs print where they landed so a failed launch is diagnosable from the
// harness output (the app is otherwise silent on a successful start).
if (process.env.PI_DESKTOP_E2E === "1") {
  console.error(
    `[pi-desktop] e2e userData=${paths.userData} profile=${paths.profileDir} safeMode=${safeMode}`,
  );
}
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

/** The app's own state (tabs, recents, UI preferences) — never Pi state. */
const appState = createAppStore({
  file: paths.appStateFile,
  onError: (error) => {
    console.error("[pi-desktop] app state:", error instanceof Error ? error.message : error);
  },
});

let mainWindow: BrowserWindow | null = null;

/** The remembered project list (plan step 10): `app-state.json` is its only writer. */
const projectsService = createProjectsService({ store: appState });

/** Create/clone/reveal/terminal/clipboard for projects (plan step 10). */
const projectOps = createProjectOps({
  fs: createNodeFsPort(),
  runner: createCommandRunner(),
  reveal: revealPathWithShell,
  openTerminal: launchTerminal,
  copyText: async (text) => {
    clipboard.writeText(text);
    return true;
  },
});

/** The IPC channel each session push channel maps to. */
const SESSION_CHANNELS: Record<SessionEmitChannel, string> = {
  event: IPC.sessionEvent,
  state: IPC.sessionState,
  tabs: IPC.sessionTabsChanged,
};

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

/**
 * The session service (plan step 3): the app's only path to a Pi host. It needs a
 * supervisor, so it is absent when the bundled runtime could not be resolved —
 * in which case the renderer gets a precise error instead of a silent no-op.
 */
const sessions: SessionService | null = hosts
  ? createSessionService({
      supervisor: hosts,
      store: appState,
      controlCwd: app.getPath("home"),
      emit: (channel, payload) => broadcastToWindows(SESSION_CHANNELS[channel], payload),
    })
  : null;

function requireSessions(): SessionService {
  if (!sessions) {
    throw new Error("The bundled Pi runtime is unavailable, so no session can start.");
  }
  return sessions;
}

/** The validated session surface the IPC layer drives. */
const sessionsIpc: IpcSessionDeps = {
  knownTabIds: () => sessions?.tabs().map((tab) => tab.id) ?? [],
  list: () => sessions?.envelope() ?? { tabs: [], activeTabId: null },
  create: (input: CreateTabInput) => requireSessions().createTab(input),
  close: (tabId: string) => requireSessions().closeTab(tabId),
  activate: (tabId: string) => requireSessions().activateTab(tabId),
  restore: () => requireSessions().restoreTabs(),
  request: (input) => requireSessions().request(input.tabId, input.method, input.params),
};

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
    homeDir: app.getPath("home"),
    logsDir: paths.logs,
    blobCacheDir: paths.blobCache,
    profileDir: paths.profileDir,
    settingsFile: join(paths.profileDir, "settings.json"),
    authFile: join(paths.profileDir, "auth.json"),
    modelsFile: join(paths.profileDir, "models.json"),
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

/** Opens an external terminal rooted at `path`; the process is detached. */
function launchTerminal(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const command =
      process.platform === "win32"
        ? "cmd.exe"
        : process.platform === "darwin"
          ? "open"
          : (process.env.TERMINAL ?? "x-terminal-emulator");
    const args =
      process.platform === "win32"
        ? ["/c", "start", "", "cmd.exe"]
        : process.platform === "darwin"
          ? ["-a", "Terminal", path]
          : [];
    try {
      const child = spawn(command, args, {
        cwd: path,
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      child.on("error", () => resolve(false));
      child.unref();
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}

/** Native folder picker used by “Open project…” (plan step 1). */
async function pickProjectDirectory(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: "Open project folder",
    properties: ["openDirectory", "createDirectory"],
  });
  const first = result.filePaths[0];
  return result.canceled || !first ? null : first;
}

/** The renderer owns the window title; this bounds and applies it. */
function setWindowTitle(title: unknown): boolean {
  const clean = sanitizeTitle(title);
  if (!clean || !mainWindow || mainWindow.isDestroyed()) return false;
  mainWindow.setTitle(clean);
  return true;
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
  // Another instance owns this userData directory (including a developer's dev
  // window or a stale E2E run). Say so instead of vanishing.
  console.error(`[pi-desktop] another instance owns ${paths.userData}; exiting.`);
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    // The application menu is the app's command surface; its items never touch
    // windows directly — they forward a MenuCommand to the renderer.
    await installAppMenu({
      appName: app.getName(),
      isMac: process.platform === "darwin",
      onCommand: (command) => broadcastToWindows(IPC.appMenuCommand, command),
      onOpenExternal: (url) => {
        void openExternal(url);
      },
    });

    registerIpcHandlers({
      appInfo: currentAppInfo,
      openExternal,
      pickDirectory: pickProjectDirectory,
      revealPath: revealPathWithShell,
      setTitle: setWindowTitle,
      prefs: {
        get: async () => (await appState.read()).prefs,
        set: (patch) => appState.updatePrefs(patch),
      },
      sessions: sessionsIpc,
      projects: {
        get: () => projectsService.snapshot(),
        mutate: (input: ProjectMutation) => projectsService.mutate(input),
        create: async (input: CreateProjectInput): Promise<ProjectOpResponse> => {
          const result = await projectOps.createBlank(input);
          if (!result.ok || !result.path)
            return { ...result, ...(await projectsService.snapshot()) };
          // A created project becomes the active one in the same step, so the
          // caller can open a session without a second round trip.
          return {
            ...result,
            ...(await projectsService.mutate({ action: "add", path: result.path })),
          };
        },
        clone: async (input: CloneProjectInput): Promise<ProjectOpResponse> => {
          const result = await projectOps.cloneRepo(input);
          if (!result.ok || !result.path)
            return { ...result, ...(await projectsService.snapshot()) };
          return {
            ...result,
            ...(await projectsService.mutate({ action: "add", path: result.path })),
          };
        },
        action: (input: ProjectActionInput) => projectOps.action(input.path, input.action),
      },
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

    // Restore the tab table without spawning anything, then warm the most
    // recently used tab in the background (plan step 24 pre-warm).
    void sessions?.restoreTabs().then(() => sessions?.prewarmLast());

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    // `dispose` flushes the tab table and stops every host, including control.
    void (sessions ? sessions.dispose() : hosts?.stopAll());
  });
}
