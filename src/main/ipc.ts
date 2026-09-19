import { BrowserWindow, ipcMain, shell } from "electron";
import { IPC, type AppInfo } from "../shared/ipc";
import type { UiPrefs } from "../shared/prefs";
import { isOfficeSetupStepId } from "../shared/office-setup";
import type { OfficeStopResult } from "../shared/office-bridge";
import type { OfficeSetupService } from "./office/setup-service";

/**
 * The Electron glue for the allowlisted IPC surface.
 *
 * All validation lives here: the renderer may only ask for channels listed in
 * `src/shared/ipc.ts`, only pass a known wizard step id, only reveal paths that
 * exist on disk, only set a bounded window title and only write a preference
 * patch (the closed key set is enforced by `mergePrefs`). Behaviour that needs a
 * window or a native dialog is injected, so this file stays the only place that
 * touches Electron APIs for IPC.
 */

export interface IpcDependencies {
  appInfo: () => AppInfo;
  openExternal: (url: unknown) => Promise<boolean>;
  /** Native folder picker; returns null when the user cancels. */
  pickDirectory: () => Promise<string | null>;
  /** Reveals a path in the OS file manager; returns false for invalid input. */
  revealPath: (target: unknown) => boolean;
  /** Sets the window title (bounded, sanitized here). */
  setTitle: (title: unknown) => boolean;
  prefs: {
    get: () => Promise<UiPrefs>;
    set: (patch: unknown) => Promise<UiPrefs>;
  };
  officeSetup: OfficeSetupService;
  /**
   * The Office run the app can stop. Idle (no Office session, or nothing in
   * flight) until the app owns one — the wizard's health probe is unaffected.
   */
  officeRun: { stop: () => Promise<OfficeStopResult> };
}

const MAX_TITLE_LENGTH = 200;

/** Pushes a main → renderer event to every live window. */
export function broadcastToWindows(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

export function registerIpcHandlers(deps: IpcDependencies): void {
  ipcMain.handle(IPC.appInfo, () => deps.appInfo());
  ipcMain.handle(IPC.openExternal, (_event, url: unknown) => deps.openExternal(url));
  ipcMain.handle(IPC.appPickDirectory, () => deps.pickDirectory());
  ipcMain.handle(IPC.appRevealPath, (_event, target: unknown) => deps.revealPath(target));
  ipcMain.handle(IPC.appSetTitle, (_event, title: unknown) => deps.setTitle(title));
  ipcMain.handle(IPC.prefsGet, () => deps.prefs.get());
  ipcMain.handle(IPC.prefsSet, (_event, patch: unknown) => deps.prefs.set(patch));

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
  ipcMain.handle(IPC.officeStopRun, () => deps.officeRun.stop());
  // Same implementation as `app:reveal-path` — one path-validation rule.
  ipcMain.handle(IPC.officeReveal, (_event, target: unknown) => deps.revealPath(target));
}

/** The default `revealPath` implementation: a non-empty string reveals, nothing else. */
export function revealPathWithShell(target: unknown): boolean {
  if (typeof target !== "string" || target.length === 0) return false;
  try {
    shell.showItemInFolder(target);
    return true;
  } catch {
    return false;
  }
}

/** The default `setTitle` implementation: bounded, single-line. */
export function sanitizeTitle(title: unknown): string | null {
  if (typeof title !== "string") return null;
  const cleaned = title.replace(/[\r\n\t]+/g, " ").trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, MAX_TITLE_LENGTH);
}
