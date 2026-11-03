import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeImage,
  powerMonitor,
  shell,
} from "electron";
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
import type {
  CreateTabInput,
  RetargetEditorTabsInput,
  SessionTabsEnvelope,
  TabKind,
} from "../shared/session-ipc";
import { CONTROL_TAB_ID } from "../shared/session-ipc";
import { HOST_METHODS } from "../shared/host-protocol";
import { menuAcceleratorsFor, resolveDesktopKeymap } from "../shared/desktop-keymap";
import { DEFAULT_ZOOM, clampZoomFactor } from "../shared/zoom";
import { APP_COPYRIGHT, APP_NAME, APP_USER_MODEL_ID, resolveBranding } from "./branding";
import { createAppStore } from "./app-store";
import { createNodeFsPort } from "./fs-port";
import { createHostBuildId } from "./host-build";
import { createHostSupervisor } from "./host-supervisor";
import { keepHostAlive } from "./host-policy";
import { createQuitTeardown } from "./lifecycle";
import {
  broadcastToWindows,
  registerIpcHandlers,
  revealPathWithShell,
  sanitizeTitle,
  type IpcSessionDeps,
} from "./ipc";
import { installAppMenu } from "./menu";
import { contextMenuTemplate } from "./context-menu";
import { createCommandRunner } from "./office/exec";
import { buildBugReport, messagesFromJsonl, shareSession, summarizeForBugReport } from "./share";
import { openInExternalEditor } from "./editor";
import { createProjectOps } from "./project-ops";
import { createProjectsService } from "./projects-service";
import { createProjectSettingsService } from "./project-settings-service";
import { createTrustFile } from "./trust-file";
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
import { bridgeConfiguredInSettings } from "./office/bridge-install";
import { createOfficeDocumentsService } from "./office/documents-service";
import { createOfficeBridgeControl } from "./office/bridge-control";
import { createKillProcess, releasePort } from "./office/port-owner";
import { checkBridgeHealth, createDefaultVerifyDeps } from "./office/verify";
import { createGitPushService } from "./git-service";
import { createCheckpointService } from "./checkpoint-service";
import { createWorkspaceService } from "./workspace-service";
import { createNodeWorkspaceIo } from "./workspace-io";
import { formatWorkspaceText, runFormatterCommand } from "./editor-format";
import { createCheckpointStore } from "../checkpoints/store";
import {
  createNodeCheckpointConfigFs,
  createNodeCheckpointFs,
  createNodeFingerprint,
} from "../checkpoints/fs";
import { projectConfigFromPrefs, readConfig } from "../checkpoints/config";
import { DEFAULT_CHECKPOINT_CONFIG, checkpointsRoot } from "../shared/checkpoints";
import { createNodeGitRunner } from "../git/runner";
import { createGitService } from "../git/service";
import { requireProjectPath } from "../shared/git";
import { createDiagnosticsService } from "./diagnostics-service";
import { createElectronUpdatePort } from "./electron-updater";
import { createUpdateService, type UpdateService } from "./updater";
import { readBuildInfo } from "./build-info";
import {
  autoCheckAllowed,
  initialUpdateState,
  PI_DESKTOP_RELEASES_URL,
  resolveUpdateSupport,
} from "../shared/updates";
import { officeEvidenceLine, type OfficeBridgeEnsureResult } from "../shared/office-setup";
import { PI_OFFICE_BRIDGE } from "../shared/office";
import { officeBridgeOwnerTab } from "../shared/office-documents";
import { profileModeFromDocument, type ProfileMode } from "../shared/profile";
import {
  isSafeMode,
  resolveAppPaths,
  resolveAppRoots,
  type AppPaths,
  type AppRoots,
} from "./paths";
import { isOfflineEnv, classifyFailure, type DiagnosticsGitInfo } from "../shared/diagnostics";
import type { CheckpointState } from "../shared/checkpoints";
import type { GitSnapshot } from "../shared/git";
import {
  IDLE_HOST_TIMEOUT_MS,
  MAX_HOSTS_HARD_CEILING,
  liveHostBudget,
  createStartupMetrics,
} from "../shared/performance";
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

/**
 * Provenance written by electron-builder's `afterPack` hook. A locally
 * packaged build is still a valid app, but it is not on the update feed: the
 * capability decisions later in this file use `channel` to keep it quiet.
 */
const buildInfo = readBuildInfo({
  isPackaged: app.isPackaged,
  resourcesDir: roots.resourcesDir,
  readTextFile: (file) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  },
});

const runtime: RuntimeResolution = resolveAppRuntime({
  isPackaged: app.isPackaged,
  resourcesPath: roots.resourcesDir,
  appRoot: roots.appRoot,
});

/**
 * Content fingerprint of the host bundle on disk (2026-10-24 stale-host plan).
 * The supervisor stamps each spawn with it and the session service compares it
 * with the running host before trusting completion requests. One provider is
 * shared by both so the comparison is meaningful.
 */
const hostBuildId = createHostBuildId(runtime.piHostPath);

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

