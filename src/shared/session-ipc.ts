/**
 * The session IPC contract (plan step 3): tabs, host events and the request
 * envelope shared by the main process, the preload and the renderer.
 *
 * The renderer never sees a host process — it addresses a *tab*, and the session
 * service in main maps that tab to a supervised host. Keeping the tab record and
 * the event envelopes in `src/shared` means the allowlist in `ipc.ts`, the
 * preload and the renderer all agree on one shape.
 */

import type { TrustAnswer } from "./projects";
import { sanitizeWebUrl, webTabTitle } from "./web-tabs";
import { isWorkspaceRelativePath, workspaceBasename, type WorkspaceEntryKind } from "./workspace";

/**
 * The address of the app-wide **control host** (plan D-A3) on the session
 * request channel. The renderer addresses hosts as "tabs"; the control host is
 * the one address that is not a session tab, so this constant is shared by the
 * main-process session service and the IPC validator.
 */
export const CONTROL_TAB_ID = "control";

/** True when a request targets the control host rather than a session tab. */
export function isControlTabId(value: unknown): value is typeof CONTROL_TAB_ID {
  return value === CONTROL_TAB_ID;
}

/**
 * A tab's backing: a Pi session, the single Office host, an isolated web view, a
 * file open in the editor (plan step 7), or a native terminal (2026-11-05
 * terminal plan). A `web` and an `editor` tab have no host at all; a `terminal`
 * tab has a PTY host but **no Pi host**, so it is not `isHostBackedTab`.
 */
export type TabKind = "session" | "office" | "web" | "editor" | "terminal";

export const TAB_KINDS: readonly TabKind[] = ["session", "office", "web", "editor", "terminal"];

export function isTabKind(value: unknown): value is TabKind {
  return typeof value === "string" && (TAB_KINDS as readonly string[]).includes(value);
}

/** True for a kind that owns a supervised Pi host. */
export function isHostBackedTab(kind: TabKind): boolean {
  return kind === "session" || kind === "office";
}

/** A tab kind that belongs in the session surfaces (everything but a file tab). */
export type SessionTabKind = Exclude<TabKind, "editor">;

export function isSessionTabKind(kind: TabKind): kind is SessionTabKind {
  return kind !== "editor";
}

/** A narrows to an editor record with a validated file path. */
export function isEditorTab(tab: TabRecord): tab is TabRecord & { filePath: string } {
  return tab.kind === "editor" && typeof tab.filePath === "string";
}

/** Host/tab lifecycle as the UI needs to show it. */
export type TabStatus = "starting" | "idle" | "running" | "crashed" | "failed" | "stopped";

/** Why a host-backed tab is currently stopped (Diagnostics and the tab tooltip). */
export type TabStopReason = "idle" | "memory" | "park" | "crash" | "manual" | "restart" | "closed";

const TAB_STOP_REASONS: readonly TabStopReason[] = [
  "idle",
  "memory",
  "park",
  "crash",
  "manual",
  "restart",
  "closed",
];

/** One open session tab (host id === tab id). */
export interface TabRecord {
  id: string;
  kind: TabKind;
  /** Working directory the session runs in (the project folder). */
  cwd: string;
  title: string;
  /** Pi session JSONL once the session exists (used to resume after a crash). */
  sessionFile: string | null;
  status: TabStatus;
  createdAt: number;
  lastActiveAt: number;
  /** Model id from the last state snapshot, for the tab tooltip. */
  model: string | null;
  /** The page a `web` tab displays (plan step 21); null for host-backed tabs. */
  url?: string | null;
  /** The project-relative file an `editor` tab edits (plan step 7). */
  filePath?: string | null;
  /**
   * A terminal tab's last shell cwd (OSC 7), used only to start the restored
   * shell where the user left it. `cwd` above stays the project folder so the
   * rail and project activation never follow a `cd` inside a terminal.
   */
  lastCwd?: string | null;
  /** The shell profile a terminal tab was opened with. */
  profileId?: string | null;
  /**
   * The session tab whose notification opened this web tab (Plannotator). The
   * transcript uses it to link a review back to the session that started it.
   */
  sessionTabId?: string | null;
  /** Last failure, surfaced inline in the tab instead of only in a log. */
  error?: string;
  /** Why the host was stopped; set only while `status` is `stopped`/`crashed`. */
  stopReason?: TabStopReason | null;
  /** When the stop happened (epoch ms), for Diagnostics. */
  stoppedAt?: number | null;
  /**
   * The host is over the RSS budget but protected (active/visible), so it was
   * warned instead of recycled. Cleared on restart/below budget/replacement.
   */
  memoryOverBudget?: boolean;
  /**
   * Pinned tabs form a stable group at the front of the strip and are skipped by
   * Close Others/Close All. Omitted for a normal, unpinned tab.
   */
  pinned?: boolean;
}

