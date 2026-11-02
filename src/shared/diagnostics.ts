import type { HostRole } from "./host-protocol";
import type { Capacity, StartupReport } from "./performance";

/**
 * Reliability, recovery and diagnostics — the pure wire model (plan step 22).
 *
 * Nothing here touches Electron, the SDK or the filesystem: it classifies a
 * failed operation into an *incident* (what went wrong), says whether recovery
 * is possible and what the user can do next, and describes the snapshot the
 * Diagnostics view renders. The main process owns collection; the renderer owns
 * presentation; the host owns safe-mode behaviour. This module is the vocabulary
 * they share, and it is unit tested on its own.
 */

/* --------------------------------------------------------------- incidents */

/**
 * The failure families the app can tell apart. `unknown` is deliberate: an
 * unrecognised message keeps its own text and gets no invented advice.
 */
export type IncidentKind =
  | "host_crash"
  | "host_timeout"
  | "host_spawn"
  | "host_failed"
  | "host_stale"
  | "extension_error"
  | "unhandled_rejection"
  | "uncaught_exception"
  | "offline"
  | "permission"
  | "read_only"
  | "disk_full"
  | "unavailable"
  | "bad_request"
  // Source control and folder checkpoints (git-checkpoint plan step 28). These
  // are git's own failure modes, surfaced as first-class incidents so
  // `classifyFailure` can name the fix instead of reporting "unknown".
  | "git_missing"
  | "git_locked"
  | "git_auth"
  | "git_conflict"
  | "git_no_identity"
  | "git_rejected"
  | "checkpoint_locked_file"
  | "unknown";

export type IncidentSeverity = "info" | "warning" | "error";

/** One thing that went wrong, in a form the UI can render and the bundle can redact. */
export interface Incident {
  id: string;
  kind: IncidentKind;
  severity: IncidentSeverity;
  /** The raw error message, verbatim (redaction happens on export). */
  message: string;
  /** Extra context (a stack, a log tail, a method name). */
  detail?: string;
  /** The tab the incident belongs to, when it is session-scoped. */
  tabId?: string;
  at: number;
  /** A restart of the owning host is a plausible fix (host crash/timeout/spawn). */
  recoverable: boolean;
  /** A next step the user can act on, when one is known. */
  fix?: string;
}

const OFFLINE_PATTERN =
  /enotfound|etimedout|eai_again|econnrefused|econnreset|econnaborted|network|offline|getaddrinfo|socket hang up|fetch failed|dns/i;
const PERMISSION_PATTERN =
  /eacces|eperm|permission denied|access is denied|operation not permitted|not authorized/i;
const READ_ONLY_PATTERN = /erofs|read-only file system|readonly|read only file system/i;
const DISK_FULL_PATTERN = /enospc|no space left|disk (is )?full|insufficient (disk )?space/i;
const TIMEOUT_PATTERN = /timed out|timeout|deadline exceeded/i;
const CRASH_PATTERN = /crashed|exited unexpectedly|host exited|crash loop/i;
const SPAWN_PATTERN = /not running|failed to spawn|spawn error|enoent|is not running/i;
const STALE_HOST_PATTERN =
  /host build|host is a stale build|host process does not serve command suggestions|stale host|commands\.complete|model\.scope\.(?:apply|toggle)|the model scope is not supported/i;
const UNAVAILABLE_PATTERN = /unavailable|not available|cannot start|no such route/i;
const BAD_REQUEST_PATTERN = /unknown method|bad request|invalid|unsupported|is required/i;

/**
 * Source-control patterns (git-checkpoint plan step 28). They are checked
 * *before* the generic ones on purpose: a locked index and an `EBUSY` retry both
 * read like "permission" or "unknown" otherwise, and the fix is completely
 * different (`remove .git/index.lock`, close the document).
 */
