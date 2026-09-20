import type { AppInfo, PiDesktopBridge } from "../../src/shared/ipc";
import type { OfficeSetupView } from "../../src/shared/office-setup";
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

export interface BridgeOptions {
  appInfo?: Partial<AppInfo>;
  prefs?: Partial<UiPrefs>;
  office?: OfficeSetupView;
  projects?: ProjectRecord[];
  activeProject?: string | null;
  integrations?: IntegrationsState;
}

/** Installs a `window.pi` stub and returns the prefs store it writes to. */
export function installBridge(options: BridgeOptions = {}): {
  bridge: PiDesktopBridge;
  prefs: UiPrefs;
} {
  const prefs: UiPrefs = { ...DEFAULT_PREFS, ...options.prefs };
  const info = appInfoFixture(options.appInfo);
  const view = options.office ?? officeViewFixture();
  let integrationsState: IntegrationsState = options.integrations ?? emptyIntegrationsState();
  const projectsState: ProjectsSnapshot = {
    projects: options.projects ?? [],
    activeProject: options.activeProject ?? null,
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
      activate: async () => ({ tabs: [], activeTabId: null }),
      restore: async () => ({ tabs: [], activeTabId: null }),
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
  };

  (window as unknown as { pi: PiDesktopBridge }).pi = bridge;
  return { bridge, prefs };
}

export function removeBridge(): void {
  delete (window as unknown as { pi?: PiDesktopBridge }).pi;
}
