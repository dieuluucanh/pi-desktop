import type { AppInfo, PiDesktopBridge, WebTabOpenInput } from "../../src/shared/ipc";
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
import {
  projectNameOf,
  type ProjectRecord,
  type ProjectsSnapshot,
} from "../../src/shared/projects";

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
    settingsFile: "C:\\Users\\test\\.pi\\agent\\settings.json",
    authFile: "C:\\Users\\test\\.pi\\agent\\auth.json",
    modelsFile: "C:\\Users\\test\\.pi\\agent\\models.json",
    appStateFile: "C:\\state\\app-state.json",
    runtimeSource: "bundled",
    runtimeNodeVersion: "24.21.0",
    runtimeProblems: [],
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
    port: 38617,
    status: "unknown",
    serverVersion: null,
    protocolVersion: null,
    catalogVersion: null,
    compatibility: null,
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
}

export interface BridgeHandles {
  bridge: PiDesktopBridge;
  prefs: UiPrefs;
  webOpened: WebTabOpenInput[];
  webCommands: Array<{ tabId: string; command: WebCommand }>;
  webBounds: Array<{ tabId: string; bounds: WebTabBounds }>;
  webDecisions: WebNavigationDecision[];
  emitWebState(state: WebTabState): void;
  emitWebNavigationRequest(request: WebNavigationRequest): void;
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
  const projectsState: ProjectsSnapshot = {
    projects: options.projects ?? [],
    activeProject: options.activeProject ?? null,
  };
  const diagnosticsView: DiagnosticsSnapshot = {
    ...diagnosticsSnapshot(info),
    ...options.diagnostics,
  };

  const bridge: PiDesktopBridge = {
    getAppInfo: async () => info,
    openExternal: async () => true,
    pickDirectory: async () => null,
    revealPath: async () => true,
    setTitle: async () => true,
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
      activate: async () => ({ tabs: [], activeTabId: null }),
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
  };

  (window as unknown as { pi: PiDesktopBridge }).pi = bridge;
  return {
    bridge,
    prefs,
    webOpened,
    webCommands,
    webBounds,
    webDecisions,
    emitWebState: (state) => {
      for (const listener of webStateListeners) listener(state);
    },
    emitWebNavigationRequest: (request) => {
      for (const listener of webNavListeners) listener(request);
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
  };
}
