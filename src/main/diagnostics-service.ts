import type { AppInfo } from "../shared/ipc";
import {
  appendIncident,
  createIncident,
  DEFAULT_INCIDENT_LIMIT,
  DIAGNOSTIC_ENV_KEYS,
  isOfflineEnv,
  parseReportedIncident,
  type DiagnosticsCheckpointInfo,
  type DiagnosticsExport,
  type DiagnosticsExtensionError,
  type DiagnosticsGitInfo,
  type DiagnosticsHostInfo,
  type DiagnosticsOfficeInfo,
  type DiagnosticsSnapshot,
  type Incident,
  type IncidentKind,
} from "../shared/diagnostics";
import { redactSecrets } from "./office/troubleshoot";
import {
  DEFAULT_LIVE_HOSTS,
  HOST_RSS_BUDGET_BYTES,
  HOST_RSS_RESTART_BYTES,
  hostProcessCeiling,
  type SessionCapacity,
  type StartupReport,
} from "../shared/performance";

/**
 * The app-wide diagnostics service (plan step 22).
 *
 * It gathers what already exists — the running process's app/runtime info, the
 * profile paths, the live hosts and their logs, the incidents the session
 * service and this process recorded, extension errors, and the Office bridge's
 * last probe — into one snapshot, and renders a support bundle through the same
 * `redactSecrets` the Office wizard uses. It is Electron-free (no dialog, no
 * shell): main supplies the file-save step. That keeps the bundle testable and
 * guarantees the "greps clean of credentials" acceptance row is a unit test.
 */

/** The live session/host data the service reads (the session service, in main). */
export interface DiagnosticsSessionProvider {
  hosts(): DiagnosticsHostInfo[];
  incidents(): Incident[];
  extensionErrors(): DiagnosticsExtensionError[];
  /** Soft live-host budget readout (plan step 24). Optional for test doubles. */
  capacity?(): SessionCapacity;
}

export interface DiagnosticsServiceDeps {
  appInfo: () => AppInfo;
  sessions: DiagnosticsSessionProvider | null;
  /** The Office bridge's last probe, flattened for the view. */
  office: () => DiagnosticsOfficeInfo;
  /** The Office wizard's own (already redacted) bundle text. */
  officeBundle: () => Promise<string>;
  /** The startup-budget measurements so far (plan step 24). */
  startup: () => StartupReport;
  /**
   * Source control, as the rail's engine sees it (git-checkpoint plan step 28).
   * Optional so every existing test double keeps working: a service without the
   * port reports "not read" rather than inventing facts.
   */
  git?: () => DiagnosticsGitInfo;
  /** Folder checkpoints (git-checkpoint plan step 28). Optional for the same reason. */
  checkpoints?: () => DiagnosticsCheckpointInfo;
  /** Machine memory, when main can read it (Electron's system memory API). */
  systemMemory?: () => { totalBytes: number | null; freeBytes: number | null };
  /** Live web renderers; the tab records themselves are unlimited. */
  web?: () => { tabs: number; liveViews: number; limit: number };
  /** The environment to sample; only `DIAGNOSTIC_ENV_KEYS` are ever read. */
  env?: Record<string, string | undefined>;
  now?: () => number;
}

export interface DiagnosticsSaveResult {
  ok: boolean;
  path?: string;
  error?: string;
}

export interface DiagnosticsService {
  snapshot(): DiagnosticsSnapshot;
  /** Renders the support bundle (redacted) without writing anything. */
  exportBundle(): Promise<DiagnosticsExport>;
  /** Validates and stores a renderer-reported incident. Returns true if stored. */
  recordReported(value: unknown): boolean;
  /** Records a process-level failure (unhandled rejection, uncaught exception). */
  recordMain(kind: IncidentKind, message: string, detail?: string): Incident;
  /** Process-level incidents only (the session service keeps its own list). */
  incidents(): Incident[];
}