/**
 * The tabs that own a Pi host (`session`/`office`), optionally excluding one id.
 *
 * Every cross-tab fan-out (model scope, queue modes, project-settings reload)
 * must use this selector: an `editor` or `web` tab has no host and a
 * `session.request` addressed to it is a bug, not a failed operation.
 */
export function hostBackedTabs<T extends Pick<TabRecord, "id" | "kind">>(
  tabs: readonly T[],
  exceptTabId?: string,
): T[] {
  return tabs.filter((tab) => tab.id !== exceptTabId && isHostBackedTab(tab.kind));
}

/** The path mapping used after a rename or move retargets open editor tabs. */
export interface RetargetEditorTabsInput {
  fromProjectPath: string;
  fromPath: string;
  toProjectPath: string;
  toPath: string;
  kind: WorkspaceEntryKind;
}

/** A tab that the session strip, sidebar and project activation may show. */
export type SessionTab = TabRecord & { kind: SessionTabKind };

/**
 * True for a tab that belongs in the session surfaces. A file tab is an editor
 * view, not a session, even though it shares the persisted tab list. The test is
 * `kind`, not `filePath`, so a malformed editor record cannot leak into a
 * session list.
 */
export function isSessionTab(tab: TabRecord): tab is SessionTab {
  return isSessionTabKind(tab.kind);
}

/**
 * The tab table plus the selection it belongs to.
 *
 * `revision` is monotonic per main process and increases whenever a publish
 * actually changes the table, so a late or reordered push can never overwrite a
 * newer one. `selectionSeq` increases only when the *selection* changes; the
 * renderer ignores an older selection echo, which is what keeps a background
 * ensure or a slow `activate` from moving the user's tab (2026-11-06 plan).
 *
 * Both are optional so a legacy sender (or a test double) still applies: an
 * absent number means "unknown, apply as before".
 */
export type SessionTabsEnvelope = {
  tabs: TabRecord[];
  activeTabId: string | null;
  revision?: number;
  selectionSeq?: number;
};

/**
 * Stable refusal for a passive read when the tab's host is asleep.
 *
 * Electron's IPC wrapper preserves only the message, not a custom error `code`,
 * so the renderer matches this text. It must stay a single stable sentence: the
 * renderer uses it to distinguish "the tab is asleep" from a real failure and
 * to avoid surfacing a toast for a resize/hydration read.
 */
export const SESSION_ASLEEP_MESSAGE = "The session is asleep. Activate the tab to wake its host.";

/** One host event frame, as forwarded from a host process. */
export interface SessionEventEntry {
  event: string;
  payload?: unknown;
  /** The session that produced the frame; absent on a legacy host. */
  sessionId?: string | null;
  /** Monotonic per-host session attachment counter (id can repeat on reload). */
  sessionEpoch?: number;
}

/**
 * A batch of host events for one tab. Batches keep their order, so a transcript
 * can be assembled by replaying them: `seq` increases per tab and a batch is
 * never split across a boundary that would reorder it.
 */
export interface SessionEventEnvelope {
  tabId: string;
  seq: number;
  events: SessionEventEntry[];
  /** Session identity at the time main pushed the batch; absent on legacy hosts. */
  sessionId?: string | null;
  sessionEpoch?: number;
}

/** The latest `state.get` snapshot for a tab. */
export interface SessionStateEnvelope {
  tabId: string;
  /** Opaque to shared: the host's `SessionSnapshot` (see `src/host/events.ts`). */
  state: unknown;
  /** Session identity for this snapshot; absent on legacy hosts. */
  sessionId?: string | null;
  sessionEpoch?: number;
}

export interface CreateTabInput {
  /** Project folder the session runs in (omitted for a `web` tab). */
  cwd?: string;
  kind?: TabKind;
  /** Resume an existing session file instead of creating a new one. */
  sessionFile?: string | null;
  /** The page to open when `kind` is `web` (required in that case). */
  url?: string;
  /** The project-relative file to edit when `kind` is `editor`. */
  filePath?: string;
  /** The session tab this web tab belongs to, for the transcript chip. */
  sessionTabId?: string;
  /** The shell profile to open when `kind` is `terminal`. */
  profileId?: string;
  /** Select the new tab (default true). False opens a background web tab. */
  activate?: boolean;
  model?: string;
  thinking?: string;
  /**
   * The user's already-given trust answer for this project (plan step 10). Sent
   * with a new session so a second tab in a session-trusted project never
   * re-prompts; `trust`/`never` are also accepted because the host persists them.
   */
  trust?: TrustAnswer;
}