/** The per-project settings toggle: snapshots/empties `.pi/settings.json`. */
const projectTrustFile = createTrustFile({
  fs: createNodeFsPort(),
  agentDir: paths.profileDir,
});
const projectSettingsService = createProjectSettingsService({
  fs: createNodeFsPort(),
  store: appState,
  isProjectTrusted: (projectPath) => projectTrustFile.isProjectTrusted(projectPath),
});

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
/**
 * The live bridge owner, read by the supervisor's idle check. The supervisor is
 * constructed before the documents poller, so the lookup is a mutable holder
 * filled in immediately after the poller exists.
 */
const bridgeOwnerSessionId: { current: () => string | null } = {
  current: () => null,
};

/**
 * The active tab, read by the supervisor's idle check. A mutable holder avoids a
 * forward reference to the session service (created just below) and is updated
 * on every tab push.
 */
const activeSessionId: { current: string | null } = { current: null };

/**
 * The soft live-host target for this machine. Total memory is stable for the
 * app's lifetime; the control host is included in the count, and the value is
 * never a hard session limit (see `liveHostBudget`).
 */
const liveHostTarget = liveHostBudget(totalmem());

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
      // The running host reports this id in `host.hello`; a later rebuild makes
      // it differ from the file on disk (2026-10-24 stale-host plan).
      hostBuildId,
      // The soft target parks idle sessions before spawning; the hard ceiling is
      // only a protocol/port sanity guard, never a session limit.
      maxHosts: MAX_HOSTS_HARD_CEILING,
      // Sleep a session after 15 minutes without real traffic. The active tab,
      // the control host, an Office host and the bridge owner are protected.
      idleTimeoutMs: IDLE_HOST_TIMEOUT_MS,
      isPinned: (sessionId) =>
        keepHostAlive(sessionId, {
          activeSessionId: activeSessionId.current,
          bridgeOwnerSessionId: bridgeOwnerSessionId.current(),
        }),
    })
  : null;

/**
 * Frees the Office bridge port before a promoted session binds it
 * (2026-10-30 project-scoped rail plan).
 *
 * Stopping our own host is not enough: an earlier app run, terminal Pi, or an
 * unrelated program can still hold 38617, and the bridge extension would then
 * report `EADDRINUSE` instead of listening. This terminates the holder — never
 * this app's own processes — and verifies the port answers nothing afterwards.
 */
