import type { AppInfo, PiDesktopBridge, WebTabOpenInput } from "../../src/shared/ipc";
import { HOST_METHODS } from "../../src/shared/host-protocol";
import type { DiagnosticsSnapshot } from "../../src/shared/diagnostics";
import type {
  WebCommand,
  WebNavigationDecision,
  WebNavigationRequest,
  WebTabBounds,
  WebTabState,
} from "../../src/shared/web-tabs";
import type { OfficeSetupView } from "../../src/shared/office-setup";
import type { OfficeDocumentsView } from "../../src/shared/office-documents";
import { emptyIntegrationsState, type IntegrationsState } from "../../src/shared/integrations";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { UiPrefs } from "../../src/shared/prefs";
import { initialUpdateState, type UpdateState } from "../../src/shared/updates";
import {
  emptyGitSnapshot,
  type GitActionResult,
  type GitCommitEntry,
  type GitDiff,
  type GitSnapshot,
} from "../../src/shared/git";
import {
  emptyCheckpointState,
  type CheckpointActionResult,
  type CheckpointState,
} from "../../src/shared/checkpoints";
import {
  projectNameOf,
  type ProjectRecord,
  type ProjectsSnapshot,
} from "../../src/shared/projects";
import { useAppStore } from "../../src/renderer/src/state/app-store";

/** Shared renderer-test fixtures (plan step 1). */

export function appInfoFixture(overrides: Partial<AppInfo> = {}): AppInfo {
  return {
    name: "Pi Desktop",
    version: "0.0.1",
    electron: "44.4.3",
    chrome: "152.0.0",
    node: "24.21.0",
    platform: "win32",
    arch: "x64",
    isDev: true,
    safeMode: false,
    piOffline: false,
    userDataDir: "C:\\state",
    homeDir: "C:\\Users\\test",
    logsDir: "C:\\state\\logs",
    blobCacheDir: "C:\\state\\blobs",
    profileDir: "C:\\Users\\test\\.pi\\agent",
    profileMode: "shared",
    settingsFile: "C:\\Users\\test\\.pi\\agent\\settings.json",
    authFile: "C:\\Users\\test\\.pi\\agent\\auth.json",
    modelsFile: "C:\\Users\\test\\.pi\\agent\\models.json",
    appStateFile: "C:\\state\\app-state.json",
    runtimeSource: "bundled",
    runtimeNodeVersion: "24.21.0",
    runtimeProblems: [],
    hostMethods: [...HOST_METHODS],
    ...overrides,
  };
}

export function officeViewFixture(overrides: Partial<OfficeSetupView> = {}): OfficeSetupView {
  return {
    status: "idle",
    currentStep: null,
    running: false,
    startedAt: null,
    finishedAt: null,
    dryRun: false,
    port: 38617,
    steps: [],
    detection: null,
    bridge: null,
    sideload: null,
    openOffice: null,
    health: null,
    bridgeConnect: null,
    compatibility: null,
    run: null,
    panes: [],
    troubleshooting: [],
    diagnostics: "",
    redactions: 0,
    error: null,
    log: [],
    ...overrides,
  };
}

/** An empty-but-available pane registry (no panes attached). */
export function documentsViewFixture(
  overrides: Partial<OfficeDocumentsView> = {},
): OfficeDocumentsView {
  return {
    available: false,
    configured: false,
    port: 38617,
    status: "unknown",
    serverVersion: null,
    protocolVersion: null,
    catalogVersion: null,
    compatibility: null,
    owner: null,
    manualLifecycle: false,
    panes: [],
    fetchedAt: new Date(0).toISOString(),
    error: null,
    ...overrides,
  };
}

