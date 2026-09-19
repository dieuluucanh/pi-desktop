import type { AppInfo, PiDesktopBridge } from "../../src/shared/ipc";
import type { OfficeSetupView } from "../../src/shared/office-setup";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { UiPrefs } from "../../src/shared/prefs";

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
}

/** Installs a `window.pi` stub and returns the prefs store it writes to. */
export function installBridge(options: BridgeOptions = {}): {
  bridge: PiDesktopBridge;
  prefs: UiPrefs;
} {
  const prefs: UiPrefs = { ...DEFAULT_PREFS, ...options.prefs };
  const info = appInfoFixture(options.appInfo);
  const view = options.office ?? officeViewFixture();

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
  };

  (window as unknown as { pi: PiDesktopBridge }).pi = bridge;
  return { bridge, prefs };
}

export function removeBridge(): void {
  delete (window as unknown as { pi?: PiDesktopBridge }).pi;
}
