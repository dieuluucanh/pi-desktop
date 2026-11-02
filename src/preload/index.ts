import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  IPC,
  type AppInfo,
  type DiagnosticsBridge,
  type IntegrationsBridge,
  type MenuCommand,
  type OfficeBridge,
  type PiDesktopBridge,
  type PrefsBridge,
  type ProjectOpResponse,
  type ProjectsBridge,
  type SessionDeleteResult,
  type DiagnosticsSaveResult,
  type SessionsBridge,
  type UpdatesBridge,
  type WebBridge,
  type GitBridge,
  type CheckpointsBridge,
  type WorkspaceBridge,
  type WebTabOpenInput,
  type WindowState,
} from "../shared/ipc";
import type { UiPrefs } from "../shared/prefs";
import type { IntegrationsState, OfficeIntegrationRecordPatch } from "../shared/integrations";
import type {
  CloneProjectInput,
  CreateProjectInput,
  ProjectActionInput,
  ProjectMutation,
  ProjectSettingsToggleInput,
  ProjectSettingsToggleResult,
  ProjectsSnapshot,
} from "../shared/projects";
import type {
  CreateTabInput,
  SessionEventEnvelope,
  SessionRequestInput,
  SessionStateEnvelope,
  SessionTabsEnvelope,
} from "../shared/session-ipc";
import type { OfficeSetupStepId, OfficeSetupView } from "../shared/office-setup";
import type { OfficeBridgeControlResult, OfficeStopResult } from "../shared/office-bridge";
import type { OfficeDocumentsView } from "../shared/office-documents";
import type { DiagnosticsExport, DiagnosticsSnapshot } from "../shared/diagnostics";
import type { UpdateState } from "../shared/updates";
import type {
  EditorBackup,
  ResolvedEditorConfig,
  WorkspaceFileContent,
  WorkspaceFileList,
  WorkspaceListing,
  WorkspaceResult,
  WorkspaceSearchRequest,
  WorkspaceSearchResult,
  WorkspaceStat,
  WorkspaceWriteInput,
  WorkspaceWriteResult,
  WorkspaceFormatRequest,
  WorkspaceFormatResult,
} from "../shared/workspace";
import type {
  WebCommand,
  WebNavigationDecision,
  WebNavigationRequest,
  WebTabBounds,
  WebTabState,
} from "../shared/web-tabs";
import type {
  GitAction,
  GitActionResult,
  GitCommitEntry,
  GitDiff,
  GitDiffRequest,
  GitLogRequest,
  GitSnapshot,
} from "../shared/git";
import type {
  CheckpointAction,
  CheckpointActionResult,
  CheckpointState,
} from "../shared/checkpoints";

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

