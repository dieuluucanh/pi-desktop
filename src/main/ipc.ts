import { BrowserWindow, ipcMain, shell } from "electron";
import { IPC, type AppInfo } from "../shared/ipc";
import { isOfficeSetupStepId } from "../shared/office-setup";
import type { OfficeSetupService } from "./office/setup-service";

/**
 * The Electron glue for the allowlisted IPC surface.
 *
 * All validation lives here: the renderer may only ask for channels listed in
 * `src/shared/ipc.ts`, only pass a known wizard step id, and only reveal paths
 * that exist on disk (plan step 22). The wizard logic itself stays in the
 * electron-free service.
 */

export interface IpcDependencies {
  appInfo: () => AppInfo;
  openExternal: (url: unknown) => Promise<boolean>;
  officeSetup: OfficeSetupService;
}

/** Pushes a main → renderer event to every live window. */
export function broadcastToWindows(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

export function registerIpcHandlers(deps: IpcDependencies): void {
  ipcMain.handle(IPC.appInfo, () => deps.appInfo());
  ipcMain.handle(IPC.openExternal, (_event, url: unknown) => deps.openExternal(url));

  ipcMain.handle(IPC.officeGet, () => deps.officeSetup.getView());
  ipcMain.handle(IPC.officeStart, () => deps.officeSetup.start());
  ipcMain.handle(IPC.officeRetry, (_event, step: unknown) => {
    if (!isOfficeSetupStepId(step)) {
      throw new Error(`office: unknown setup step ${String(step)}`);
    }
    return deps.officeSetup.retryStep(step);
  });
  ipcMain.handle(IPC.officeCancel, () => deps.officeSetup.cancel());
  ipcMain.handle(IPC.officeRefreshHealth, () => deps.officeSetup.refreshHealth());
  ipcMain.handle(IPC.officeUnsideload, () => deps.officeSetup.unsideload());
  ipcMain.handle(IPC.officeDiagnostics, () => deps.officeSetup.diagnostics());
  ipcMain.handle(IPC.officeReveal, (_event, target: unknown) => {
    if (typeof target !== "string" || target.length === 0) return false;
    try {
      shell.showItemInFolder(target);
      return true;
    } catch {
      return false;
    }
  });
}