const GIT_MISSING_PATTERN =
  /git is not installed|git is not on (this app's )?path|and make sure it is on your path|spawn git enoent/i;
const GIT_LOCKED_PATTERN =
  /index\.lock|unable to create '.*\.lock'|another git process|could not lock|cannot lock ref|unable to lock/i;
const GIT_AUTH_PATTERN =
  /authentication failed|could not read username|permission denied \(publickey\)|fatal: could not read password|terminal prompts disabled|invalid credentials|host key verification failed/i;
const GIT_CONFLICT_PATTERN =
  /automatic merge failed|fix conflicts|unmerged paths|conflict \(content\)|needs merge|you have unmerged files/i;
const GIT_NO_IDENTITY_PATTERN =
  /please tell me who you are|unable to auto-detect email address|empty ident name|no email was given and auto-detection is disabled/i;
const GIT_REJECTED_PATTERN =
  /\[rejected\]|non-fast-forward|failed to push some refs|updates were rejected/i;
const CHECKPOINT_LOCKED_FILE_PATTERN =
  /ebusy|resource busy|the process cannot access the file|being used by another process|could not be written.*locked|locked by/i;

/**
 * Classifies an error message. Order matters: a read-only profile that is also
 * unreachable should be reported as the disk problem, because that is the fix
 * the user must apply first.
 */
export function classifyFailure(message: string): IncidentKind {
  const text = typeof message === "string" ? message : String(message ?? "");
  // Source control first: these messages also match the generic disk/permission
  // patterns, and naming the git-specific fix is the whole point of the kind.
  if (GIT_MISSING_PATTERN.test(text)) return "git_missing";
  if (GIT_LOCKED_PATTERN.test(text)) return "git_locked";
  if (GIT_AUTH_PATTERN.test(text)) return "git_auth";
  if (GIT_CONFLICT_PATTERN.test(text)) return "git_conflict";
  if (GIT_NO_IDENTITY_PATTERN.test(text)) return "git_no_identity";
  if (GIT_REJECTED_PATTERN.test(text)) return "git_rejected";
  if (CHECKPOINT_LOCKED_FILE_PATTERN.test(text)) return "checkpoint_locked_file";
  if (DISK_FULL_PATTERN.test(text)) return "disk_full";
  if (READ_ONLY_PATTERN.test(text)) return "read_only";
  if (PERMISSION_PATTERN.test(text)) return "permission";
  if (OFFLINE_PATTERN.test(text)) return "offline";
  if (TIMEOUT_PATTERN.test(text)) return "host_timeout";
  if (CRASH_PATTERN.test(text)) return "host_crash";
  if (SPAWN_PATTERN.test(text)) return "host_spawn";
  if (STALE_HOST_PATTERN.test(text)) return "host_stale";
  if (UNAVAILABLE_PATTERN.test(text)) return "unavailable";
  if (BAD_REQUEST_PATTERN.test(text)) return "bad_request";
  return "unknown";
}

/** True when the message looks like a network/connectivity failure. */
export function isOfflineError(message: unknown): boolean {
  return (
    classifyFailure(typeof message === "string" ? message : String(message ?? "")) === "offline"
  );
}

/**
 * Pi's own `PI_OFFLINE` rule (verified against the SDK): unset/empty is online;
 * `1`, `true` or `yes` (case-insensitive) disable startup network operations.
 */
export function isOfflineEnv(value: string | undefined): boolean {
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

const SEVERITY_BY_KIND: Record<IncidentKind, IncidentSeverity> = {
  host_crash: "error",
  host_timeout: "error",
  host_spawn: "error",
  host_failed: "error",
  host_stale: "warning",
  extension_error: "error",
  unhandled_rejection: "error",
  uncaught_exception: "error",
  offline: "warning",
  permission: "error",
  read_only: "error",
  disk_full: "error",
  unavailable: "error",
  bad_request: "warning",
  // A missing git or an unconfigured identity blocks the feature but is not an
  // app failure; a locked index, a conflict or a rejected push is the user's work
  // in flight. None of them is "error" in the sense of "the app broke".
  git_missing: "warning",
  git_locked: "warning",
  git_auth: "warning",
  git_conflict: "warning",
  git_no_identity: "warning",
  git_rejected: "warning",
  checkpoint_locked_file: "warning",
  unknown: "warning",
};

export function incidentSeverity(kind: IncidentKind): IncidentSeverity {
  return SEVERITY_BY_KIND[kind] ?? "warning";
}

/**
 * Whether the owning host is worth restarting. A crash, a wedged request or a
 * dead process comes back cleanly; an offline registry or a read-only profile
 * will fail the same way until the cause is addressed, so neither claims to be
 * fixed by a restart.
 */
export function isRecoverable(kind: IncidentKind): boolean {
  return (
    kind === "host_crash" ||
    kind === "host_timeout" ||
    kind === "host_spawn" ||
    kind === "host_failed" ||
    kind === "host_stale"
  );
}

/**
 * The actionable next step for a failure family (plan step 22 deliverable:
 * "disk-permission/read-only-profile errors with fixes"). `null` means the raw
 * message already says everything useful.
 */
export function incidentFix(kind: IncidentKind): string | null {
  switch (kind) {
    case "host_crash":
      return "Restart the session — history is on disk and comes back from the JSONL.";
    case "host_timeout":
      return "The host stopped answering. Restart it; the current run is lost but the transcript is not.";
    case "host_spawn":
      return "The host process could not start. Check the runtime in Diagnostics, then restart the tab.";
    case "host_failed":
      return "The host crashed repeatedly and was stopped. Restart it, or launch with --safe-mode to rule out an extension.";
    case "host_stale":
      return "Restart the session tab to load the current host build; history comes back from the JSONL.";
    case "extension_error":
      return "Disable the extension in Extensions, or start with --safe-mode, then reload the session.";
    case "offline":
      return "This machine looks offline. Check the connection (or `httpProxy` in Settings) and retry; `PI_OFFLINE=1` also disables Pi's startup network calls.";
    case "permission":
      return "The app could not read or write a profile file. Fix the folder permissions for the Pi profile, then retry.";
    case "read_only":
      return "The Pi profile (or the project) is on a read-only volume. Move it to a writable folder, or launch with a separate PI_CODING_AGENT_DIR.";
    case "disk_full":
      return "The disk is full. Free space, then retry — Pi writes sessions and settings to the profile.";
    case "unavailable":
      return "The bundled runtime could not be resolved. Reinstall the app, or run runtime:verify to see what is missing.";
    case "uncaught_exception":
      return "An unexpected error escaped. Export diagnostics and restart; your sessions are on disk.";
    // Source control and folder checkpoints (git-checkpoint plan step 28).
    case "git_missing":
      return "Install git and make sure it is on your PATH; it is not bundled with the app.";
    case "git_locked":
      return "Another git process is running. Close it, or delete .git/index.lock only if no git process is alive.";
    case "git_auth":
      return "git is waiting for credentials it cannot ask for. Run the same command in a terminal once so your credential helper or SSH agent stores them.";
    case "git_conflict":
      return "Resolve the conflicts in a terminal or your editor, then stage the files and commit.";
    case "git_no_identity":
      return "Set user.name and user.email for this repository — the rail's commit box offers a repository-local form.";
    case "git_rejected":
      return "The remote has commits you do not have. Pull (or fetch and merge) first, then push again.";
    case "checkpoint_locked_file":
      return "Close the document in Word/Excel/PowerPoint, then restore again; an open file cannot be written.";
    default:
      return null;
  }
}

export interface IncidentInput {
  kind: IncidentKind;
  message: string;
  detail?: string;
  tabId?: string;
  at?: number;
  /** An id generator; main supplies a monotonic one, tests a constant. */
  id?: string;
}

/** Builds an incident, deriving severity/recoverability/fix from the kind. */
export function createIncident(input: IncidentInput): Incident {
  const fix = incidentFix(input.kind);
  return {
    id: input.id ?? `inc-${Math.random().toString(36).slice(2, 10)}`,
    kind: input.kind,
    severity: incidentSeverity(input.kind),
    message: input.message,
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.tabId ? { tabId: input.tabId } : {}),
    at: input.at ?? Date.now(),
    recoverable: isRecoverable(input.kind),
    ...(fix ? { fix } : {}),
  };
}

export const DEFAULT_INCIDENT_LIMIT = 50;

/** Newest first, bounded, with consecutive duplicates collapsed. */
export function appendIncident(
  list: Incident[],
  incident: Incident,
  limit: number = DEFAULT_INCIDENT_LIMIT,
): Incident[] {
  const latest = list[0];
  if (latest && latest.kind === incident.kind && latest.message === incident.message) {
    return list;
  }
  return [incident, ...list].slice(0, Math.max(1, limit));
}

/** Validates a renderer-reported incident (the allowlist for `diagnostics:record`). */
export function parseReportedIncident(value: unknown): Incident | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message.slice(0, 4_000) : null;
  if (!message || message.length === 0) return null;
  const kind =
    typeof record.kind === "string" && record.kind in SEVERITY_BY_KIND
      ? (record.kind as IncidentKind)
      : classifyFailure(message);
  const detail = typeof record.detail === "string" ? record.detail.slice(0, 8_000) : undefined;
  const tabId =
    typeof record.tabId === "string" && record.tabId.length > 0 ? record.tabId : undefined;
  return createIncident({
    kind,
    message,
    ...(detail ? { detail } : {}),
    ...(tabId ? { tabId } : {}),
  });
}