const sessions: SessionsBridge = {
  list: () => ipcRenderer.invoke(IPC.sessionTabs) as Promise<SessionTabsEnvelope>,
  create: (input: CreateTabInput) =>
    ipcRenderer.invoke(IPC.sessionCreate, input) as Promise<SessionTabsEnvelope>,
  close: (tabId: string) =>
    ipcRenderer.invoke(IPC.sessionClose, tabId) as Promise<SessionTabsEnvelope>,
  closeOthers: (tabId: string) =>
    ipcRenderer.invoke(IPC.sessionCloseOthers, tabId) as Promise<SessionTabsEnvelope>,
  reorder: (tabId: string, toIndex: number) =>
    ipcRenderer.invoke(IPC.sessionReorder, tabId, toIndex) as Promise<SessionTabsEnvelope>,
  promoteOfficeHost: (tabId: string) =>
    ipcRenderer.invoke(IPC.sessionPromoteOffice, tabId) as Promise<SessionTabsEnvelope>,
  activate: (tabId: string) =>
    ipcRenderer.invoke(IPC.sessionActivate, tabId) as Promise<SessionTabsEnvelope>,
  deactivate: () => ipcRenderer.invoke(IPC.sessionDeactivate) as Promise<SessionTabsEnvelope>,
  reconcile: () => ipcRenderer.invoke(IPC.sessionReconcile) as Promise<SessionTabsEnvelope>,
  restore: () => ipcRenderer.invoke(IPC.sessionRestore) as Promise<SessionTabsEnvelope>,
  restart: (tabId: string) =>
    ipcRenderer.invoke(IPC.sessionRestart, tabId) as Promise<SessionTabsEnvelope>,
  request: (input: SessionRequestInput) =>
    ipcRenderer.invoke(IPC.sessionRequest, input) as Promise<unknown>,
  deleteSession: (sessionFile: string) =>
    ipcRenderer.invoke(IPC.sessionDelete, sessionFile) as Promise<SessionDeleteResult>,
  onEvent: (listener: (envelope: SessionEventEnvelope) => void) =>
    subscribe<SessionEventEnvelope>(IPC.sessionEvent, listener),
  onState: (listener: (envelope: SessionStateEnvelope) => void) =>
    subscribe<SessionStateEnvelope>(IPC.sessionState, listener),
  onTabs: (listener: (envelope: SessionTabsEnvelope) => void) =>
    subscribe<SessionTabsEnvelope>(IPC.sessionTabsChanged, listener),
};

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
  documents: () => ipcRenderer.invoke(IPC.officeDocuments) as Promise<OfficeDocumentsView>,
  refreshDocuments: () =>
    ipcRenderer.invoke(IPC.officeDocumentsRefresh) as Promise<OfficeDocumentsView>,
  onDocuments: (listener: (view: OfficeDocumentsView) => void) =>
    subscribe<OfficeDocumentsView>(IPC.officeDocumentsState, listener),
  connectBridge: (tabId: string, options?: { takeover?: boolean }) =>
    ipcRenderer.invoke(IPC.officeBridgeConnect, {
      tabId,
      ...options,
    }) as Promise<OfficeBridgeControlResult>,
  closeBridge: (tabId: string) =>
    ipcRenderer.invoke(IPC.officeBridgeClose, tabId) as Promise<OfficeBridgeControlResult>,
  restartBridge: (tabId: string, options?: { takeover?: boolean }) =>
    ipcRenderer.invoke(IPC.officeBridgeRestart, {
      tabId,
      ...options,
    }) as Promise<OfficeBridgeControlResult>,
};

const prefs: PrefsBridge = {
  get: () => ipcRenderer.invoke(IPC.prefsGet) as Promise<UiPrefs>,
  set: (patch: Partial<UiPrefs>) => ipcRenderer.invoke(IPC.prefsSet, patch) as Promise<UiPrefs>,
};

const integrations: IntegrationsBridge = {
  get: () => ipcRenderer.invoke(IPC.integrationsGet) as Promise<IntegrationsState>,
  recordOffice: (patch: OfficeIntegrationRecordPatch) =>
    ipcRenderer.invoke(IPC.integrationsRecordOffice, patch) as Promise<IntegrationsState>,
};

const projects: ProjectsBridge = {
  get: () => ipcRenderer.invoke(IPC.projectsGet) as Promise<ProjectsSnapshot>,
  mutate: (input: ProjectMutation) =>
    ipcRenderer.invoke(IPC.projectsMutate, input) as Promise<ProjectsSnapshot>,
  create: (input: CreateProjectInput) =>
    ipcRenderer.invoke(IPC.projectsCreate, input) as Promise<ProjectOpResponse>,
  clone: (input: CloneProjectInput) =>
    ipcRenderer.invoke(IPC.projectsClone, input) as Promise<ProjectOpResponse>,
  action: (input: ProjectActionInput) =>
    ipcRenderer.invoke(IPC.projectsAction, input) as Promise<boolean>,
  setSettings: (input: ProjectSettingsToggleInput) =>
    ipcRenderer.invoke(IPC.projectsSetSettings, input) as Promise<ProjectSettingsToggleResult>,
};

const web: WebBridge = {
  open: (input: WebTabOpenInput) =>
    ipcRenderer.invoke(IPC.webOpen, input) as Promise<SessionTabsEnvelope>,
  setBounds: (tabId: string, bounds: WebTabBounds) =>
    ipcRenderer.invoke(IPC.webSetBounds, tabId, bounds) as Promise<boolean>,
  command: (tabId: string, command: WebCommand) =>
    ipcRenderer.invoke(IPC.webCommand, tabId, command) as Promise<boolean>,
  decideNavigation: (decision: WebNavigationDecision) =>
    ipcRenderer.invoke(IPC.webNavigationDecision, decision) as Promise<boolean>,
  onState: (listener: (state: WebTabState) => void) =>
    subscribe<WebTabState>(IPC.webState, listener),
  onNavigationRequest: (listener: (request: WebNavigationRequest) => void) =>
    subscribe<WebNavigationRequest>(IPC.webNavigationRequest, listener),
};