export interface BridgeOptions {
  appInfo?: Partial<AppInfo>;
  prefs?: Partial<UiPrefs>;
  office?: OfficeSetupView;
  documents?: OfficeDocumentsView;
  projects?: ProjectRecord[];
  activeProject?: string | null;
  integrations?: IntegrationsState;
  diagnostics?: Partial<DiagnosticsSnapshot>;
  /** The updater's starting state (plan step 26); defaults to "unsupported". */
  update?: UpdateState;
  /** Source control (git-checkpoint plan step 9). */
  git?: GitSnapshot;
  gitDiff?: GitDiff;
  gitLog?: GitCommitEntry[];
  gitAction?: GitActionResult;
  /** HEAD's commit message the amend box prefills from. */
  headMessage?: string | null;
  /** Local branch names the checkout menu offers. */
  branches?: string[];
  /** Folder checkpoints (git-checkpoint plan step 21). */
  checkpoints?: CheckpointState;
  checkpointsAction?: CheckpointActionResult;
}

export interface BridgeHandles {
  bridge: PiDesktopBridge;
  prefs: UiPrefs;
  webOpened: WebTabOpenInput[];
  webCommands: Array<{ tabId: string; command: WebCommand }>;
  webBounds: Array<{ tabId: string; bounds: WebTabBounds }>;
  webDecisions: WebNavigationDecision[];
  updateCalls: string[];
  /** Every git bridge call, in order, with its payload. */
  gitCalls: Array<{ kind: string; projectPath: string; payload?: unknown }>;
  checkpointCalls: Array<{ kind: string; projectPath: string; payload?: unknown }>;
  emitCheckpointState: (state: CheckpointState) => void;
  emitWebState(state: WebTabState): void;
  emitWebNavigationRequest(request: WebNavigationRequest): void;
  emitUpdateState(state: UpdateState): void;
  /** Pushes a git snapshot to the renderer, like main's poll would. */
  emitGitSnapshot(snapshot: GitSnapshot): void;
}