/* ------------------------------------------------------------- diagnostics */

/**
 * Environment variables the bundle is allowed to include (plan step 22). The
 * list is an allowlist on purpose: a support bundle must never sweep the whole
 * environment into a file the user will paste into an issue.
 */
export const DIAGNOSTIC_ENV_KEYS = [
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_DESKTOP_SAFE_MODE",
  "PI_DESKTOP_USER_DATA_DIR",
  "PI_DESKTOP_HOST_MODE",
  "PI_OFFICE_BRIDGE_PORT",
  "PI_OFFICE_BRIDGE_ALLOWED_ORIGINS",
  "PI_OFFLINE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "TERM",
  "WSL_DISTRO_NAME",
  "SSH_CONNECTION",
] as const;

export interface DiagnosticsHostInfo {
  tabId: string;
  role: HostRole;
  status: string;
  cwd: string;
  sessionFile: string | null;
  officeHost: boolean;
  pid: number | null;
  startedAt: number | null;
  /** The host's last self-reported RSS in bytes, or null before the first poll. */
  rssBytes: number | null;
  /** Fingerprint reported by `host.hello`; null for a pre-change host. */
  buildId: string | null;
  /** True when the running host predates the bundle on disk. */
  stale: boolean;
  /** The tail of the host's own log file, oldest first. */
  logLines: string[];
}

