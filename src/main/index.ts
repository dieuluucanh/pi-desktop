import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, clipboard, dialog, nativeImage, shell } from "electron";
import {
  IPC,
  type AppInfo,
  type ProjectOpResponse,
  type SessionDeleteResult,
  type WindowState,
} from "../shared/ipc";
import type { OfficeStopResult } from "../shared/office-bridge";
import type {
  CloneProjectInput,
  CreateProjectInput,
  ProjectActionInput,
  ProjectMutation,
} from "../shared/projects";
import type { CreateTabInput, SessionTabsEnvelope } from "../shared/session-ipc";
import { CONTROL_TAB_ID } from "../shared/session-ipc";
import { APP_COPYRIGHT, APP_NAME, APP_USER_MODEL_ID, resolveBranding } from "./branding";
import { createAppStore } from "./app-store";
import { createNodeFsPort } from "./fs-port";
import { createHostSupervisor } from "./host-supervisor";
import { createQuitTeardown } from "./lifecycle";
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
import { createIntegrationsService } from "./integrations-service";
import {
  createSessionService,
  type SessionEmitChannel,
  type SessionService,
} from "./session-service";
import { createWebTabManager } from "./web-tabs";
import { createElectronWebViewHost } from "./web-view-host";
import { isDeletableSessionPath } from "./session-ops";
import { createOfficeSetupService } from "./office/setup-service";
import { createOfficeDocumentsService } from "./office/documents-service";
import { createDiagnosticsService } from "./diagnostics-service";
import { createElectronUpdatePort } from "./electron-updater";
import { createUpdateService, type UpdateService } from "./updater";
import { initialUpdateState } from "../shared/updates";
import { officeEvidenceLine } from "../shared/office-setup";
import { profileModeFromDocument, type ProfileMode } from "../shared/profile";
import {
  isSafeMode,
  resolveAppPaths,
  resolveAppRoots,
  type AppPaths,
  type AppRoots,
} from "./paths";
import { isOfflineEnv, classifyFailure } from "../shared/diagnostics";
import { createStartupMetrics } from "../shared/performance";
import type { DiagnosticsSaveResult } from "../shared/ipc";
import { resolveAppRuntime, type RuntimeResolution } from "./runtime";
import { rendererWindowOptions, sanitizeExternalUrl } from "./security";

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

/**
 * The startup budget (plan step 24), measured from module load to the window's
 * first paint and the first pre-warmed session. The Diagnostics view shows it;
 * the E2E perf test asserts it.
 */
const startup = createStartupMetrics();

/**
 * Pi's install telemetry (plan step 23). Off until the user opts in on the
 * privacy screen; the supervisor reads this at each spawn and passes
 * `PI_TELEMETRY` accordingly, so an app install never sends a ping by default.
 */
let telemetryEnabled = false;

// Electron's own state directory can be redirected from the environment. The E2E
// harness needs a guaranteed-private userData (a Chromium switch after the app
// path is not reliably honoured), and it doubles as profile isolation later.
const userDataOverride = process.env.PI_DESKTOP_USER_DATA_DIR?.trim();
if (userDataOverride) app.setPath("userData", userDataOverride);

// Windows groups taskbar buttons and attributes toasts by AppUserModelID. Setting
// the packaged app's id in dev too keeps that identity stable across both, and it
// must happen before the first window exists (plan step 28).
if (process.platform === "win32") app.setAppUserModelId(APP_USER_MODEL_ID);

/**
 * The profile choice lives in app state (plan step 26), but hosts are spawned
 * with a profile at module scope, so it is read once before the paths resolve.
 * A missing or malformed store falls back to the shared profile; the app store
 * itself surfaces the malformed-file error later, and never rewrites it.
 */
function bootstrapProfileMode(appStateFile: string): ProfileMode {
  try {
    return profileModeFromDocument(JSON.parse(readFileSync(appStateFile, "utf8")));
  } catch {
    return "shared";
  }
}

