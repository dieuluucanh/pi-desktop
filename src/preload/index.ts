import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type AppInfo, type PiDesktopBridge, type WindowState } from "../shared/ipc";

/**
 * The preload is the only place that touches `ipcRenderer`. It exposes a fixed,
 * typed surface — no dynamic channel names, no `ipcRenderer` itself, no Node
 * APIs (the window runs with `sandbox: true`, `contextIsolation: true`).
 */
const bridge: PiDesktopBridge = {
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo) as Promise<AppInfo>,

  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url) as Promise<boolean>,

  onWindowState: (listener: (state: WindowState) => void) => {
    const handler = (_event: IpcRendererEvent, state: WindowState): void => listener(state);
    ipcRenderer.on(IPC.windowState, handler);
    return () => {
      ipcRenderer.removeListener(IPC.windowState, handler);
    };
  },
};

contextBridge.exposeInMainWorld("pi", bridge);