export interface SessionRequestInput {
  tabId: string;
  method: string;
  params?: unknown;
}

const TAB_STATUSES: readonly TabStatus[] = [
  "starting",
  "idle",
  "running",
  "crashed",
  "failed",
  "stopped",
];

/**
 * The words the session chrome shows for a lifecycle value. `idle` is the
 * internal name for "host + session are open and nothing is streaming"; the
 * user-facing word is `ready`, because `idle` reads like the session is
 * inactive. The persisted shape stays `TabStatus` (no migration).
 */
export const SESSION_STATUS_LABEL: Record<TabStatus, string> = {
  starting: "starting",
  idle: "ready",
  running: "working",
  crashed: "crashed",
  failed: "failed",
  stopped: "asleep",
};

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A persisted terminal `lastCwd` is only kept when it is an absolute path; a
 * relative value would resolve against the app's cwd, which is never what the
 * user ran. Windows drive/UNC and POSIX forms are accepted.
 */
function absolutePathOrNull(value: unknown): string | null {
  const path = stringOrNull(value);
  if (!path || path.includes("\0")) return null;
  const absolute =
    /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\/.test(path) || path.startsWith("/");
  return absolute ? path : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stopReasonOrNull(value: unknown): TabStopReason | null {
  return typeof value === "string" && TAB_STOP_REASONS.includes(value as TabStopReason)
    ? (value as TabStopReason)
    : null;
}

/**
 * Coerces one untrusted entry into a `TabRecord`, or null when unusable. A web
 * tab is only usable with a permitted URL; a host-backed tab needs a folder.
 */
export function sanitizeTabRecord(value: unknown): TabRecord | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const id = stringOrNull(source.id);
  if (!id) return null;
  const kind = isTabKind(source.kind) ? source.kind : "session";
  const url = sanitizeWebUrl(source.url);
  const cwd = stringOrNull(source.cwd);
  const filePath = stringOrNull(source.filePath);
  if (kind === "web" && !url) return null;
  if (kind !== "web" && !cwd) return null;
  if (kind === "editor" && (!filePath || !isWorkspaceRelativePath(filePath))) return null;
  const status = source.status;
  return {
    id,
    kind,
    cwd: cwd ?? "",
    title:
      stringOrNull(source.title) ??
      (kind === "web"
        ? webTabTitle(url)
        : kind === "editor" && filePath
          ? workspaceBasename(filePath)
          : sessionTitle(cwd!)),
    sessionFile: stringOrNull(source.sessionFile),
    status: TAB_STATUSES.includes(status as TabStatus) ? (status as TabStatus) : "idle",
    createdAt: numberOr(source.createdAt, 0),
    lastActiveAt: numberOr(source.lastActiveAt, 0),
    model: stringOrNull(source.model),
    ...(kind === "web" ? { url, sessionTabId: stringOrNull(source.sessionTabId) } : {}),
    ...(kind === "editor" ? { filePath } : {}),
    ...(kind === "terminal"
      ? {
          lastCwd: absolutePathOrNull(source.lastCwd),
          profileId: stringOrNull(source.profileId),
        }
      : {}),
    ...(typeof source.error === "string" ? { error: source.error } : {}),
    ...(stopReasonOrNull(source.stopReason)
      ? { stopReason: stopReasonOrNull(source.stopReason) }
      : {}),
    ...(typeof source.stoppedAt === "number" && Number.isFinite(source.stoppedAt)
      ? { stoppedAt: source.stoppedAt }
      : {}),
    ...(source.memoryOverBudget === true ? { memoryOverBudget: true } : {}),
    ...(source.pinned === true ? { pinned: true } : {}),
  };
}

/** Sanitizes a persisted tab list, dropping entries that cannot be trusted. */
export function sanitizeTabs(value: unknown): TabRecord[] {
  if (!Array.isArray(value)) return [];
  const records: TabRecord[] = [];
  for (const entry of value) {
    const record = sanitizeTabRecord(entry);
    if (record) records.push(record);
  }
  return records;
}

/**
 * Whether a `state.get` snapshot says the session is doing work and must not be
 * parked or recycled. Shared by the session service (idle parking) and the
 * supervisor (idle/RSS recycling) so the two can never disagree about what
 * "busy" means.
 */
export function isSessionBusyState(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const nonEmpty = (field: unknown): boolean => Array.isArray(field) && field.length > 0;
  return (
    record.streaming === true ||
    record.compacting === true ||
    record.retrying === true ||
    (typeof record.pendingMessages === "number" && record.pendingMessages > 0) ||
    nonEmpty(record.steering) ||
    nonEmpty(record.followUp)
  );
}

/** Display title for a tab: the last path segment of the project folder. */
export function sessionTitle(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed || "session";
}