const userDataDir = app.getPath("userData");
const paths: AppPaths = resolveAppPaths({
  userDataDir,
  env: process.env,
  profileMode: bootstrapProfileMode(join(userDataDir, "app-state.json")),
});

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

/** Where the brand icons are (plan step 28): `resources/branding` or `assets/`. */
const branding = resolveBranding({
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

/**
 * Update checking (plan step 26). Created in `whenReady` because resolving the
 * `electron-updater` port is async; null until then, and in a build with no feed.
 */
let updateService: UpdateService | null = null;
let updateCheckTimer: ReturnType<typeof setTimeout> | null = null;

/** The remembered project list (plan step 10): `app-state.json` is its only writer. */
const projectsService = createProjectsService({ store: appState });

/** The app's integration record (plan step 19): consented installs, setup timestamps. */
const integrationsService = createIntegrationsService({ store: appState });

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
      backupDir: join(paths.userData, "backups"),
      profileDir: paths.profileDir,
      ...(runtime.npmCliPath ? { npmCliPath: runtime.npmCliPath } : {}),
      // Safe mode (plan step 22): every host loads no third-party resources and
      // refuses package mutations.
      safeMode,
      // Install telemetry (plan step 23): off unless the user opted in.
      telemetryEnabled: () => telemetryEnabled,
    })
  : null;

/**
 * The isolated web tabs (plan step 21): one `WebContentsView` per `web` tab,
 * reconciled from the tab table. Created before the session service because that
 * service's tab push is what drives the reconciliation.
 */
const webTabs = createWebTabManager({
  createView: createElectronWebViewHost({ window: () => mainWindow }),
  emitState: (state) => broadcastToWindows(IPC.webState, state),
  emitNavigationRequest: (request) => broadcastToWindows(IPC.webNavigationRequest, request),
});

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
      emit: (channel, payload) => {
        broadcastToWindows(SESSION_CHANNELS[channel], payload);
        // The tab table is the web-tab service's reconciliation input: a web tab
        // opened, closed, reordered or restored is reflected in one place.
        if (channel === "tabs") webTabs.sync(payload as SessionTabsEnvelope);
      },
    })
  : null;

/** The folder a new web tab reports (the active session's, else the home folder). */
function webTabCwd(explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  const active = sessions?.activeTabId();
  const tab = active ? sessions?.tabs().find((entry) => entry.id === active) : undefined;
  return tab && tab.cwd.length > 0 ? tab.cwd : app.getPath("home");
}

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
  closeOthers: (tabId: string) => requireSessions().closeOthers(tabId),
  reorder: (tabId: string, toIndex: number) => requireSessions().reorderTab(tabId, toIndex),
  promoteOfficeHost: (tabId: string) => requireSessions().promoteToOfficeHost(tabId),
  activate: (tabId: string) => requireSessions().activateTab(tabId),
  restore: () => requireSessions().restoreTabs(),
  restart: (tabId: string) => requireSessions().restartTab(tabId),
  request: (input) => requireSessions().request(input.tabId, input.method, input.params),
  deleteSession: deleteSessionFile,
};

/**
 * Deletes a session to the OS trash (plan step 11). The control host resolves
 * the path against Pi's own session index; main then trashes it with a second,
 * path-containment check in between, so only a real session file inside the
 * shared profile can ever reach `shell.trashItem`.
 */