/** Installs a `window.pi` stub and returns the prefs store it writes to. */
export function installBridge(options: BridgeOptions = {}): BridgeHandles {
  const prefs: UiPrefs = { ...DEFAULT_PREFS, ...options.prefs };
  const info = appInfoFixture(options.appInfo);
  const view = options.office ?? officeViewFixture();
  const documents = options.documents ?? documentsViewFixture();
  let integrationsState: IntegrationsState = options.integrations ?? emptyIntegrationsState();
  const webStateListeners = new Set<(state: WebTabState) => void>();
  const webNavListeners = new Set<(request: WebNavigationRequest) => void>();
  const webOpened: WebTabOpenInput[] = [];
  const webCommands: Array<{ tabId: string; command: WebCommand }> = [];
  const webBounds: Array<{ tabId: string; bounds: WebTabBounds }> = [];
  const webDecisions: WebNavigationDecision[] = [];
  const updateListeners = new Set<(state: UpdateState) => void>();
  const updateCalls: string[] = [];
  let updateState: UpdateState = options.update ?? initialUpdateState(false);
  const projectsState: ProjectsSnapshot = {
    projects: options.projects ?? [],
    activeProject: options.activeProject ?? null,
  };
  const diagnosticsView: DiagnosticsSnapshot = {
    ...diagnosticsSnapshot(info),
    ...options.diagnostics,
  };

  const gitListeners = new Set<(snapshot: GitSnapshot) => void>();
  const gitCalls: Array<{ kind: string; projectPath: string; payload?: unknown }> = [];
  const checkpointCalls: Array<{ kind: string; projectPath: string; payload?: unknown }> = [];
  const checkpointListeners = new Set<(state: CheckpointState) => void>();
  const checkpointValue: CheckpointState =
    options.checkpoints ?? emptyCheckpointState("/work/app", 1_700_000_000_000);
  const checkpointActionResult: CheckpointActionResult = options.checkpointsAction ?? { ok: true };
  const gitSnapshotValue: GitSnapshot = options.git ?? emptyGitSnapshot("/work/app");
  const gitDiffValue: GitDiff = options.gitDiff ?? {
    scope: "working",
    files: [],
    tooLarge: false,
    truncated: false,
  };
  const gitLogValue: GitCommitEntry[] = options.gitLog ?? [];
  const gitActionResult: GitActionResult = options.gitAction ?? { ok: true };
  const gitHeadMessage: string | null = options.headMessage ?? null;
  const gitBranches: string[] = options.branches ?? [];

  const bridge: PiDesktopBridge = {
    getAppInfo: async () => info,
    openExternal: async () => true,
    pickDirectory: async () => null,
    pickFile: async () => null,
    share: {
      session: async () => ({
        ok: true,
        gistUrl: "https://gist.github.com/abc",
        viewerUrl: "https://pi.dev/session/#abc",
      }),
      bugReport: async () => ({ ok: true, path: "/tmp/report.zip", bytes: 10 }),
      editor: async () => ({ ok: false, error: "No external editor is configured." }),
    },
    revealPath: async () => true,
    setTitle: async () => true,
    relaunch: async () => true,
    onWindowState: () => () => undefined,
    onMenuCommand: () => () => undefined,
    prefs: {
      get: async () => ({ ...prefs }),
      set: async (patch) => {
        Object.assign(prefs, patch);
        return { ...prefs };
      },
    },
    sessions: {
      list: async () => ({ tabs: [], activeTabId: null }),
      create: async () => ({ tabs: [], activeTabId: null }),
      close: async () => ({ tabs: [], activeTabId: null }),
      closeOthers: async () => ({ tabs: [], activeTabId: null }),
      reorder: async () => ({ tabs: [], activeTabId: null }),
      promoteOfficeHost: async () => ({ tabs: [], activeTabId: null }),
      // `activate` (and `deactivate`) must answer with the *current* tab table:
      // the store applies the response, so an empty envelope would wipe the tabs
      // on any host wake (a keystroke, a click on the composer). Main always
      // publishes its real table here, and so must the fake.
      activate: async (tabId: string) => ({
        tabs: useAppStore.getState().tabs,
        activeTabId: tabId,
      }),
      deactivate: async () => ({ tabs: useAppStore.getState().tabs, activeTabId: null }),
      reconcile: async () => ({ tabs: [], activeTabId: null }),
      restore: async () => ({ tabs: [], activeTabId: null }),
      restart: async () => ({ tabs: [], activeTabId: null }),
      request: async () => ({}),
      deleteSession: async (sessionFile: string) => ({ ok: true, path: sessionFile }),
      onEvent: () => () => undefined,
      onState: () => () => undefined,
      onTabs: () => () => undefined,
    },
    projects: {
      get: async () => ({
        projects: [...projectsState.projects],
        activeProject: projectsState.activeProject,
      }),
      mutate: async (input) => {
        // A small in-memory stand-in for the main-process store, so store tests
        // exercise add/activate/remove without a real app-state.json.
        if (input.action === "add") {
          const existing = projectsState.projects.find((project) => project.path === input.path);
          const record: ProjectRecord = existing ?? {
            path: input.path,
            name: projectNameOf(input.path),
            addedAt: 1,
            lastOpenedAt: 1,
          };
          projectsState.projects = [
            record,
            ...projectsState.projects.filter((project) => project.path !== input.path),
          ];
          projectsState.activeProject = record.path;
        } else if (input.action === "activate") {
          projectsState.activeProject = input.path;
        } else if (input.action === "remove") {
          projectsState.projects = projectsState.projects.filter(
            (project) => project.path !== input.path,
          );
          if (projectsState.activeProject === input.path) {
            projectsState.activeProject = projectsState.projects[0]?.path ?? null;
          }
        }
        return {
          projects: [...projectsState.projects],
          activeProject: projectsState.activeProject,
        };
      },
      create: async () => ({ ok: false, path: null, error: "not configured", ...projectsState }),
      clone: async () => ({ ok: false, path: null, error: "not configured", ...projectsState }),
      action: async () => true,
      setSettings: async (input) => {
        const project = projectsState.projects.find((entry) => entry.path === input.path);
        if (project) {
          if (input.enabled) project.useProjectSettings = true;
          else delete project.useProjectSettings;
        }
        return {
          projects: [...projectsState.projects],
          activeProject: projectsState.activeProject,
          enabled: input.enabled,
          saved: false,
          restored: false,
          keptCurrent: false,
          settingsPath: `${input.path}/.pi/settings.json`,
        };
      },
    },
    office: {
      get: async () => view,
      start: async () => view,
      retry: async () => view,
      cancel: async () => view,
      refreshHealth: async () => view,
      unsideload: async () => view,
      diagnostics: async () => "",
      reveal: async () => true,
      stopRun: async () => ({ ok: true }),
      onState: () => () => undefined,
      documents: async () => documents,
      refreshDocuments: async () => documents,
      onDocuments: () => () => undefined,
      connectBridge: async () => ({ ok: true, reason: "connected" }),
      closeBridge: async () => ({ ok: true, reason: "closed" }),
      restartBridge: async () => ({ ok: true, reason: "connected" }),
    },
    integrations: {
      get: async () => integrationsState,
      recordOffice: async (patch) => {
        integrationsState = {
          office: {
            bridgeInstalledAt:
              "bridgeInstalledAt" in patch
                ? (patch.bridgeInstalledAt ?? null)
                : integrationsState.office.bridgeInstalledAt,
            lastSetupAt:
              "lastSetupAt" in patch
                ? (patch.lastSetupAt ?? null)
                : integrationsState.office.lastSetupAt,
          },
        };
        return integrationsState;
      },
    },
    web: {
      open: async (input) => {
        webOpened.push(input);
        return { tabs: [], activeTabId: null };
      },
      setBounds: async (tabId, bounds) => {
        webBounds.push({ tabId, bounds });
        return true;
      },
      command: async (tabId, command) => {
        webCommands.push({ tabId, command });
        return true;
      },
      decideNavigation: async (decision) => {
        webDecisions.push(decision);
        return true;
      },
      onState: (listener) => {
        webStateListeners.add(listener);
        return () => webStateListeners.delete(listener);
      },
      onNavigationRequest: (listener) => {
        webNavListeners.add(listener);
        return () => webNavListeners.delete(listener);
      },
    },
    diagnostics: {
      get: async () => diagnosticsView,
      export: async () => ({ text: "bundle", redactions: 0, generatedAt: 0 }),
      save: async () => ({ ok: true, path: "C:\\bundle.txt" }),
      record: async () => true,
    },
    updates: {
      get: async () => {
        updateCalls.push("get");
        return updateState;
      },
      check: async () => {
        updateCalls.push("check");
        return updateState;
      },
      download: async () => {
        updateCalls.push("download");
        return updateState;
      },
      install: async () => {
        updateCalls.push("install");
        return true;
      },
      onState: (listener) => {
        updateListeners.add(listener);
        return () => updateListeners.delete(listener);
      },
    },
    git: {
      snapshot: async (projectPath) => {
        gitCalls.push({ kind: "snapshot", projectPath });
        return { ...gitSnapshotValue, projectPath };
      },
      refresh: async (projectPath) => {
        gitCalls.push({ kind: "refresh", projectPath });
        return { ...gitSnapshotValue, projectPath };
      },
      watch: async (projectPath, enabled) => {
        gitCalls.push({ kind: "watch", projectPath, payload: enabled });
        return enabled;
      },
      action: async (projectPath, action) => {
        gitCalls.push({ kind: "action", projectPath, payload: action });
        return gitActionResult;
      },
      diff: async (projectPath, request) => {
        gitCalls.push({ kind: "diff", projectPath, payload: request });
        return gitDiffValue;
      },
      log: async (projectPath, request) => {
        gitCalls.push({ kind: "log", projectPath, payload: request });
        return gitLogValue;
      },
      headMessage: async (projectPath) => {
        gitCalls.push({ kind: "head-message", projectPath });
        return gitHeadMessage;
      },
      branches: async (projectPath) => {
        gitCalls.push({ kind: "branches", projectPath });
        return gitBranches;
      },
      onSnapshot: (listener) => {
        gitListeners.add(listener);
        return () => gitListeners.delete(listener);
      },
    },
    checkpoints: {
      get: async (projectPath) => {
        checkpointCalls.push({ kind: "get", projectPath });
        return { ...checkpointValue, projectPath };
      },
      refresh: async (projectPath) => {
        checkpointCalls.push({ kind: "refresh", projectPath });
        return { ...checkpointValue, projectPath };
      },
      action: async (projectPath, action) => {
        checkpointCalls.push({ kind: "action", projectPath, payload: action });
        return checkpointActionResult;
      },
      onState: (listener) => {
        checkpointListeners.add(listener);
        return () => checkpointListeners.delete(listener);
      },
    },
  };

  (window as unknown as { pi: PiDesktopBridge }).pi = bridge;
  return {
    bridge,
    prefs,
    gitCalls,
    emitGitSnapshot: (snapshot: GitSnapshot) => {
      for (const listener of gitListeners) listener(snapshot);
    },
    checkpointCalls,
    emitCheckpointState: (state: CheckpointState) => {
      for (const listener of checkpointListeners) listener(state);
    },
    webOpened,
    webCommands,
    webBounds,
    webDecisions,
    updateCalls,
    emitWebState: (state) => {
      for (const listener of webStateListeners) listener(state);
    },
    emitWebNavigationRequest: (request) => {
      for (const listener of webNavListeners) listener(request);
    },
    emitUpdateState: (state) => {
      updateState = state;
      for (const listener of updateListeners) listener(state);
    },
  };
}

