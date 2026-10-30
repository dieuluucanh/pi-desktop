import { BrowserWindow, ipcMain, shell } from "electron";
import { isHostMethod, type HostMethod } from "../shared/host-protocol";
import { IPC, type AppInfo, type ProjectOpResponse, type SessionDeleteResult } from "../shared/ipc";
import type { UiPrefs } from "../shared/prefs";
import type {
  CloneProjectInput,
  CreateProjectInput,
  ProjectActionInput,
  ProjectMutation,
  ProjectSettingsToggleInput,
  ProjectSettingsToggleResult,
  ProjectsSnapshot,
} from "../shared/projects";
import {
  isControlTabId,
  isTabKind,
  type CreateTabInput,
  type SessionTabsEnvelope,
} from "../shared/session-ipc";
import { isOfficeSetupStepId } from "../shared/office-setup";
import {
  parseWebCommand,
  sanitizeWebNavigationDecision,
  sanitizeWebTabBounds,
  sanitizeWebUrl,
  type WebCommand,
  type WebNavigationDecision,
  type WebTabBounds,
} from "../shared/web-tabs";
import type { WebTabOpenInput } from "../shared/ipc";
import type { IntegrationsState } from "../shared/integrations";
import type { OfficeDocumentsView } from "../shared/office-documents";
import {
  parseReportedIncident,
  type DiagnosticsExport,
  type DiagnosticsSnapshot,
} from "../shared/diagnostics";
import type { DiagnosticsSaveResult } from "../shared/ipc";
import type { UpdateState } from "../shared/updates";
import { isTrustAnswer } from "../shared/projects";
import type { OfficeStopResult } from "../shared/office-bridge";
import {
  parseGitAction,
  parseGitDiffRequest,
  parseGitLogRequest,
  type GitAction,
  type GitActionResult,
  type GitCommitEntry,
  type GitDiff,
  type GitDiffRequest,
  type GitLogRequest,
  type GitSnapshot,
} from "../shared/git";
import {
  parseCloneProjectInput,
  parseCreateProjectInput,
  parseProjectActionInput,
  parseProjectMutation,
} from "./projects-service";
import type { OfficeSetupService } from "./office/setup-service";
import {
  parseCheckpointAction,
  type CheckpointAction,
  type CheckpointActionResult,
  type CheckpointState,
} from "../shared/checkpoints";

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
  /** Clears the active tab without closing or stopping any host. */
  deactivate(): Promise<SessionTabsEnvelope>;
  /** Re-checks host/session readiness after suspend or a missed push. */
  reconcile(): Promise<SessionTabsEnvelope>;
  restore(): Promise<SessionTabsEnvelope>;
  /** Stops and re-spawns a tab's host, resuming its session (plan step 22). */
  restart(tabId: string): Promise<SessionTabsEnvelope>;
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
  /** Native file picker (JSONL import); null when the user cancels. */
  pickFile: (options?: { title?: string; extensions?: string[] }) => Promise<string | null>;
  /** `/share`: upload a session JSONL as a secret gist. */
  shareSession: (sessionFile: unknown) => Promise<unknown>;
  /** `/bug`: build the local zip. */
  shareBugReport: (input: unknown) => Promise<unknown>;
  /** Open the draft in the OS editor (plan step 21). */
  openEditor: (draft: unknown, setting: unknown) => Promise<unknown>;
  /** Reveals a path in the OS file manager; returns false for invalid input. */
  revealPath: (target: unknown) => boolean;
  /** Sets the window title (bounded, sanitized here). */
  setTitle: (title: unknown) => boolean;
  /** Relaunches the app; a profile-mode change needs a restart (plan step 26). */
  relaunch: () => boolean;
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
    setSettings(input: ProjectSettingsToggleInput): Promise<ProjectSettingsToggleResult>;
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
  /** Web tabs (plan step 21): the isolated page views behind `web` tabs. */
  web: {
    open(input: WebTabOpenInput): Promise<SessionTabsEnvelope>;
    setBounds(tabId: string, bounds: WebTabBounds): boolean;
    command(tabId: string, command: WebCommand): boolean;
    decideNavigation(decision: WebNavigationDecision): Promise<boolean> | boolean;
  };
  /** Diagnostics (plan step 22): snapshot, redacted export and a file save. */
  diagnostics: {
    get(): DiagnosticsSnapshot;
    export(): Promise<DiagnosticsExport>;
    save(): Promise<DiagnosticsSaveResult>;
    record(value: unknown): boolean;
  };
  /** Updates (plan step 26): check GitHub Releases, download and install. */
  updates: {
    get(): UpdateState;
    check(): Promise<UpdateState>;
    download(): Promise<UpdateState>;
    install(): boolean;
  };
  /** Source control (git-checkpoint plan step 7). */
  git: {
    /**
     * Resolves a renderer-supplied folder to one the app has open (a tab's cwd
     * or a remembered project), or throws. The allowlist lives where the data
     * does; the handlers never hold the project list themselves.
     */
    resolveProjectPath(value: unknown): Promise<string>;
    snapshot(projectPath: string): Promise<GitSnapshot>;
    refresh(projectPath: string): Promise<GitSnapshot>;
    watch(projectPath: string, enabled: boolean): boolean;
    action(projectPath: string, action: GitAction): Promise<GitActionResult>;
    diff(projectPath: string, request: GitDiffRequest): Promise<GitDiff>;
    log(projectPath: string, request: GitLogRequest): Promise<GitCommitEntry[]>;
    headMessage(projectPath: string): Promise<string | null>;
    branches(projectPath: string): Promise<string[]>;
  };
  /** Folder checkpoints (git-checkpoint plan step 21). */
  checkpoints: {
    /** Same allowlist as `git.resolveProjectPath`: a folder the app has open. */
    resolveProjectPath(value: unknown): Promise<string>;
    get(projectPath: string): Promise<CheckpointState>;
    refresh(projectPath: string): Promise<CheckpointState>;
    action(projectPath: string, action: CheckpointAction): Promise<CheckpointActionResult>;
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

/** Rejects the control host: a web tab is always a real, live tab. */
function requireRealTabId(deps: IpcDependencies, value: unknown): string {
  const id = requireTabId(deps, value);
  if (isControlTabId(id)) throw new Error("web: the control host is not a tab");
  return id;
}

/** Validates the project-panel settings toggle input. */
function parseProjectSettingsToggle(value: unknown): ProjectSettingsToggleInput {
  const record = asRecord(value);
  const path = typeof record.path === "string" ? record.path.trim() : "";
  if (path.length === 0) throw new Error("projects: path is required");
  if (typeof record.enabled !== "boolean") {
    throw new Error("projects: enabled must be a boolean");
  }
  return { path, enabled: record.enabled };
}

/** Validates the `web:open` input: a permitted URL, an optional folder and link. */
function parseWebOpen(value: unknown): WebTabOpenInput {
  const record = asRecord(value);
  const url = sanitizeWebUrl(record.url);
  if (!url) throw new Error("web: a permitted http(s) URL is required");
  const input: WebTabOpenInput = { url };
  if (typeof record.cwd === "string" && record.cwd.length > 0) input.cwd = record.cwd;
  if (typeof record.sessionTabId === "string" && record.sessionTabId.length > 0) {
    input.sessionTabId = record.sessionTabId;
  }
  return input;
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
  ipcMain.handle(IPC.appPickFile, (_event, options: unknown) =>
    deps.pickFile(
      options && typeof options === "object"
        ? (options as { title?: string; extensions?: string[] })
        : undefined,
    ),
  );
  ipcMain.handle(IPC.shareSession, (_event, sessionFile: unknown) =>
    deps.shareSession(sessionFile),
  );
  ipcMain.handle(IPC.shareBugReport, (_event, input: unknown) => deps.shareBugReport(input));
  ipcMain.handle(IPC.editorOpen, (_event, draft: unknown, setting: unknown) =>
    deps.openEditor(draft, setting),
  );
  ipcMain.handle(IPC.appRevealPath, (_event, target: unknown) => deps.revealPath(target));
  ipcMain.handle(IPC.appSetTitle, (_event, title: unknown) => deps.setTitle(title));
  ipcMain.handle(IPC.appRelaunch, () => deps.relaunch());
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
  ipcMain.handle(IPC.sessionDeactivate, () => deps.sessions.deactivate());
  ipcMain.handle(IPC.sessionReconcile, () => deps.sessions.reconcile());
  ipcMain.handle(IPC.sessionRestart, (_event, tabId: unknown) =>
    deps.sessions.restart(requireTabId(deps, tabId)),
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
  ipcMain.handle(IPC.projectsSetSettings, (_event, input: unknown) =>
    deps.projects.setSettings(parseProjectSettingsToggle(input)),
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

  ipcMain.handle(IPC.webOpen, (_event, input: unknown) => deps.web.open(parseWebOpen(input)));
  ipcMain.handle(IPC.webSetBounds, (_event, tabId: unknown, bounds: unknown) => {
    const id = requireRealTabId(deps, tabId);
    const parsed = sanitizeWebTabBounds(bounds);
    if (!parsed) throw new Error("web: a bounds rectangle is required");
    return deps.web.setBounds(id, parsed);
  });
  ipcMain.handle(IPC.webCommand, (_event, tabId: unknown, command: unknown) => {
    const id = requireRealTabId(deps, tabId);
    const parsed = parseWebCommand(command);
    if (!parsed) throw new Error("web: unsupported web command");
    return deps.web.command(id, parsed);
  });
  ipcMain.handle(IPC.webNavigationDecision, (_event, decision: unknown) => {
    const parsed = sanitizeWebNavigationDecision(decision);
    if (!parsed) throw new Error("web: invalid navigation decision");
    return deps.web.decideNavigation(parsed);
  });

  ipcMain.handle(IPC.diagnosticsGet, () => deps.diagnostics.get());
  ipcMain.handle(IPC.diagnosticsExport, () => deps.diagnostics.export());
  ipcMain.handle(IPC.diagnosticsSave, () => deps.diagnostics.save());
  ipcMain.handle(IPC.diagnosticsRecord, (_event, value: unknown) => {
    // Validation lives here: an unknown/malformed report is dropped, not stored.
    if (!parseReportedIncident(value)) return false;
    return deps.diagnostics.record(value);
  });

  ipcMain.handle(IPC.updatesGet, () => deps.updates.get());
  ipcMain.handle(IPC.updatesCheck, () => deps.updates.check());
  ipcMain.handle(IPC.updatesDownload, () => deps.updates.download());
  ipcMain.handle(IPC.updatesInstall, () => deps.updates.install());

  // Source control (git-checkpoint plan step 7). Every handler resolves the
  // folder against the allowlist first, so git only ever runs in a folder the
  // user opened; the action payload is then parsed against the closed union.
  ipcMain.handle(IPC.gitSnapshot, async (_event, projectPath: unknown) =>
    deps.git.snapshot(await deps.git.resolveProjectPath(projectPath)),
  );
  ipcMain.handle(IPC.gitRefresh, async (_event, projectPath: unknown) =>
    deps.git.refresh(await deps.git.resolveProjectPath(projectPath)),
  );
  ipcMain.handle(IPC.gitWatch, async (_event, projectPath: unknown, enabled: unknown) => {
    const path = await deps.git.resolveProjectPath(projectPath);
    if (typeof enabled !== "boolean") throw new Error("git: enabled must be a boolean");
    return deps.git.watch(path, enabled);
  });
  ipcMain.handle(IPC.gitAction, async (_event, projectPath: unknown, action: unknown) => {
    const path = await deps.git.resolveProjectPath(projectPath);
    const parsed = parseGitAction(action);
    if (!parsed) throw new Error("git: unsupported action");
    return deps.git.action(path, parsed);
  });
  ipcMain.handle(IPC.gitDiff, async (_event, projectPath: unknown, request: unknown) =>
    deps.git.diff(await deps.git.resolveProjectPath(projectPath), parseGitDiffRequest(request)),
  );
  ipcMain.handle(IPC.gitLog, async (_event, projectPath: unknown, request: unknown) =>
    deps.git.log(await deps.git.resolveProjectPath(projectPath), parseGitLogRequest(request)),
  );
  ipcMain.handle(IPC.gitHeadMessage, async (_event, projectPath: unknown) =>
    deps.git.headMessage(await deps.git.resolveProjectPath(projectPath)),
  );
  ipcMain.handle(IPC.gitBranches, async (_event, projectPath: unknown) =>
    deps.git.branches(await deps.git.resolveProjectPath(projectPath)),
  );

  // Folder checkpoints (git-checkpoint plan step 21). Same two rules as git: the
  // folder must be one the app has open, and the action must parse against the
  // closed union before the store sees it. `restore` is the one action that can
  // overwrite work, so it re-validates its ref here as well.
  ipcMain.handle(IPC.checkpointsGet, async (_event, projectPath: unknown) =>
    deps.checkpoints.get(await deps.checkpoints.resolveProjectPath(projectPath)),
  );
  ipcMain.handle(IPC.checkpointsRefresh, async (_event, projectPath: unknown) =>
    deps.checkpoints.refresh(await deps.checkpoints.resolveProjectPath(projectPath)),
  );
  ipcMain.handle(IPC.checkpointsAction, async (_event, projectPath: unknown, action: unknown) => {
    const path = await deps.checkpoints.resolveProjectPath(projectPath);
    const parsed = parseCheckpointAction(action);
    if (!parsed) throw new Error("checkpoints: unsupported action");
    return deps.checkpoints.action(path, parsed);
  });
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