const releaseOfficePort = async (input: {
  port: number;
  ownPids: readonly number[];
}): Promise<{ ok: boolean; detail?: string }> => {
  const runner = createCommandRunner();
  return releasePort(
    { port: input.port, ownPids: input.ownPids, force: true },
    {
      runner,
      kill: createKillProcess(runner),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      probe: async (port) =>
        checkBridgeHealth(createDefaultVerifyDeps(), { port, timeoutMs: 1_500 }),
    },
  );
};

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
      // Compare the running host's build id with the bundle on disk; an idle,
      // stale host is recycled before the next request (2026-10-24 plan).
      hostBuildId,
      // Promotion must really take port 38617, and must never kill a process this
      // app owns: the supervisor stops its own hosts and waits for their exit.
      releaseOfficePort,
      ownPids: () => [
        process.pid,
        ...(hosts?.list() ?? [])
          .map((host) => host.info()?.pids.pid)
          .filter((pid): pid is number => typeof pid === "number"),
      ],
      officeBridgePort: PI_OFFICE_BRIDGE.defaultPort,
      maxLiveHosts: liveHostTarget,
      emit: (channel, payload) => {
        broadcastToWindows(SESSION_CHANNELS[channel], payload);
        if (channel === "tabs") {
          const envelope = payload as SessionTabsEnvelope;
          activeSessionId.current = envelope.activeTabId;
          // The tab table is the web-tab service's reconciliation input: a web
          // tab opened, closed, reordered or restored is reflected in one place.
          webTabs.sync(envelope);
        }
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
  closeAll: (kind: TabKind) => requireSessions().closeAll(kind),
  closeOthers: (tabId: string) => requireSessions().closeOthers(tabId),
  closeProject: (cwd: string) => requireSessions().closeForProject(cwd),
  setPinned: (tabId: string, pinned: boolean) => requireSessions().setPinned(tabId, pinned),
  retargetEditorTabs: (input: RetargetEditorTabsInput) =>
    requireSessions().retargetEditorTabs(input),
  reorder: (tabId: string, toIndex: number) => requireSessions().reorderTab(tabId, toIndex),
  promoteOfficeHost: async (tabId: string) => {
    const envelope = await requireSessions().promoteToOfficeHost(tabId);
    // The promoted host re-binds the bridge asynchronously; probe now so the
    // Documents panel stops saying "waiting" as soon as the port answers.
    void officeDocuments.refresh();
    return envelope;
  },
  activate: (tabId: string) => requireSessions().activateTab(tabId),
  deactivate: () => requireSessions().deactivate(),
  reconcile: () => requireSessions().reconcile(),
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
    buildChannel: buildInfo.channel,
    buildVersion: buildInfo.version,
    buildCommit: buildInfo.commit,
    builtAt: buildInfo.builtAt,
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
    // A copy of the allowlist this main process was built with. A hot-reloaded
    // renderer uses it to detect a main process that predates a new method.
    hostMethods: [...HOST_METHODS],
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

/**
 * The session-JSONL picker (`/import`, plan step 14). Mirrors the folder picker:
 * the renderer supplies only a label and an extension list, never a path.
 */
async function pickSessionFile(options?: {
  title?: string;
  extensions?: string[];
}): Promise<string | null> {
  const extensions = (
    options?.extensions && options.extensions.length > 0 ? options.extensions : ["jsonl"]
  ).map((extension) => extension.replace(/^\./, ""));
  const result = await dialog.showOpenDialog({
    title: options?.title ?? "Import a session",
    properties: ["openFile"],
    filters: [{ name: "Pi session", extensions }],
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

/** The renderer owns the zoom preference; main applies it to every window. */
let windowZoomFactor: number = DEFAULT_ZOOM;

function applyZoom(factor: unknown): void {
  windowZoomFactor = clampZoomFactor(factor);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.setZoomFactor(windowZoomFactor);
  }
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

  // Chromium keeps a per-origin zoom map; without re-applying the stored factor
  // on load a previous session's zoom could win (2026-10-30 zoom plan).
  window.webContents.on("did-finish-load", () => {
    if (!window.isDestroyed()) window.webContents.setZoomFactor(windowZoomFactor);
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

  // Electron has no default context menu. The template is pure and tested; this
  // call site only supplies the window's editing commands (2026-10-30 copy plan).
  window.webContents.on("context-menu", (_event, params) => {
    const contents = window.webContents;
    const withContents = (action: () => void): void => {
      if (!window.isDestroyed() && !contents.isDestroyed()) action();
    };
    const template = contextMenuTemplate(
      {
        selectionText: params.selectionText,
        isEditable: params.isEditable,
        canUndo: params.editFlags.canUndo,
        canRedo: params.editFlags.canRedo,
        canCut: params.editFlags.canCut,
        canCopy: params.editFlags.canCopy,
        canPaste: params.editFlags.canPaste,
        canSelectAll: params.editFlags.canSelectAll,
      },
      {
        undo: () => withContents(() => contents.undo()),
        redo: () => withContents(() => contents.redo()),
        cut: () => withContents(() => contents.cut()),
        copy: () => withContents(() => contents.copy()),
        paste: () => withContents(() => contents.paste()),
        selectAll: () => withContents(() => contents.selectAll()),
      },
    );
    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window });
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
/**
 * The stable "the bridge package is configured" fact behind the Documents menu
 * (2026-10-30 rail-headers plan).
 *
 * It is deliberately separate from the live `/health` probe: one failed probe
 * while a promoted host re-binds port 38617 must not remove the menu from the
 * rail. Read once at startup and again whenever the setup wizard reports a
 * bridge install.
 */
let bridgeConfigured = false;
/** The wizard's last bridge-step status, so one install is handled once. */
let lastBridgeStatus: string | null = null;

const officeSetup = createOfficeSetupService({
  agentDir: paths.profileDir,
  cwd: app.getPath("home"),
  manifestPath: roots.manifestPath,
  nodePath: runtime.nodePath,
  npmCliPath: runtime.npmCliPath,
  dryRun: process.env.PI_DESKTOP_OFFICE_DRY_RUN === "1",
  backupDir: join(paths.userData, "backups"),
  // The wizard is explicit: setup asks a Pi session to connect before it opens
  // Office. The implementation is declared below (after the control service)
  // and only runs when the user starts the wizard.
  ensureBridge: ensureOfficeBridge,
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
    // A wizard that just installed (or updated) the bridge changes the stable
    // fact the Documents menu is built from, so pick it up without a restart.
    const bridgeStatus = view.bridge?.status ?? null;
    if (bridgeStatus !== lastBridgeStatus) {
      lastBridgeStatus = bridgeStatus;
      if (bridgeStatus !== null && bridgeStatus !== "failed") {
        bridgeConfigured = true;
        void officeDocuments.refresh();
      }
    }
  },
});

/**
 * The live Office pane registry (plan step 20). It polls the bridge's `/health`
 * continuously — the Documents panel, `#` mentions and the office tool cards
 * need it even when the setup wizard is closed.
 */
const officeDocuments = createOfficeDocumentsService({
  // The menu's presence comes from this stable fact, not from one probe
  // (2026-10-30 rail-headers plan).
  configured: () => bridgeConfigured,
  onView: (view) => broadcastToWindows(IPC.officeDocumentsState, view),
});

bridgeOwnerSessionId.current = () => officeDocuments.get().owner?.sessionId ?? null;

/**
 * The on-demand bridge actions. Main owns the sequence (close the old owner,
 * free a foreign port, connect the target) so the renderer never races two
 * commands or kills a process itself.
 */
/**
 * The wizard's bridge step. Prefer the live owner, then an existing office tab,
 * then any non-web session; create one only when the app has none. Never takes
 * over a foreign port silently — the wizard reports the conflict instead.
 */
async function ensureOfficeBridge(): Promise<OfficeBridgeEnsureResult> {
  if (!sessions) {
    return { ok: false, error: "The Pi runtime is unavailable, so no bridge can start." };
  }
  const tabs = sessions.tabs();
  const target =
    officeBridgeOwnerTab(officeDocuments.get(), tabs) ??
    tabs.find((tab) => tab.kind === "office" && tab.status !== "stopped") ??
    tabs.find((tab) => tab.kind !== "web") ??
    null;

  let tabId = target?.id ?? null;
  if (tabId === null) {
    try {
      await sessions.createTab({ cwd: app.getPath("home"), kind: "office" });
      tabId = sessions.activeTabId();
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (tabId === null) {
    return { ok: false, error: "Could not open a Pi session for the Office bridge." };
  }

  const result = await officeControl.connect(tabId, { takeover: false });
  if (result.ok) {
    return { ok: true, error: null, detail: `tab ${tabId}` };
  }
  return {
    ok: false,
    error: result.message ?? `Bridge connect failed (${result.reason}).`,
    detail: result.reason,
  };
}

const officeControl = createOfficeBridgeControl({
  tabs: () => sessions?.tabs() ?? [],
  probe: () => officeDocuments.refresh(),
  request: (tabId, method, params) => {
    if (!sessions) {
      return Promise.reject(new Error("The Pi runtime is unavailable, so no bridge can start."));
    }
    return sessions.request(tabId, method, params);
  },
  releasePort: releaseOfficePort,
  ownPids: () => [
    process.pid,
    ...(hosts?.list() ?? [])
      .map((host) => host.info()?.pids.pid)
      .filter((pid): pid is number => typeof pid === "number"),
  ],
});

/**
 * Re-reads the bridge-package fact from the user-scope Pi settings file and asks
 * the registry for one immediate probe, so the renderer sees the new value
 * without waiting out the 5 s poll.
 *
 * A malformed settings file is surfaced, never repaired (AGENTS rule 5). The rail
 * then falls back to the live probe and the office-tab rule, which is a missing
 * menu at worst — never a crash or a rewritten file.
 */
async function refreshBridgeConfigured(): Promise<void> {
  try {
    bridgeConfigured = await bridgeConfiguredInSettings(
      createNodeFsPort(),
      join(paths.profileDir, "settings.json"),
    );
  } catch (error) {
    console.warn(
      `[pi-desktop] could not read the bridge package setting: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    bridgeConfigured = false;
  }
  void officeDocuments.refresh();
}

/**
 * Folder checkpoints (git-checkpoint plan step 20).
 *
 * Declared before the git engine so its `preOpSnapshot` port can be wired at
 * construction: a discard or a branch switch snapshots the folder *first*, and a
 * snapshot that cannot be taken aborts the action instead of being skipped (D11).
 *
 * The store is the shadow-repo engine; this service decides *when* to snapshot.
 * Every platform-shaped fact is a port right here, which is what keeps
 * `checkpoint-service.ts` in `CORE_FILES`:
 *
 *  - `attachedPanes` is the live Office registry — the idle scan only runs while
 *    a document is open, because a tool hook cannot see Word save a file (D15).
 *  - `tabs` is the session table, so the scan never snapshots a folder while the
 *    agent is mid-edit.
 *  - `trash` is `shell.trashItem`, so a `removeAdded` restore stays recoverable.
 */
/**
 * What the rail last saw, for Diagnostics (git-checkpoint plan step 28).
 *
 * Bounded: the map holds the same handful of folders `MAX_GIT_SNAPSHOTS` bounds in
 * the renderer, and a stale entry is overwritten rather than accumulated.
 */
const lastGitSnapshots = new Map<string, GitSnapshot>();
let lastCheckpointState: CheckpointState | null = null;
let gitVersion: string | null = null;
const checkpointRootDir = checkpointsRoot(paths.profileDir);

const checkpointFs = createNodeCheckpointFs();
const checkpointStore = createCheckpointStore({
  runner: createNodeGitRunner(),
  fs: checkpointFs,
  profileDir: paths.profileDir,
  trash: {
    trash: async (target) => {
      try {
        await shell.trashItem(target);
        return true;
      } catch {
        return false;
      }
    },
  },
});

/**
 * Projects the checkpoint preferences to `<profile>/checkpoints/config.json`
 * (D19: **one writer**). Prefs stay the app-owned source; the host-side
 * extension can only read this file, so nothing else may write it.
 */
async function projectCheckpointConfig(prefsValue: unknown): Promise<void> {
  try {
    await projectConfigFromPrefs(
      {
        fs: createNodeCheckpointConfigFs(),
        profileDir: paths.profileDir,
        token: () => String(process.pid),
      },
      prefsValue,
    );
  } catch (error) {
    // A projection failure must not fail the prefs write the user asked for; it
    // is logged (and visible in Diagnostics) and retried on the next change.
    console.warn(
      `[pi-desktop] checkpoint config projection failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

const checkpointService = createCheckpointService({
  store: checkpointStore,
  // The projected file is the one source of truth (D19), so a Settings change
  // applies to the next capture without restarting main.
  config: async () => {
    try {
      return (await readConfig({ fs: checkpointFs, profileDir: paths.profileDir })).config;
    } catch {
      // A malformed file is reported and kept (step 19); the rail falls back to
      // the defaults for this read rather than refusing to open at all.
      return DEFAULT_CHECKPOINT_CONFIG;
    }
  },
  attachedPanes: () => officeDocuments.get().panes,
  tabs: () => sessions?.tabs() ?? [],
  // The folder the bridge's owning session works in. The live owner is
  // `/health.owner.sessionId`; the legacy office-tab fallback lives in the
  // shared projection, so the renderer and main cannot disagree.
  officeHostProjectPath: () => {
    const tab = officeBridgeOwnerTab(officeDocuments.get(), sessions?.tabs() ?? []);
    return tab?.cwd ?? null;
  },
  runSnapshots: () => !safeMode,
  onChange: (state) => {
    lastCheckpointState = state;
    broadcastToWindows(IPC.checkpointsPushed, state);
  },
  safeMode: () => safeMode,
  fingerprint: createNodeFingerprint({ exclude: DEFAULT_CHECKPOINT_CONFIG.exclude }),
});

/**
 * Source control (git-checkpoint plan step 8).
 *
 * `gitEngine` answers git's questions; `gitPush` decides when to ask and pushes
 * a changed snapshot to the rail. The two ports that need the OS live here, in
 * main, because the engine itself must stay Electron- and fs-free:
 * `shell.trashItem` makes an untracked discard recoverable, and a plain `stat`
 * is the folder probe the availability reasons need.
 */
const gitEngine = createGitService({
  runner: createNodeGitRunner(),
  pathKind: async (target) => {
    try {
      const info = await stat(target);
      if (info.isDirectory()) return "directory";
      if (info.isFile()) return "file";
      return null;
    } catch {
      return null;
    }
  },
  trash: {
    trash: async (target) => {
      try {
        // The OS trash, never a bare delete: a discard must stay recoverable.
        await shell.trashItem(target);
        return true;
      } catch {
        return false;
      }
    },
  },
  // D11: a destructive action snapshots first. A throw aborts the action — a
  // safety snapshot that cannot be taken must not be silently skipped.
  preOpSnapshot: (projectPath, note) => checkpointService.snapshotBefore(projectPath, note),
});

const gitPush = createGitPushService({
  git: gitEngine,
  // One emission point for both consumers: the renderer's rail and the
  // Diagnostics registry (step 28), so the bundle reports what the rail saw.
  emit: (snapshot) => {
    lastGitSnapshots.set(snapshot.projectPath, snapshot);
    broadcastToWindows(IPC.gitPushed, snapshot);
  },
  isFocused: () => mainWindow?.isFocused() ?? true,
});

/**
 * The workspace file service behind the explorer and editor (2026-11-01
 * plan). The IO adapter is the only Node/fs contact; the shell reveal is an
 * injected port so the service stays Electron-free and unit-testable.
 */
const workspaceService = createWorkspaceService({
  io: createNodeWorkspaceIo({
    trash: async (target) => {
      await shell.trashItem(target);
    },
  }),
  backupsDir: paths.editorBackups,
  reveal: (target) => {
    shell.showItemInFolder(target);
    return true;
  },
});

/**
 * The folders a renderer may point git at: every open tab's cwd plus the
 * remembered projects. Rebuilt per request (a cheap set) so opening a project
 * makes it addressable without a restart, and closed so a renderer cannot name a
 * folder the user never opened.
 */
async function resolveGitProjectPath(value: unknown): Promise<string> {
  const known = new Set<string>();
  for (const tab of sessions?.tabs() ?? []) {
    if (tab.cwd) known.add(tab.cwd);
  }
  const state = await appState.read();
  if (state.activeProject) known.add(state.activeProject);
  for (const project of state.projects) known.add(project.path);
  return requireProjectPath([...known], value);
}

/**
 * The app-wide diagnostics service (plan step 22). It reads what already exists —
 * hosts and their logs, incidents, extension errors, the Office probe — and
 * renders the redacted support bundle. `save` lives here because it is the one
 * step that needs Electron's dialog.
 */

/** One repository, flattened for the support bundle. */
function diagnosticRepo(snapshot: GitSnapshot): DiagnosticsGitInfo["repos"][number] {
  return {
    root: snapshot.repo?.root ?? snapshot.projectPath,
    branch: snapshot.repo?.branch ?? null,
    dirty: (snapshot.totalChanged ?? 0) > 0,
    lastStatusMs: null,
    // The sentence the rail already showed; `redactSecrets` strips an address
    // out of it before the bundle is written.
    lastError: snapshot.error?.message ?? null,
  };
}

/** `git --version`'s first line, once, in the background. */
async function probeGitVersion(): Promise<void> {
  const result = await createNodeGitRunner().run(process.cwd(), ["--version"], {
    timeoutMs: 5_000,
  });
  // Only the first line matters (`git version 2.x`); the runner returns raw stdout.
  const line = result.stdout.trim().split("\n")[0]?.trim();
  gitVersion = result.code === 0 && line ? line : null;
}

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
  // Source control and folder checkpoints (git-checkpoint plan step 28). Both
  // read small registries maintained below, so the bundle reports what the *rail*
  // saw rather than the outcome of a second, differently-timed probe.
  git: () => ({ version: gitVersion, repos: [...lastGitSnapshots.values()].map(diagnosticRepo) }),
  checkpoints: () => ({
    root: checkpointRootDir,
    enabled: lastCheckpointState?.enabled ?? true,
    projects: [],
    runSnapshots: lastCheckpointState?.runSnapshots ?? false,
  }),
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

    // One-time default-off pass: snapshot/empty any existing project settings
    // document before the first session can read it. A failure is logged and
    // retried on the next launch; the renderer shows the project warning.
    const migration = await projectSettingsService.migrate();
    if (!migration.migrated) {
      console.warn(
        `[pi-desktop] project settings migration: ${migration.errors.join("; ") || "incomplete"}`,
      );
    }

    // Updates (plan step 26): only a packaged build can have a feed, the
    // Electron adapter answers whether `electron-updater` loaded, and the build
    // provenance decides whether this package is local or a released CI build.
    const updateOffline = isOfflineEnv(process.env.PI_OFFLINE);
    const updatePort =
      app.isPackaged && !safeMode && !updateOffline ? await createElectronUpdatePort() : null;
    const updateSupport = resolveUpdateSupport({
      isPackaged: app.isPackaged,
      safeMode,
      offline: updateOffline,
      portAvailable: updatePort !== null,
    });
    const bootstrapPrefs = (await appState.read()).prefs;
    let autoCheckDone = false;
    let lastAutoCheckPref = bootstrapPrefs.updates.autoCheck;
    const cancelAutoCheck = (): void => {
      if (updateCheckTimer) clearTimeout(updateCheckTimer);
      updateCheckTimer = null;
    };
    const scheduleAutoCheck = (autoCheck: boolean): void => {
      if (updateCheckTimer || autoCheckDone) return;
      if (
        !autoCheckAllowed({
          support: updateSupport,
          autoCheck,
          buildChannel: buildInfo.channel,
        })
      ) {
        return;
      }
      updateCheckTimer = setTimeout(() => {
        updateCheckTimer = null;
        autoCheckDone = true;
        void updateService?.check({ automatic: true });
      }, 10_000);
    };
    updateService = createUpdateService({
      port: updatePort,
      supported: updateSupport.supported,
      unsupportedReason: updateSupport.reason,
      currentVersion: app.getVersion(),
      onChange: (state) => broadcastToWindows(IPC.updatesState, state),
    });
    const fallbackUpdateState = () =>
      initialUpdateState(false, {
        unsupportedReason: "updater-unavailable",
        currentVersion: app.getVersion(),
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
      website: PI_DESKTOP_RELEASES_URL,
      ...(process.platform === "darwin" ? {} : { applicationIcon: branding.png512 }),
    });

    // The application menu is the app's command surface; its items never touch
    // windows directly — they forward a MenuCommand to the renderer.
    // Menu accelerators come from the desktop keymap (session-parity plan step
    // 23), so remapping a desktop action moves the menu item too.
    const installMenu = async (): Promise<void> => {
      const { prefs } = await appState.read();
      await installAppMenu({
        appName: APP_NAME,
        isMac: process.platform === "darwin",
        onCommand: (command) => broadcastToWindows(IPC.appMenuCommand, command),
        onOpenExternal: (url) => {
          void openExternal(url);
        },
        accelerators: menuAcceleratorsFor(resolveDesktopKeymap(prefs.desktopKeybindings)),
      });
    };
    await installMenu();

    registerIpcHandlers({
      appInfo: currentAppInfo,
      openExternal,
      pickDirectory: pickProjectDirectory,
      pickFile: pickSessionFile,
      // `/share`: copy the session JSONL (redacted) into the app's scratch area
      // and upload it as a secret gist (plan step 18).
      shareSession: (sessionFile: unknown) => {
        if (typeof sessionFile !== "string" || sessionFile.length === 0) {
          return Promise.resolve({ ok: false, error: "no_file" });
        }
        return shareSession(
          {
            fs: createNodeFsPort(),
            runner: createCommandRunner(),
            scratchDir: join(paths.userData, "share"),
            env: process.env,
          },
          sessionFile,
        );
      },
      // Ctrl+G's OS-editor path (plan step 21): spawned without a shell and
      // awaited, so a GUI editor that exits immediately still reports honestly.
      openEditor: (draft: unknown, setting: unknown) =>
        openInExternalEditor(
          {
            fs: createNodeFsPort(),
            runner: createCommandRunner(),
            scratchDir: join(paths.userData, "editor"),
            setting: typeof setting === "string" ? setting : null,
            env: process.env,
          },
          typeof draft === "string" ? draft : "",
        ),
      // `/bug`: a local zip; nothing is uploaded from the app (Radius upload is
      // documented as not wired in this build).
      shareBugReport: async (input: unknown) => {
        const request = (input ?? {}) as {
          sessionFile?: string | null;
          includeTranscript?: boolean;
          hint?: string | null;
          versions?: Record<string, string | null | undefined>;
          diagnostics?: unknown;
        };
        const fs = createNodeFsPort();
        const transcript =
          request.includeTranscript === true &&
          typeof request.sessionFile === "string" &&
          request.sessionFile.length > 0
            ? await fs.readTextFile(request.sessionFile)
            : null;
        return buildBugReport(
          {
            fs,
            runner: createCommandRunner(),
            scratchDir: join(paths.userData, "share"),
            env: process.env,
          },
          {
            versions: request.versions ?? {},
            diagnostics: request.diagnostics ?? null,
            transcript,
            hint: request.hint ?? null,
            summary: summarizeForBugReport(messagesFromJsonl(transcript ?? "")),
          },
        );
      },
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
          // A desktop-keymap edit rebuilds the menu so its accelerators match
          // the new chords (plan step 23).
          if (patch && typeof patch === "object" && "desktopKeybindings" in patch) {
            void installMenu();
          }
          // D19: prefs are the source, `<profile>/checkpoints/config.json` is the
          // projection the host-side extension can read. Only a patch that
          // actually touches checkpoints rewrites it, so dragging the rail's
          // width does not re-serialize the file on every mouse move.
          if (patch && typeof patch === "object" && "checkpoints" in patch) {
            await projectCheckpointConfig(prefs.checkpoints);
          }
          // Display zoom is a window property, not a renderer style: apply it
          // here so a menu click or the status-bar cluster takes effect at once.
          if (patch && typeof patch === "object" && "zoomFactor" in patch) {
            applyZoom(prefs.zoomFactor);
          }
          // Update checks follow the preference immediately. Turning it off
          // cancels a pending startup timer; turning it on schedules one (but
          // only for a supported, non-local build).
          if (patch && typeof patch === "object" && "updates" in patch) {
            if (!prefs.updates.autoCheck) {
              cancelAutoCheck();
            } else if (!lastAutoCheckPref) {
              autoCheckDone = false;
              scheduleAutoCheck(prefs.updates.autoCheck);
            }
            lastAutoCheckPref = prefs.updates.autoCheck;
          }
          return prefs;
        },
      },
      sessions: sessionsIpc,
      projects: {
        get: () => projectsService.snapshot(),
        mutate: async (input: ProjectMutation) => {
          // Defense in depth for requirement 3: even a caller that forgets to
          // close the project's tabs first cannot leave orphan tabs behind.
          if (input.action === "remove") await sessions?.closeForProject(input.path);
          return projectsService.mutate(input);
        },
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
        setSettings: (input) => projectSettingsService.setEnabled(input),
      },
      officeSetup,
      integrations: {
        get: () => integrationsService.get(),
        recordOffice: (patch: unknown) => integrationsService.recordOffice(patch),
      },
      // The Office session owns the bridge and the app owns the session, so Stop
      // aborts that session's run — which ends a pane's answer for every bridge
      // version (protocol v3 additionally lets a pane stop its own run).
      officeControl,
      officeRun: {
        stop: async (): Promise<OfficeStopResult> => {
          const view = officeDocuments.get();
          const ownerTab = officeBridgeOwnerTab(view, sessions?.envelope().tabs ?? []);
          const host = ownerTab ? hosts?.get(ownerTab.id) : undefined;
          if (!host) {
            // A terminal/foreign process owns the bridge; the app cannot abort
            // a run it does not host, and saying "idle" would be a lie.
            return { ok: false, reason: view.available && view.owner ? "external" : "idle" };
          }
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
        get: () => updateService?.state() ?? fallbackUpdateState(),
        check: async () => {
          // A user gesture wins over the pending startup check.
          cancelAutoCheck();
          autoCheckDone = true;
          return updateService ? updateService.check() : fallbackUpdateState();
        },
        download: async () => (updateService ? updateService.download() : fallbackUpdateState()),
        install: () => updateService?.install() ?? false,
        clearProblem: () => updateService?.clearProblem() ?? fallbackUpdateState(),
      },
      officeDocuments: {
        get: () => officeDocuments.get(),
        refresh: () => officeDocuments.refresh(),
      },
      git: {
        resolveProjectPath: resolveGitProjectPath,
        snapshot: (projectPath) => gitPush.snapshot(projectPath),
        refresh: (projectPath) => gitPush.refresh(projectPath),
        watch: (projectPath, enabled) => gitPush.watch(projectPath, enabled),
        action: (projectPath, action) => gitPush.action(projectPath, action),
        diff: (projectPath, request) => gitPush.diff(projectPath, request),
        log: (projectPath, request) => gitPush.log(projectPath, request),
        headMessage: (projectPath) => gitPush.headMessage(projectPath),
        branches: (projectPath) => gitPush.branches(projectPath),
      },
      checkpoints: {
        // The same folder allowlist the git rail uses: one rule, one place.
        resolveProjectPath: resolveGitProjectPath,
        get: (projectPath) => checkpointService.get(projectPath),
        refresh: (projectPath) => checkpointService.refresh(projectPath),
        action: (projectPath, action) => checkpointService.action(projectPath, action),
      },
      workspace: {
        // One allowlist for git, checkpoints and the explorer: the folder must
        // be an open tab's cwd or a remembered project.
        resolveProjectPath: resolveGitProjectPath,
        listDirectory: (input) => workspaceService.listDirectory(input),
        listFiles: (input) => workspaceService.listFiles(input),
        searchFiles: (input) => workspaceService.searchFiles(input),
        readFile: (input) => workspaceService.readFile(input),
        stat: (input) => workspaceService.stat(input),
        writeFile: (input) => workspaceService.writeFile(input),
        create: (input) => workspaceService.create(input),
        rename: (input) => workspaceService.rename(input),
        delete: (input) => workspaceService.delete(input),
        transfer: (input) => workspaceService.transfer(input),
        reveal: (input) => workspaceService.reveal(input),
        editorConfig: (input) => workspaceService.editorConfig(input),
        readBackup: (tabId) => workspaceService.readBackup(tabId),
        writeBackup: (backup) => workspaceService.writeBackup(backup),
        deleteBackup: (tabId) => workspaceService.deleteBackup(tabId),
        format: async (input) => {
          const prefs = (await appState.read()).prefs.editor;
          const config = await workspaceService.editorConfig({
            projectPath: input.projectPath,
            path: input.path,
          });
          return formatWorkspaceText(input, {
            policy: {
              commandFormattersAllowed: async () => prefs.allowCommandFormatters,
              commandFor: async (languageId) => prefs.formatters[languageId] ?? null,
            },
            editorConfig: async () =>
              config.ok
                ? config.value
                : {
                    indentStyle: "space",
                    indentSize: 2,
                    tabWidth: 2,
                    endOfLine: "lf",
                    insertFinalNewline: true,
                    trimTrailingWhitespace: true,
                  },
            runCommand: runFormatterCommand,
          });
        },
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
    // Load the persisted display zoom before the window paints; `applyZoom`
    // after creation covers the already-loaded case and every extra window.
    const startupPrefs = (await appState.read()).prefs;
    windowZoomFactor = clampZoomFactor(startupPrefs.zoomFactor);
    mainWindow = createWindow();
    applyZoom(windowZoomFactor);
    // Check once, unobtrusively, in the background. A user can always ask from
    // Help → Check for Updates; this is the "there is a newer build" path.
    // Local/dev/offline/safe-mode builds are excluded by `autoCheckAllowed`,
    // and the timer is cleared on quit.
    scheduleAutoCheck(lastAutoCheckPref);
    // The registry poll is cheap (one loopback GET) and the panel must reflect a
    // bridge that a terminal Pi session owns, so it runs whenever the app does.
    // Safe mode starts with zero third-party code, so the poll stays off there.
    if (!safeMode) {
      // Read the stable install fact before the first probe, so a restart with a
      // configured bridge paints the Documents menu on the first frame rather
      // than waiting for `/health` to answer.
      await refreshBridgeConfigured();
      officeDocuments.start();
    }
    // Git polling is not third-party code, so it runs in safe mode too; it only
    // costs anything while the rail's Git section is open.
    gitPush.start();
    // The idle scan (D15) only snapshots a folder that has an attached Office
    // pane and an open session, and only every `scanIntervalMs`; the ticker is
    // unref'd so it can never hold the app open.
    checkpointService.start();
    // `git --version`, once, for Diagnostics. A missing git is a normal state
    // (R1), not an error, so the probe is fire-and-forget.
    void probeGitVersion();
    // Project the current checkpoint preferences once at startup, so a profile
    // that has never opened Settings still has a readable `config.json` for the
    // host-side extension (D19: main is the only writer).
    await projectCheckpointConfig((await appState.read()).prefs.checkpoints);

    // A suspended machine can lose a child process or miss status pushes. Make
    // the tab table truthful on return; the renderer's focus resync wakes the
    // active tab. `reconcile` never spawns, so background tabs stay asleep.
    const reconcileSessions = (): void => {
      void sessions?.reconcile().catch(() => undefined);
    };
    powerMonitor.on("resume", reconcileSessions);
    powerMonitor.on("unlock-screen", reconcileSessions);

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
      gitPush.dispose();
      checkpointService.dispose();
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