/** The allowlisted environment subset, empty when nothing is set. */
export function collectDiagnosticEnvironment(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of DIAGNOSTIC_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked;
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

/**
 * The bundle text (before redaction). Pure, so a test can assert on its
 * structure without touching the filesystem or Electron.
 */
export function renderDiagnosticsBundle(snapshot: DiagnosticsSnapshot, officeText: string): string {
  const lines: string[] = [];
  lines.push("Pi Desktop — diagnostics bundle");
  lines.push(`generated: ${iso(snapshot.generatedAt)}`);
  lines.push("");
  lines.push("## App");
  lines.push(`name: ${snapshot.app.name} ${snapshot.app.version}`);
  lines.push(
    `electron: ${snapshot.app.electron} · node: ${snapshot.app.node} · chrome: ${snapshot.app.chrome}`,
  );
  lines.push(
    `os: ${snapshot.app.platform} ${snapshot.app.arch}${snapshot.app.isDev ? " (development)" : ""}`,
  );
  lines.push(
    `build: ${snapshot.app.buildChannel} · v${snapshot.app.buildVersion ?? "unknown"} · ${snapshot.app.buildCommit ?? "unknown"} · ${snapshot.app.builtAt ?? "unknown"}`,
  );
  lines.push(`safe mode: ${snapshot.safeMode ? "yes" : "no"}`);
  lines.push(`pi offline: ${isOfflineEnv(snapshot.environment.PI_OFFLINE) ? "yes" : "no"}`);
  lines.push("");
  lines.push("## Runtime");
  lines.push(`source: ${snapshot.runtime.source ?? "unavailable"}`);
  lines.push(`node: ${snapshot.runtime.nodeVersion ?? "unavailable"}`);
  for (const problem of snapshot.runtime.problems) lines.push(`problem: ${problem}`);
  lines.push("");
  lines.push("## Profile");
  lines.push(`userData: ${snapshot.paths.userDataDir}`);
  lines.push(`home: ${snapshot.paths.homeDir}`);
  lines.push(`agentDir: ${snapshot.paths.profileDir}`);
  lines.push(`settings: ${snapshot.paths.settingsFile}`);
  lines.push(`auth: ${snapshot.paths.authFile}`);
  lines.push(`models: ${snapshot.paths.modelsFile}`);
  lines.push(`appState: ${snapshot.paths.appStateFile}`);
  lines.push(`logs: ${snapshot.paths.logsDir}`);
  lines.push(`blobs: ${snapshot.paths.blobCacheDir}`);
  lines.push("");
  lines.push("## Environment");
  const envKeys = Object.keys(snapshot.environment).sort();
  if (envKeys.length === 0) lines.push("(none of the allowlisted variables are set)");
  for (const key of envKeys) lines.push(`${key}=${snapshot.environment[key]}`);
  lines.push("");
  lines.push(`## Hosts (${snapshot.hosts.length})`);
  if (snapshot.hosts.length === 0) lines.push("(none)");
  for (const host of snapshot.hosts) {
    lines.push(
      `- ${host.tabId} role=${host.role} status=${host.status} pid=${host.pid ?? "?"} build=${host.buildId ?? "unknown"}${host.stale ? " (stale)" : ""} cwd=${host.cwd}`,
    );
    if (host.startedAt !== null) lines.push(`  started: ${iso(host.startedAt)}`);
    if (host.sessionFile) lines.push(`  session: ${host.sessionFile}`);
    if (host.logLines.length === 0) lines.push("  log: (empty)");
    else {
      lines.push(`  log (tail ${host.logLines.length} lines):`);
      for (const line of host.logLines.slice(-40)) lines.push(`    ${line.trimEnd()}`);
    }
  }
  lines.push("");
  lines.push(`## Incidents (${snapshot.incidents.length})`);
  if (snapshot.incidents.length === 0) lines.push("(none)");
  for (const incident of snapshot.incidents) {
    lines.push(
      `- (${incident.severity}) ${iso(incident.at)} ${incident.kind}: ${incident.message}`,
    );
    if (incident.tabId) lines.push(`  tab: ${incident.tabId}`);
    if (incident.fix) lines.push(`  fix: ${incident.fix}`);
    if (incident.detail) lines.push(`  detail: ${incident.detail.split("\n")[0]}`);
  }
  lines.push("");
  lines.push(`## Extension errors (${snapshot.extensionErrors.length})`);
  if (snapshot.extensionErrors.length === 0) lines.push("(none)");
  for (const error of snapshot.extensionErrors) {
    lines.push(`- [${error.tabId}] ${error.extensionId ?? "unknown"}: ${error.message}`);
  }
  lines.push("");
  lines.push("## Office bridge");
  lines.push(`available: ${snapshot.office.available}`);
  lines.push(`status: ${snapshot.office.status} · port: ${snapshot.office.port}`);
  lines.push(
    `protocol: ${snapshot.office.protocolVersion ?? "?"} · panes: ${snapshot.office.panes}`,
  );
  if (snapshot.office.error) lines.push(`error: ${snapshot.office.error}`);
  lines.push("");
  lines.push("## Source control");
  lines.push(`git: ${snapshot.git.version ?? "(not found on PATH)"}`);
  if (snapshot.git.repos.length === 0) lines.push("(no repository read yet)");
  for (const repo of snapshot.git.repos) {
    lines.push(
      `- ${repo.root} · ${repo.branch ?? "detached"} · ${repo.dirty ? "dirty" : "clean"}` +
        `${repo.lastStatusMs === null ? "" : ` · ${repo.lastStatusMs}ms`}`,
    );
    // Already classified before it reaches here; the raw message is what the
    // rail showed, and `redactSecrets` runs over the whole bundle afterwards.
    if (repo.lastError) lines.push(`  error: ${repo.lastError}`);
  }
  lines.push("");
  lines.push("## Folder checkpoints");
  lines.push(`root: ${snapshot.checkpoints.root ?? "(unavailable)"}`);
  lines.push(
    `enabled: ${snapshot.checkpoints.enabled} · run snapshots: ${snapshot.checkpoints.runSnapshots}`,
  );
  if (snapshot.checkpoints.projects.length === 0) lines.push("(no folder snapshotted yet)");
  for (const project of snapshot.checkpoints.projects) {
    lines.push(
      `- ${project.key} ← ${project.workTree} · ${project.commits} checkpoints · ` +
        `${project.bytes} bytes${project.skipped > 0 ? ` · ${project.skipped} skipped` : ""}`,
    );
  }
  lines.push("");
  lines.push("## Office setup (wizard)");
  lines.push(officeText.trim().length > 0 ? officeText.trim() : "(not available)");
  return lines.join("\n");
}

export function createDiagnosticsService(deps: DiagnosticsServiceDeps): DiagnosticsService {
  const now = deps.now ?? ((): number => Date.now());
  const env = deps.env ?? {};
  let mainIncidents: Incident[] = [];
  let counter = 0;

  const record = (
    kind: IncidentKind,
    message: string,
    options: { detail?: string; tabId?: string } = {},
  ): Incident => {
    counter += 1;
    const incident = createIncident({
      kind,
      message,
      id: `main-inc-${counter}`,
      at: now(),
      ...(options.detail ? { detail: options.detail } : {}),
      ...(options.tabId ? { tabId: options.tabId } : {}),
    });
    mainIncidents = appendIncident(mainIncidents, incident, DEFAULT_INCIDENT_LIMIT);
    return incident;
  };

  const snapshot = (): DiagnosticsSnapshot => {
    const info = deps.appInfo();
    const sessionIncidents = deps.sessions?.incidents() ?? [];
    return {
      generatedAt: now(),
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
        buildChannel: info.buildChannel,
        buildVersion: info.buildVersion,
        buildCommit: info.buildCommit,
        builtAt: info.builtAt,
        safeMode: info.safeMode,
      },
      runtime: {
        source: info.runtimeSource,
        nodeVersion: info.runtimeNodeVersion,
        problems: [...info.runtimeProblems],
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
      hosts: deps.sessions?.hosts() ?? [],
      capacity: deps.sessions?.capacity?.() ?? {
        liveHosts: 0,
        targetHosts: DEFAULT_LIVE_HOSTS,
        ceilingHosts: hostProcessCeiling(),
        overTarget: false,
        hostRssBytes: 0,
        hostRssLimitBytes: 0,
        overMemory: false,
        openSessions: 0,
        asleepSessions: 0,
        editorTabs: 0,
        visibleSessions: 0,
      },
      memory: {
        budgetBytes: HOST_RSS_BUDGET_BYTES,
        restartBytes: HOST_RSS_RESTART_BYTES,
        ...(deps.systemMemory?.() ?? { totalBytes: null, freeBytes: null }),
      },
      web: deps.web?.() ?? { tabs: 0, liveViews: 0, limit: 0 },
      incidents: [...mainIncidents, ...sessionIncidents]
        .sort((left, right) => right.at - left.at)
        .slice(0, DEFAULT_INCIDENT_LIMIT),
      extensionErrors: deps.sessions?.extensionErrors() ?? [],
      office: deps.office(),
      environment: collectDiagnosticEnvironment(env),
      startup: deps.startup(),
      git: deps.git?.() ?? { version: null, repos: [] },
      checkpoints: deps.checkpoints?.() ?? {
        root: null,
        enabled: false,
        projects: [],
        runSnapshots: false,
      },
    };
  };

  return {
    snapshot,

    async exportBundle() {
      const state = snapshot();
      let officeText: string;
      try {
        officeText = await deps.officeBundle();
      } catch (error) {
        officeText = `(Office diagnostics failed: ${
          error instanceof Error ? error.message : String(error)
        })`;
      }
      const redacted = redactSecrets(renderDiagnosticsBundle(state, officeText));
      return {
        text: redacted.text,
        redactions: redacted.redactions,
        generatedAt: state.generatedAt,
      };
    },

    recordReported(value) {
      const incident = parseReportedIncident(value);
      if (!incident) return false;
      mainIncidents = appendIncident(mainIncidents, incident, DEFAULT_INCIDENT_LIMIT);
      return true;
    },

    recordMain(kind, message, detail) {
      return record(kind, message, detail ? { detail } : {});
    },

    incidents: () => [...mainIncidents],
  };
}