async function deleteSessionFile(sessionFile: string): Promise<SessionDeleteResult> {
  if (!sessions) {
    return {
      ok: false,
      error: "The bundled Pi runtime is unavailable, so sessions cannot be listed.",
    };
  }
  if (!isDeletableSessionPath(sessionFile, paths.profileDir)) {
    return { ok: false, error: "That path is not a session file in the Pi profile." };
  }
  try {
    const resolved = (await sessions.request(CONTROL_TAB_ID, "session.delete", {
      sessionFile,
    })) as { path?: unknown } | undefined;
    const path = typeof resolved?.path === "string" ? resolved.path : sessionFile;
    if (!isDeletableSessionPath(path, paths.profileDir)) {
      return { ok: false, error: "The host resolved a path outside the Pi profile." };
    }
    await shell.trashItem(path);
    return { ok: true, path };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Only these schemes may be handed to the operating system (plan step 22/23). */
export async function openExternal(rawUrl: unknown): Promise<boolean> {
  const url = sanitizeExternalUrl(rawUrl);
  if (url === null) return false;
  await shell.openExternal(url);
  return true;
}

function currentAppInfo(): AppInfo {
  return {
    name: APP_NAME,
    version: app.getVersion(),
    electron: process.versions.electron ?? "unknown",
    chrome: process.versions.chrome ?? "unknown",
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    isDev,
    safeMode,
    piOffline: isOfflineEnv(process.env.PI_OFFLINE),
    userDataDir: paths.userData,
    homeDir: app.getPath("home"),
    logsDir: paths.logs,
    blobCacheDir: paths.blobCache,
    profileDir: paths.profileDir,
    profileMode: paths.profileMode,
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
  // The window's security posture is declared once in `./security.ts`; the test
  // in `tests/main/security.test.ts` reads those options, so this call site
  // cannot quietly drop `sandbox` or add `nodeIntegration`.
  //
  // macOS ignores a window icon (the bundle's `.icns` owns the Dock), so the path
  // is only supplied elsewhere — one less file read on a platform that would
  // discard it (plan step 28).
  const window = new BrowserWindow(
    rendererWindowOptions(
      join(currentDir, "../preload/index.cjs"),
      process.platform === "darwin" ? undefined : { icon: branding.ico },
    ),
  );

  window.once("ready-to-show", () => {
    startup.markWindowInteractive();
    window.show();
  });

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

/** The last evidence line written to the log, so a poll loop does not spam it. */
let lastOfficeEvidence: string | null = null;

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
    // Defence in depth: every other `openExternal` path runs the protocol
    // allowlist, and the Office wizard's URLs are hardcoded today (plan step 27).
    const safe = sanitizeExternalUrl(url);
    if (safe) await shell.openExternal(safe);
  },
  appInfo: {
    name: APP_NAME,
    version: app.getVersion(),
    electron: process.versions.electron ?? null,
    node: process.versions.node,
    chrome: process.versions.chrome ?? null,
    platform: process.platform,
    arch: process.arch,
    osRelease: process.getSystemVersion?.() ?? null,
  },
  onView: (view) => {
    broadcastToWindows(IPC.officeState, view);
    // Keep the evidence trail in the main-process log too (plan step 19): a
    // support log should show what the Integrations card showed. Only on change,
    // so the wizard's poll loop cannot spam it.
    const evidence = officeEvidenceLine(view);
    if (evidence !== lastOfficeEvidence) {
      lastOfficeEvidence = evidence;
      console.log(`[pi-desktop] office: ${evidence}`);
    }
  },
});

/**
 * The live Office pane registry (plan step 20). It polls the bridge's `/health`
 * continuously — the Documents panel, `#` mentions and the office tool cards
 * need it even when the setup wizard is closed.
 */
const officeDocuments = createOfficeDocumentsService({
  onView: (view) => broadcastToWindows(IPC.officeDocumentsState, view),
});

/**
 * The app-wide diagnostics service (plan step 22). It reads what already exists —
 * hosts and their logs, incidents, extension errors, the Office probe — and
 * renders the redacted support bundle. `save` lives here because it is the one
 * step that needs Electron's dialog.
 */
const diagnostics = createDiagnosticsService({
  appInfo: currentAppInfo,
  sessions: sessions
    ? {
        hosts: () => sessions.diagnosticsHosts(),
        incidents: () => sessions.incidents(),
        extensionErrors: () => sessions.extensionErrors(),
        capacity: () => sessions.capacity(),
      }
    : null,
  office: () => {
    const view = officeDocuments.get();
    return {
      available: view.available,
      status: view.status,
      port: view.port,
      protocolVersion: view.protocolVersion,
      panes: view.panes.length,
      ...(view.error ? { error: view.error } : {}),
    };
  },
  officeBundle: async () => officeSetup.diagnostics(),
  startup: () => startup.report(),
  env: process.env,
});

/** Asks where to save, then writes the already-redacted bundle. */
async function saveDiagnosticsBundle(): Promise<DiagnosticsSaveResult> {
  const bundle = await diagnostics.exportBundle();
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: "Save diagnostics bundle",
    defaultPath: `pi-desktop-diagnostics-${new Date(bundle.generatedAt).toISOString().slice(0, 10)}.txt`,
    filters: [{ name: "Text", extensions: ["txt"] }],
  });
  if (canceled || !filePath) return { ok: false };
  try {
    await writeFile(filePath, bundle.text, "utf8");
    return { ok: true, path: filePath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Process-level failures are captured before anything else can go wrong, so a
// rejection during startup still shows up in Diagnostics (plan step 22).
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const detail = reason instanceof Error ? reason.stack : undefined;
  const kind = classifyFailure(message);
  diagnostics.recordMain(kind === "unknown" ? "unhandled_rejection" : kind, message, detail);
});
process.on("uncaughtException", (error) => {
  diagnostics.recordMain("uncaught_exception", error.message, error.stack);
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
    startup.markAppReady();
    // Load the persisted preferences once before any host can spawn, so the
    // telemetry flag is correct for the first session (plan step 23).
    telemetryEnabled = (await appState.read()).prefs.telemetryEnabled;

    // Updates (plan step 26): only an installed build has a feed, and only the
    // Electron adapter can answer whether `electron-updater` loaded at all.
    const updateSupported = app.isPackaged;
    const updatePort = updateSupported ? await createElectronUpdatePort() : null;
    updateService = createUpdateService({
      port: updatePort,
      supported: updateSupported && updatePort !== null,
      onChange: (state) => broadcastToWindows(IPC.updatesState, state),
    });

    // Brand identity (plan step 28). On macOS the Dock icon comes from the
    // bundle's `.icns` once packaged, but a dev run has no bundle to read it
    // from, so it is set from the same PNG every time. `applicationIcon` is a
    // linux/win32-only option — macOS takes the about-panel icon from the bundle
    // — and the 512px source is the largest available (Windows would prefer 48,
    // which the set does not carry; the shell scales).
    if (process.platform === "darwin" && app.dock) {
      const dockIcon = nativeImage.createFromPath(branding.png512);
      if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
    }
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: app.getVersion(),
      copyright: APP_COPYRIGHT,
      ...(process.platform === "darwin" ? {} : { applicationIcon: branding.png512 }),
    });

    // The application menu is the app's command surface; its items never touch
    // windows directly — they forward a MenuCommand to the renderer.
    await installAppMenu({
      appName: APP_NAME,
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
      relaunch: () => {
        // A profile-mode change is applied at the next launch, so the wizard can
        // offer a real restart. `quit` (not `exit`) runs `before-quit`, which
        // flushes the tab table and stops every host.
        app.relaunch();
        app.quit();
        return true;
      },
      prefs: {
        get: async () => (await appState.read()).prefs,
        set: async (patch) => {
          const prefs = await appState.updatePrefs(patch);
          // A telemetry change applies to hosts spawned from now on; a running
          // session keeps its environment until it restarts.
          telemetryEnabled = prefs.telemetryEnabled;
          return prefs;
        },
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
      integrations: {
        get: () => integrationsService.get(),
        recordOffice: (patch: unknown) => integrationsService.recordOffice(patch),
      },
      // The Office session owns the bridge and the app owns the session, so Stop
      // aborts that session's run — which ends a pane's answer for every bridge
      // version (protocol v3 additionally lets a pane stop its own run).
      officeRun: {
        stop: async (): Promise<OfficeStopResult> => {
          const officeTab = sessions
            ?.envelope()
            .tabs.find((tab) => tab.kind === "office" && tab.status !== "stopped");
          const host = officeTab ? hosts?.get(officeTab.id) : undefined;
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
      diagnostics: {
        get: () => diagnostics.snapshot(),
        export: () => diagnostics.exportBundle(),
        save: () => saveDiagnosticsBundle(),
        record: (value: unknown) => diagnostics.recordReported(value),
      },
      updates: {
        get: () => updateService?.state() ?? initialUpdateState(false),
        check: async () => (updateService ? updateService.check() : initialUpdateState(false)),
        download: async () =>
          updateService ? updateService.download() : initialUpdateState(false),
        install: () => updateService?.install() ?? false,
      },
      officeDocuments: {
        get: () => officeDocuments.get(),
        refresh: () => officeDocuments.refresh(),
      },
      web: {
        open: async (input) => {
          // Opening the same page twice reuses the tab: a repeated notification
          // (or a double "chat about this") must not spawn a second review view.
          const existing = sessions
            ?.tabs()
            .find((tab) => tab.kind === "web" && tab.url === input.url);
          if (existing) return requireSessions().activateTab(existing.id);
          return requireSessions().createTab({
            kind: "web",
            cwd: webTabCwd(input.cwd),
            url: input.url,
            ...(input.sessionTabId ? { sessionTabId: input.sessionTabId } : {}),
          });
        },
        setBounds: (tabId, bounds) => {
          webTabs.setBounds(tabId, bounds);
          return true;
        },
        command: (tabId, command) => {
          webTabs.command(tabId, command);
          return true;
        },
        decideNavigation: async (decision) => {
          if (decision.action === "current-tab") {
            return webTabs.navigate(decision.tabId, decision.url);
          }
          if (decision.action === "new-tab") {
            const existing = sessions
              ?.tabs()
              .find((tab) => tab.kind === "web" && tab.url === decision.url);
            if (existing) {
              await requireSessions().activateTab(existing.id);
              return true;
            }
            await requireSessions().createTab({
              kind: "web",
              cwd: webTabCwd(),
              url: decision.url,
              ...(decision.sessionTabId ? { sessionTabId: decision.sessionTabId } : {}),
            });
            return true;
          }
          if (decision.action === "external") return openExternal(decision.url);
          return true;
        },
      },
    });
    mainWindow = createWindow();
    // Check once, unobtrusively, in the background (plan step 26). A user can
    // always ask from Help → Check for Updates; this is the "there is a newer
    // build" path. Offline starts are skipped, and the timer is cleared on quit.
    if (updateService && !isOfflineEnv(process.env.PI_OFFLINE)) {
      updateCheckTimer = setTimeout(() => void updateService?.check(), 10_000);
    }
    // The registry poll is cheap (one loopback GET) and the panel must reflect a
    // bridge that a terminal Pi session owns, so it runs whenever the app does.
    // Safe mode starts with zero third-party code, so the poll stays off there.
    if (!safeMode) officeDocuments.start();

    // Restore the tab table without spawning anything, then warm the most
    // recently used tab in the background (plan step 24 pre-warm). Safe mode
    // starts lazily: no session host runs until the user opens a tab.
    void sessions?.restoreTabs().then(async () => {
      if (safeMode) return undefined;
      // Pre-warm the most recently used tab and record how long a warm session
      // takes to be ready (plan step 24). Only a session that actually became
      // ready is recorded, so an empty install keeps the mark honest.
      const warmed = await sessions?.prewarmLast();
      if (warmed) startup.markSessionReady(undefined, true);
      return undefined;
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  // `before-quit` is synchronous, so the async teardown (flush the tab table,
  // stop every host including control) must defer the quit and quit again when
  // it finishes; discarding the promise let the process exit mid-teardown and
  // risked losing the tab table (plan step 27). `lifecycle.ts` owns the
  // ordering so it is unit tested.
  const quitTeardown = createQuitTeardown({
    dispose: async () => {
      if (updateCheckTimer) clearTimeout(updateCheckTimer);
      updateService?.dispose();
      officeDocuments.dispose();
      webTabs.dispose();
      await (sessions ? sessions.dispose() : hosts?.stopAll());
    },
    quit: () => app.quit(),
    onError: (error) => {
      console.error("quit teardown failed", error);
    },
  });
  app.on("before-quit", (event) => quitTeardown.handleBeforeQuit(event));
}