const diagnostics: DiagnosticsBridge = {
  get: () => ipcRenderer.invoke(IPC.diagnosticsGet) as Promise<DiagnosticsSnapshot>,
  export: () => ipcRenderer.invoke(IPC.diagnosticsExport) as Promise<DiagnosticsExport>,
  save: () => ipcRenderer.invoke(IPC.diagnosticsSave) as Promise<DiagnosticsSaveResult>,
  record: (incident) => ipcRenderer.invoke(IPC.diagnosticsRecord, incident) as Promise<boolean>,
};

const updates: UpdatesBridge = {
  get: () => ipcRenderer.invoke(IPC.updatesGet) as Promise<UpdateState>,
  check: () => ipcRenderer.invoke(IPC.updatesCheck) as Promise<UpdateState>,
  download: () => ipcRenderer.invoke(IPC.updatesDownload) as Promise<UpdateState>,
  install: () => ipcRenderer.invoke(IPC.updatesInstall) as Promise<boolean>,
  clearProblem: () => ipcRenderer.invoke(IPC.updatesClearProblem) as Promise<UpdateState>,
  onState: (listener: (state: UpdateState) => void) =>
    subscribe<UpdateState>(IPC.updatesState, listener),
};

/**
 * Source control (git-checkpoint plan step 7). The renderer never sees an argv:
 * it names a project folder and one action from the closed union, and main does
 * the rest.
 */
const git: GitBridge = {
  snapshot: (projectPath: string) =>
    ipcRenderer.invoke(IPC.gitSnapshot, projectPath) as Promise<GitSnapshot>,
  refresh: (projectPath: string) =>
    ipcRenderer.invoke(IPC.gitRefresh, projectPath) as Promise<GitSnapshot>,
  watch: (projectPath: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC.gitWatch, projectPath, enabled) as Promise<boolean>,
  action: (projectPath: string, action: GitAction) =>
    ipcRenderer.invoke(IPC.gitAction, projectPath, action) as Promise<GitActionResult>,
  diff: (projectPath: string, request: GitDiffRequest) =>
    ipcRenderer.invoke(IPC.gitDiff, projectPath, request) as Promise<GitDiff>,
  log: (projectPath: string, request?: GitLogRequest) =>
    ipcRenderer.invoke(IPC.gitLog, projectPath, request) as Promise<GitCommitEntry[]>,
  headMessage: (projectPath: string) =>
    ipcRenderer.invoke(IPC.gitHeadMessage, projectPath) as Promise<string | null>,
  branches: (projectPath: string) =>
    ipcRenderer.invoke(IPC.gitBranches, projectPath) as Promise<string[]>,
  onSnapshot: (listener: (snapshot: GitSnapshot) => void) =>
    subscribe<GitSnapshot>(IPC.gitPushed, listener),
};

/**
 * Folder checkpoints (git-checkpoint plan step 21). One hydration pair plus a
 * push, mirroring the git bridge: the renderer names a folder it has open and an
 * action from the closed union, and main does the rest.
 */
const checkpoints: CheckpointsBridge = {
  get: (projectPath: string) =>
    ipcRenderer.invoke(IPC.checkpointsGet, projectPath) as Promise<CheckpointState>,
  refresh: (projectPath: string) =>
    ipcRenderer.invoke(IPC.checkpointsRefresh, projectPath) as Promise<CheckpointState>,
  action: (projectPath: string, action: CheckpointAction) =>
    ipcRenderer.invoke(
      IPC.checkpointsAction,
      projectPath,
      action,
    ) as Promise<CheckpointActionResult>,
  onState: (listener: (state: CheckpointState) => void) =>
    subscribe<CheckpointState>(IPC.checkpointsPushed, listener),
};

