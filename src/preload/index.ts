import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  IPC,
  type AppInfo,
  type MenuCommand,
  type OfficeBridge,
  type PiDesktopBridge,
  type PrefsBridge,
  type WindowState,
} from "../shared/ipc";
import type { UiPrefs } from "../shared/prefs";
import type { OfficeSetupStepId, OfficeSetupView } from "../shared/office-setup";
import type { OfficeStopResult } from "../shared/office-bridge";

/**
 * The preload is the only place that touches `ipcRenderer`. It exposes a fixed,
 * typed surface — no dynamic channel names, no `ipcRenderer` itself, no Node
 * APIs (the window runs with `sandbox: true`, `contextIsolation: true`).
 */

/** Subscribes a listener to a main → renderer push and returns an unsubscriber. */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const office: OfficeBridge = {
  get: () => ipcRenderer.invoke(IPC.officeGet) as Promise<OfficeSetupView>,
  start: () => ipcRenderer.invoke(IPC.officeStart) as Promise<OfficeSetupView>,
  retry: (step: OfficeSetupStepId) =>
    ipcRenderer.invoke(IPC.officeRetry, step) as Promise<OfficeSetupView>,
  cancel: () => ipcRenderer.invoke(IPC.officeCancel) as Promise<OfficeSetupView>,
  refreshHealth: () => ipcRenderer.invoke(IPC.officeRefreshHealth) as Promise<OfficeSetupView>,
  unsideload: () => ipcRenderer.invoke(IPC.officeUnsideload) as Promise<OfficeSetupView>,
  diagnostics: () => ipcRenderer.invoke(IPC.officeDiagnostics) as Promise<string>,
  reveal: (path: string) => ipcRenderer.invoke(IPC.officeReveal, path) as Promise<boolean>,
  stopRun: () => ipcRenderer.invoke(IPC.officeStopRun) as Promise<OfficeStopResult>,
  onState: (listener: (view: OfficeSetupView) => void) =>
    subscribe<OfficeSetupView>(IPC.officeState, listener),
};

const prefs: PrefsBridge = {
  get: () => ipcRenderer.invoke(IPC.prefsGet) as Promise<UiPrefs>,
  set: (patch: Partial<UiPrefs>) => ipcRenderer.invoke(IPC.prefsSet, patch) as Promise<UiPrefs>,
};

const bridge: PiDesktopBridge = {
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo) as Promise<AppInfo>,
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url) as Promise<boolean>,
  pickDirectory: () => ipcRenderer.invoke(IPC.appPickDirectory) as Promise<string | null>,
  revealPath: (path: string) => ipcRenderer.invoke(IPC.appRevealPath, path) as Promise<boolean>,
  setTitle: (title: string) => ipcRenderer.invoke(IPC.appSetTitle, title) as Promise<boolean>,
  onWindowState: (listener: (state: WindowState) => void) =>
    subscribe<WindowState>(IPC.windowState, listener),
  onMenuCommand: (listener: (command: MenuCommand) => void) =>
    subscribe<MenuCommand>(IPC.appMenuCommand, listener),
  prefs,
  office,
};

contextBridge.exposeInMainWorld("pi", bridge);