export function removeBridge(): void {
  delete (window as unknown as { pi?: PiDesktopBridge }).pi;
}

/** A minimal, consistent diagnostics snapshot for renderer tests (plan step 22). */
function diagnosticsSnapshot(info: AppInfo): DiagnosticsSnapshot {
  return {
    generatedAt: 1,
    safeMode: info.safeMode,
    app: {
      name: info.name,
      version: info.version,
      electron: info.electron,
      chrome: info.chrome,
      node: info.node,
      platform: info.platform,
      arch: info.arch,
      isDev: info.isDev,
      safeMode: info.safeMode,
    },
    runtime: {
      source: info.runtimeSource,
      nodeVersion: info.runtimeNodeVersion,
      problems: info.runtimeProblems,
    },
    paths: {
      userDataDir: info.userDataDir,
      homeDir: info.homeDir,
      logsDir: info.logsDir,
      blobCacheDir: info.blobCacheDir,
      profileDir: info.profileDir,
      settingsFile: info.settingsFile,
      authFile: info.authFile,
      modelsFile: info.modelsFile,
      appStateFile: info.appStateFile,
    },
    hosts: [],
    capacity: {
      hosts: { used: 0, limit: 8, atCapacity: false },
      tabs: { used: 0, limit: 8, atCapacity: false },
    },
    memory: { budgetBytes: 536_870_912, restartBytes: 1_610_612_736 },
    incidents: [],
    extensionErrors: [],
    office: {
      available: false,
      status: "unreachable",
      port: 38617,
      protocolVersion: null,
      panes: 0,
    },
    environment: {},
    startup: {
      startedAt: 0,
      appReadyAt: null,
      windowInteractiveAt: null,
      sessionReadyAt: null,
      sessionWarm: false,
      appReadyMs: null,
      windowInteractiveMs: null,
      sessionReadyMs: null,
      windowInteractive: {
        label: "Window interactive",
        budgetMs: 2_500,
        actualMs: null,
        status: "unknown",
      },
      sessionReady: {
        label: "Warm session ready",
        budgetMs: 5_000,
        actualMs: null,
        status: "unknown",
      },
      status: "unknown",
    },
    // Source control and folder checkpoints (git-checkpoint plan step 28).
    git: { version: null, repos: [] },
    checkpoints: { root: null, enabled: false, projects: [], runSnapshots: false },
  };
}