export interface DiagnosticsAppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  isDev: boolean;
  /** Build provenance from `<resources>/build-info.json` (or `dev`/`unknown`). */
  buildChannel: string;
  buildVersion: string | null;
  buildCommit: string | null;
  builtAt: string | null;
  safeMode: boolean;
}

export interface DiagnosticsRuntimeInfo {
  source: string | null;
  nodeVersion: string | null;
  problems: string[];
}

export interface DiagnosticsPathsInfo {
  userDataDir: string;
  logsDir: string;
  blobCacheDir: string;
  profileDir: string;
  settingsFile: string;
  authFile: string;
  modelsFile: string;
  appStateFile: string;
  homeDir: string;
}

export interface DiagnosticsExtensionError {
  tabId: string;
  extensionId: string | null;
  message: string;
  at: number;
}

/** The bridge's last known state, flattened for the view (plan step 20 data). */
export interface DiagnosticsOfficeInfo {
  available: boolean;
  status: string;
  port: number;
  protocolVersion: number | null;
  panes: number;
  error?: string;
}

/** Everything the Diagnostics view renders. */
export interface DiagnosticsSnapshot {
  generatedAt: number;
  app: DiagnosticsAppInfo;
  runtime: DiagnosticsRuntimeInfo;
  paths: DiagnosticsPathsInfo;
  hosts: DiagnosticsHostInfo[];
  /** Used/limit of the host and tab caps (plan step 24 backpressure). */
  capacity: { hosts: Capacity; tabs: Capacity };
  /** The per-host memory budget and restart threshold, for the RSS readout. */
  memory: { budgetBytes: number; restartBytes: number };
  incidents: Incident[];
  extensionErrors: DiagnosticsExtensionError[];
  office: DiagnosticsOfficeInfo;
  environment: Record<string, string>;
  /** True when the app is running with third-party code disabled (plan step 22). */
  safeMode: boolean;
  /** The startup-budget measurements (plan step 24). */
  startup: StartupReport;
  /**
   * Source control (git-checkpoint plan step 28). One entry per repository the
   * rail has read, so a support bundle shows *which* folder failed and when —
   * "git is broken" is not actionable, "`C:\work
eports` failed at 10:04 with
   * an index.lock" is.
   */
  git: DiagnosticsGitInfo;
  /** Folder checkpoints (git-checkpoint plan step 28). */
  checkpoints: DiagnosticsCheckpointInfo;
}

