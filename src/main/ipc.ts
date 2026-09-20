import { BrowserWindow, ipcMain, shell } from "electron";
import { isHostMethod, type HostMethod } from "../shared/host-protocol";
import { IPC, type AppInfo, type ProjectOpResponse, type SessionDeleteResult } from "../shared/ipc";
import type { UiPrefs } from "../shared/prefs";
import type {
  CloneProjectInput,
  CreateProjectInput,
  ProjectActionInput,
  ProjectMutation,
  ProjectsSnapshot,
} from "../shared/projects";
import {
  isControlTabId,
  isTabKind,
  type CreateTabInput,
  type SessionTabsEnvelope,
} from "../shared/session-ipc";
import { isOfficeSetupStepId } from "../shared/office-setup";
import type { IntegrationsState } from "../shared/integrations";
import type { OfficeDocumentsView } from "../shared/office-documents";
import { isTrustAnswer } from "../shared/projects";
import type { OfficeStopResult } from "../shared/office-bridge";
import {
  parseCloneProjectInput,
  parseCreateProjectInput,
  parseProjectActionInput,
  parseProjectMutation,
} from "./projects-service";
import type { OfficeSetupService } from "./office/setup-service";

/**
 * The Electron glue for the allowlisted IPC surface.
 *
 * All validation lives here: the renderer may only ask for channels listed in
 * `src/shared/ipc.ts`, only pass a known wizard step id or a live tab id, only
 * reveal paths that exist, only set a bounded window title, and only call a host
 * method that `isHostMethod` accepts. The services behind these handlers stay
 * Electron-free.
 */

/** The session surface the IPC layer drives (the service in main wires this up). */
export interface IpcSessionDeps {
  /** Tab ids that currently exist; used to reject stale renderer state. */
  knownTabIds(): readonly string[];
  list(): SessionTabsEnvelope;
  create(input: CreateTabInput): Promise<SessionTabsEnvelope>;
  close(tabId: string): Promise<SessionTabsEnvelope>;
  closeOthers(tabId: string): Promise<SessionTabsEnvelope>;
  reorder(tabId: string, toIndex: number): Promise<SessionTabsEnvelope>;
  /** Makes one tab the single Office host (plan step 20). */
  promoteOfficeHost(tabId: string): Promise<SessionTabsEnvelope>;
  activate(tabId: string): Promise<SessionTabsEnvelope>;
  restore(): Promise<SessionTabsEnvelope>;
  request(input: { tabId: string; method: HostMethod; params?: unknown }): Promise<unknown>;
  /**
   * Deletes a session file to the OS trash (plan step 11). The session service's
   * control host validates the path first; `src/main/index.ts` wires the real
   * implementation (this layer only validates the argument shape).
   */
  deleteSession(sessionFile: string): Promise<SessionDeleteResult>;
}

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
  sessions: IpcSessionDeps;
  /** Projects and workspace management (plan step 10). */
  projects: {
    get(): Promise<ProjectsSnapshot>;
    mutate(input: ProjectMutation): Promise<ProjectsSnapshot>;
    create(input: CreateProjectInput): Promise<ProjectOpResponse>;
    clone(input: CloneProjectInput): Promise<ProjectOpResponse>;
    action(input: ProjectActionInput): Promise<boolean>;
  };
  officeSetup: OfficeSetupService;
  /** The app's integration record (plan step 19). */
  integrations: {
    get(): Promise<IntegrationsState>;
    recordOffice(patch: unknown): Promise<IntegrationsState>;
  };
  /**
   * The Office run the app can stop. Idle (no Office session, or nothing in
   * flight) until the app owns one — the wizard's health probe is unaffected.
   */
  officeRun: { stop: () => Promise<OfficeStopResult> };
  /** Live Office pane registry (plan step 20), pushed from main's poll. */
  officeDocuments: {
    get(): OfficeDocumentsView;
    refresh(): Promise<OfficeDocumentsView>;
  };
}

const MAX_TITLE_LENGTH = 200;

/** Pushes a main → renderer event to every live window. */
export function broadcastToWindows(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Rejects a tab id that is missing, malformed, or no longer open. The control
 * host is a valid address for `session.request` only (plan D-A3) — it is never
 * a tab, so activation/close still require a live tab.
 */
function requireTabId(deps: IpcDependencies, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("session: a tab id is required");
  }
  if (isControlTabId(value)) return value;
  if (!deps.sessions.knownTabIds().includes(value)) {
    throw new Error(`session: unknown tab ${value}`);
  }
  return value;
}

/** Validates a `session.request` envelope: a live tab and a real host method. */
function parseSessionRequest(
  deps: IpcDependencies,
  value: unknown,
): { tabId: string; method: HostMethod; params?: unknown } {
  const record = asRecord(value);
  const tabId = requireTabId(deps, record.tabId);
  const method = record.method;
  if (!isHostMethod(method)) {
    throw new Error(`session: unsupported host method ${String(method)}`);
  }
  return "params" in record ? { tabId, method, params: record.params } : { tabId, method };
}

