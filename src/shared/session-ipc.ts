/**
 * The session IPC contract (plan step 3): tabs, host events and the request
 * envelope shared by the main process, the preload and the renderer.
 *
 * The renderer never sees a host process — it addresses a *tab*, and the session
 * service in main maps that tab to a supervised host. Keeping the tab record and
 * the event envelopes in `src/shared` means the allowlist in `ipc.ts`, the
 * preload and the renderer all agree on one shape.
 */

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

export type TabKind = "session" | "office" | "web";

export const TAB_KINDS: readonly TabKind[] = ["session", "office", "web"];

export function isTabKind(value: unknown): value is TabKind {
  return typeof value === "string" && (TAB_KINDS as readonly string[]).includes(value);
}

/** Host/tab lifecycle as the UI needs to show it. */
export type TabStatus = "starting" | "idle" | "running" | "crashed" | "failed" | "stopped";

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
  /** Last failure, surfaced inline in the tab instead of only in a log. */
  error?: string;
}

export type SessionTabsEnvelope = { tabs: TabRecord[]; activeTabId: string | null };

/** One host event frame, as forwarded from a host process. */
export interface SessionEventEntry {
  event: string;
  payload?: unknown;
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
}

/** The latest `state.get` snapshot for a tab. */
export interface SessionStateEnvelope {
  tabId: string;
  /** Opaque to shared: the host's `SessionSnapshot` (see `src/host/events.ts`). */
  state: unknown;
}

export interface CreateTabInput {
  /** Project folder the session runs in. */
  cwd: string;
  kind?: TabKind;
  /** Resume an existing session file instead of creating a new one. */
  sessionFile?: string | null;
  model?: string;
  thinking?: string;
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

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Coerces one untrusted entry into a `TabRecord`, or null when unusable. */
export function sanitizeTabRecord(value: unknown): TabRecord | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const id = stringOrNull(source.id);
  const cwd = stringOrNull(source.cwd);
  if (!id || !cwd) return null;
  const status = source.status;
  return {
    id,
    kind: isTabKind(source.kind) ? source.kind : "session",
    cwd,
    title: stringOrNull(source.title) ?? sessionTitle(cwd),
    sessionFile: stringOrNull(source.sessionFile),
    status: TAB_STATUSES.includes(status as TabStatus) ? (status as TabStatus) : "idle",
    createdAt: numberOr(source.createdAt, 0),
    lastActiveAt: numberOr(source.lastActiveAt, 0),
    model: stringOrNull(source.model),
    ...(typeof source.error === "string" ? { error: source.error } : {}),
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

/** Display title for a tab: the last path segment of the project folder. */
export function sessionTitle(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed || "session";
}