export interface DiagnosticsGitInfo {
  /** `git --version`'s first line, or null when git is missing. */
  version: string | null;
  repos: {
    root: string;
    branch: string | null;
    dirty: boolean;
    /** How long the last `status` read took, or null when it never ran. */
    lastStatusMs: number | null;
    /** The last failure for this repository, already classified. */
    lastError: string | null;
  }[];
}

export interface DiagnosticsCheckpointInfo {
  /** `<profileDir>/checkpoints`, or null when it could not be resolved. */
  root: string | null;
  enabled: boolean;
  projects: {
    key: string;
    workTree: string;
    commits: number;
    bytes: number;
    lastSnapshotAt: number | null;
    skipped: number;
  }[];
  /** Whether the host reported the checkpoint extension (false in safe mode). */
  runSnapshots: boolean;
}

export interface DiagnosticsExport {
  text: string;
  redactions: number;
  generatedAt: number;
}

/** A short, user-facing sentence for a failure family (banner/toast text). */
export function incidentHeadline(incident: Incident): string {
  switch (incident.kind) {
    case "host_crash":
      return "The session host crashed";
    case "host_timeout":
      return "The session host stopped responding";
    case "host_spawn":
      return "The session host could not start";
    case "host_failed":
      return "The session host was stopped after repeated crashes";
    case "host_stale":
      return "The session host is running an older build";
    case "extension_error":
      return "An extension raised an error";
    case "offline":
      return "This machine looks offline";
    case "permission":
      return "A profile file could not be accessed";
    case "read_only":
      return "The Pi profile is read-only";
    case "disk_full":
      return "The disk is full";
    case "unavailable":
      return "The bundled Pi runtime is unavailable";
    case "unhandled_rejection":
      return "An unexpected promise rejection was caught";
    case "uncaught_exception":
      return "An unexpected error was caught";
    // Source control and checkpoints (git-checkpoint plan step 28).
    case "git_missing":
      return "git is not installed";
    case "git_locked":
      return "Another git process holds the repository";
    case "git_auth":
      return "git could not authenticate";
    case "git_conflict":
      return "The repository has merge conflicts";
    case "git_no_identity":
      return "git has no commit identity";
    case "git_rejected":
      return "The remote rejected the push";
    case "checkpoint_locked_file":
      return "A file could not be written because it is open";
    default:
      return "Something went wrong";
  }
}