/** Validates the create-tab input; unknown fields are dropped, not forwarded. */
function parseCreateTab(value: unknown): CreateTabInput {
  const record = asRecord(value);
  const cwd = record.cwd;
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error("session: a project folder (cwd) is required");
  }
  const kind = record.kind;
  if (kind !== undefined && !isTabKind(kind)) {
    throw new Error(`session: unsupported tab kind ${String(kind)}`);
  }
  const input: CreateTabInput = { cwd };
  if (isTabKind(kind)) input.kind = kind;
  if (typeof record.sessionFile === "string" && record.sessionFile.length > 0) {
    input.sessionFile = record.sessionFile;
  }
  if (typeof record.model === "string" && record.model.length > 0) input.model = record.model;
  if (typeof record.thinking === "string" && record.thinking.length > 0) {
    input.thinking = record.thinking;
  }
  if (record.trust !== undefined) {
    if (!isTrustAnswer(record.trust)) throw new Error("session: invalid trust answer");
    input.trust = record.trust;
  }
  return input;
}

export function registerIpcHandlers(deps: IpcDependencies): void {
  ipcMain.handle(IPC.appInfo, () => deps.appInfo());
  ipcMain.handle(IPC.openExternal, (_event, url: unknown) => deps.openExternal(url));
  ipcMain.handle(IPC.appPickDirectory, () => deps.pickDirectory());
  ipcMain.handle(IPC.appRevealPath, (_event, target: unknown) => deps.revealPath(target));
  ipcMain.handle(IPC.appSetTitle, (_event, title: unknown) => deps.setTitle(title));
  ipcMain.handle(IPC.prefsGet, () => deps.prefs.get());
  ipcMain.handle(IPC.prefsSet, (_event, patch: unknown) => deps.prefs.set(patch));

  ipcMain.handle(IPC.sessionTabs, () => deps.sessions.list());
  ipcMain.handle(IPC.sessionRestore, () => deps.sessions.restore());
  ipcMain.handle(IPC.sessionCreate, (_event, input: unknown) =>
    deps.sessions.create(parseCreateTab(input)),
  );
  ipcMain.handle(IPC.sessionClose, (_event, tabId: unknown) =>
    deps.sessions.close(requireTabId(deps, tabId)),
  );
  ipcMain.handle(IPC.sessionCloseOthers, (_event, tabId: unknown) =>
    deps.sessions.closeOthers(requireTabId(deps, tabId)),
  );
  ipcMain.handle(IPC.sessionReorder, (_event, tabId: unknown, toIndex: unknown) => {
    const id = requireTabId(deps, tabId);
    if (typeof toIndex !== "number" || !Number.isFinite(toIndex)) {
      throw new Error("session: a numeric tab index is required");
    }
    return deps.sessions.reorder(id, Math.floor(toIndex));
  });
  ipcMain.handle(IPC.sessionPromoteOffice, (_event, tabId: unknown) =>
    deps.sessions.promoteOfficeHost(requireTabId(deps, tabId)),
  );
  ipcMain.handle(IPC.sessionActivate, (_event, tabId: unknown) =>
    deps.sessions.activate(requireTabId(deps, tabId)),
  );
  ipcMain.handle(IPC.sessionRequest, (_event, input: unknown) =>
    deps.sessions.request(parseSessionRequest(deps, input)),
  );
  ipcMain.handle(IPC.sessionDelete, (_event, sessionFile: unknown) => {
    if (typeof sessionFile !== "string" || sessionFile.length === 0) {
      return { ok: false, error: "session: a session file is required" } as SessionDeleteResult;
    }
    return deps.sessions.deleteSession(sessionFile);
  });

  ipcMain.handle(IPC.projectsGet, () => deps.projects.get());
  ipcMain.handle(IPC.projectsMutate, (_event, input: unknown) =>
    deps.projects.mutate(parseProjectMutation(input)),
  );
  ipcMain.handle(IPC.projectsCreate, (_event, input: unknown) =>
    deps.projects.create(parseCreateProjectInput(input)),
  );
  ipcMain.handle(IPC.projectsClone, (_event, input: unknown) =>
    deps.projects.clone(parseCloneProjectInput(input)),
  );
  ipcMain.handle(IPC.projectsAction, (_event, input: unknown) =>
    deps.projects.action(parseProjectActionInput(input)),
  );

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
  ipcMain.handle(IPC.officeDocuments, () => deps.officeDocuments.get());
  ipcMain.handle(IPC.officeDocumentsRefresh, () => deps.officeDocuments.refresh());
  // Same implementation as `app:reveal-path` — one path-validation rule.
  ipcMain.handle(IPC.officeReveal, (_event, target: unknown) => deps.revealPath(target));

  ipcMain.handle(IPC.integrationsGet, () => deps.integrations.get());
  ipcMain.handle(IPC.integrationsRecordOffice, (_event, patch: unknown) =>
    deps.integrations.recordOffice(patch),
  );
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