/** Workspace file access for the explorer and editor. */
const workspace: WorkspaceBridge = {
  listDirectory: (input) =>
    ipcRenderer.invoke(IPC.workspaceListDirectory, input) as Promise<
      WorkspaceResult<WorkspaceListing>
    >,
  listFiles: (input) =>
    ipcRenderer.invoke(IPC.workspaceListFiles, input) as Promise<
      WorkspaceResult<WorkspaceFileList>
    >,
  searchFiles: (input: WorkspaceSearchRequest) =>
    ipcRenderer.invoke(IPC.workspaceSearchFiles, input) as Promise<
      WorkspaceResult<WorkspaceSearchResult>
    >,
  readFile: (input) =>
    ipcRenderer.invoke(IPC.workspaceReadFile, input) as Promise<
      WorkspaceResult<WorkspaceFileContent>
    >,
  stat: (input) =>
    ipcRenderer.invoke(IPC.workspaceStat, input) as Promise<WorkspaceResult<WorkspaceStat>>,
  writeFile: (input: WorkspaceWriteInput) =>
    ipcRenderer.invoke(IPC.workspaceWriteFile, input) as Promise<
      WorkspaceResult<WorkspaceWriteResult>
    >,
  reveal: (input) =>
    ipcRenderer.invoke(IPC.workspaceReveal, input) as Promise<WorkspaceResult<boolean>>,
  editorConfig: (input) =>
    ipcRenderer.invoke(IPC.workspaceEditorConfig, input) as Promise<
      WorkspaceResult<ResolvedEditorConfig>
    >,
  readBackup: (tabId: string) =>
    ipcRenderer.invoke(IPC.workspaceReadBackup, tabId) as Promise<
      WorkspaceResult<EditorBackup | null>
    >,
  writeBackup: (backup: EditorBackup) =>
    ipcRenderer.invoke(IPC.workspaceWriteBackup, backup) as Promise<WorkspaceResult<boolean>>,
  deleteBackup: (tabId: string) =>
    ipcRenderer.invoke(IPC.workspaceDeleteBackup, tabId) as Promise<WorkspaceResult<boolean>>,
  format: (request: WorkspaceFormatRequest) =>
    ipcRenderer.invoke(IPC.workspaceFormat, request) as Promise<
      WorkspaceResult<WorkspaceFormatResult>
    >,
};

const bridge: PiDesktopBridge = {
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo) as Promise<AppInfo>,
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url) as Promise<boolean>,
  pickDirectory: () => ipcRenderer.invoke(IPC.appPickDirectory) as Promise<string | null>,
  pickFile: (options?: { title?: string; extensions?: string[] }) =>
    ipcRenderer.invoke(IPC.appPickFile, options) as Promise<string | null>,
  share: {
    session: (sessionFile: string) =>
      ipcRenderer.invoke(IPC.shareSession, sessionFile) as Promise<{
        ok: boolean;
        gistUrl?: string;
        viewerUrl?: string;
        file?: string;
        error?: string;
        detail?: string;
      }>,
    bugReport: (input: {
      sessionFile?: string | null;
      includeTranscript: boolean;
      hint?: string | null;
      versions: Record<string, string | null | undefined>;
      diagnostics?: unknown;
    }) =>
      ipcRenderer.invoke(IPC.shareBugReport, input) as Promise<{
        ok: boolean;
        path?: string;
        bytes?: number;
        error?: string;
      }>,
    editor: (draft: string, setting?: string | null) =>
      ipcRenderer.invoke(IPC.editorOpen, draft, setting) as Promise<{
        ok: boolean;
        text?: string;
        error?: string;
        source?: string | null;
      }>,
  },
  revealPath: (path: string) => ipcRenderer.invoke(IPC.appRevealPath, path) as Promise<boolean>,
  setTitle: (title: string) => ipcRenderer.invoke(IPC.appSetTitle, title) as Promise<boolean>,
  relaunch: () => ipcRenderer.invoke(IPC.appRelaunch) as Promise<boolean>,
  onWindowState: (listener: (state: WindowState) => void) =>
    subscribe<WindowState>(IPC.windowState, listener),
  onMenuCommand: (listener: (command: MenuCommand) => void) =>
    subscribe<MenuCommand>(IPC.appMenuCommand, listener),
  prefs,
  sessions,
  projects,
  office,
  integrations,
  web,
  diagnostics,
  updates,
  git,
  checkpoints,
  workspace,
};

contextBridge.exposeInMainWorld("pi", bridge);
