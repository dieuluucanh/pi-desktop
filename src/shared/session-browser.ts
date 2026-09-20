/**
 * The session browser's pure model (plan step 11).
 *
 * `session.list` on the **control host** returns Pi's `SessionInfo[]` for the
 * whole profile (`SessionManager.listAll`). This module turns that untrusted
 * payload into a stable shape, groups it by project and answers the browser's
 * questions — search, recency ordering and "continue the most recent session".
 *
 * Nothing here touches the SDK, React or the filesystem, so the node test project
 * covers the rules without a DOM.
 */

import { projectNameOf } from "./projects";

/** One session as the browser shows it (a projection of Pi's `SessionInfo`). */
export interface SessionSummary {
  /** Absolute path of the session JSONL — the key every browser action uses. */
  path: string;
  id: string;
  /** Working directory the session runs in; empty for old Pi sessions. */
  cwd: string;
  /** The user's display name from `session_info` entries, when present. */
  name: string | null;
  /** Epoch milliseconds; Pi historically serialises these as ISO strings. */
  created: number;
  modified: number;
  messageCount: number;
  firstMessage: string;
  allMessagesText: string;
}

/** How many session rows the browser keeps; the list is a working set, not an index. */
export const MAX_SESSION_SUMMARIES = 2000;

/** Longest title/query text accepted, so a hostile session cannot blow up the UI. */
const MAX_SESSION_TEXT = 4000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function clampText(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_SESSION_TEXT) : "";
}

/** Parses a Pi timestamp, accepting an ISO string or an epoch number. */
function toEpoch(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/** Coerces one untrusted session entry, or null when it cannot be identified. */
export function sanitizeSessionSummary(value: unknown): SessionSummary | null {
  const record = asRecord(value);
  const path = typeof record.path === "string" && record.path.length > 0 ? record.path : null;
  if (!path) return null;
  const id = typeof record.id === "string" && record.id.length > 0 ? record.id : path;
  return {
    path,
    id,
    cwd: typeof record.cwd === "string" ? record.cwd : "",
    name: typeof record.name === "string" && record.name.trim().length > 0 ? record.name : null,
    created: toEpoch(record.created),
    modified: toEpoch(record.modified),
    messageCount:
      typeof record.messageCount === "number" && Number.isFinite(record.messageCount)
        ? Math.max(0, Math.floor(record.messageCount))
        : 0,
    firstMessage: clampText(record.firstMessage),
    allMessagesText: clampText(record.allMessagesText),
  };
}

/** Sanitizes Pi's whole listing, dropping duplicates and unusable rows. */
export function sanitizeSessionList(value: unknown): SessionSummary[] {
  const input = Array.isArray(value) ? value : [];
  const sessions: SessionSummary[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    const session = sanitizeSessionSummary(entry);
    if (!session || seen.has(session.path)) continue;
    seen.add(session.path);
    sessions.push(session);
    if (sessions.length >= MAX_SESSION_SUMMARIES) break;
  }
  return sessions;
}

/** Newest first. Sessions without a timestamp keep their input order at the end. */
export function sortSessionsByRecency(sessions: readonly SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((left, right) => right.modified - left.modified);
}

/** The title the browser shows: an explicit name, else the first user message. */
export function sessionDisplayTitle(session: SessionSummary): string {
  if (session.name) return session.name;
  const first = session.firstMessage.trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (first.length > 0) return first.length > 90 ? `${first.slice(0, 89)}…` : first;
  const folder = session.cwd ? projectNameOf(session.cwd) : "";
  return folder.length > 0
    ? `${folder} · ${shortId(session.id)}`
    : `Session ${shortId(session.id)}`;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** Case-insensitive substring search across the fields a user can recognise. */
export function matchesSessionQuery(session: SessionSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  const haystack = [
    session.name ?? "",
    session.firstMessage,
    session.allMessagesText,
    session.cwd,
    session.id,
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(needle);
}

/** Search + recency ordering, the browser's default pipeline. */
export function filterSessions(
  sessions: readonly SessionSummary[],
  query: string,
): SessionSummary[] {
  return sortSessionsByRecency(sessions.filter((session) => matchesSessionQuery(session, query)));
}

/** One project's sessions, newest first. */
export interface SessionGroup {
  /** The session cwd shared by the group (`""` for legacy sessions). */
  cwd: string;
  /** Display name for the group heading. */
  name: string;
  sessions: SessionSummary[];
  /** The most recent session in the group, for "continue where you left off". */
  latest: SessionSummary | null;
}

/** Groups by project, newest project first (by its most recent session). */
export function groupSessionsByProject(sessions: readonly SessionSummary[]): SessionGroup[] {
  const byCwd = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const key = session.cwd.length > 0 ? session.cwd : "";
    const list = byCwd.get(key) ?? [];
    list.push(session);
    byCwd.set(key, list);
  }
  const groups: SessionGroup[] = [];
  for (const [cwd, list] of byCwd) {
    const ordered = sortSessionsByRecency(list);
    groups.push({
      cwd,
      name: cwd.length > 0 ? projectNameOf(cwd) : "No project directory",
      sessions: ordered,
      latest: ordered[0] ?? null,
    });
  }
  return groups.sort((left, right) => (right.latest?.modified ?? 0) - (left.latest?.modified ?? 0));
}

/** The most recent session started in `cwd`, or null when there is none. */
export function mostRecentSessionForProject(
  sessions: readonly SessionSummary[],
  cwd: string,
): SessionSummary | null {
  let best: SessionSummary | null = null;
  for (const session of sessions) {
    if (session.cwd !== cwd) continue;
    if (!best || session.modified > best.modified) best = session;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Session tree (plan step 11)
// ---------------------------------------------------------------------------

/** One row of the flattened session tree, in document order. */
export interface SessionTreeRow {
  id: string;
  /** Nesting depth, so the view can indent without re-walking the tree. */
  depth: number;
  /** Pi's entry type (`message`, `model_change`, `compaction`, …). */
  type: string;
  /** For message entries: `user` / `assistant`; null otherwise. */
  role: string | null;
  /** A one-line human summary of the entry. */
  text: string;
  /** The resolved display label, when the entry carries one. */
  label: string | null;
  timestamp: number;
  /** The entry the session's leaf currently points at. */
  leaf: boolean;
}

function entryText(entry: Record<string, unknown>): string {
  const message = asRecord(entry.message);
  const role = typeof message.role === "string" ? message.role : null;
  if (role === "user" || role === "assistant") {
    const content = message.content;
    if (typeof content === "string") return content.replace(/\s+/g, " ").trim();
    if (Array.isArray(content)) {
      const text = content
        .map((block) => {
          const record = asRecord(block);
          return record.type === "text" ? String(record.text ?? "") : "";
        })
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      return text;
    }
    return "";
  }
  switch (entry.type) {
    case "model_change":
      return [entry.provider, entry.modelId].filter(Boolean).join("/");
    case "thinking_level_change":
      return `thinking ${String(entry.thinkingLevel ?? "")}`.trim();
    case "compaction":
      return "context compacted";
    case "branch_summary":
      return stringOrText(entry.summary);
    case "session_info":
      return typeof entry.name === "string" ? `named “${entry.name}”` : "session name";
    case "custom_message":
      return stringOrText(entry.content);
    case "label":
      return typeof entry.label === "string" ? `label “${entry.label}”` : "label cleared";
    default:
      return typeof entry.type === "string" ? entry.type : "entry";
  }
}

function stringOrText(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (Array.isArray(value)) {
    return value
      .map((block) => {
        const record = asRecord(block);
        return record.type === "text" ? String(record.text ?? "") : "";
      })
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

/**
 * Flattens Pi's `SessionTreeNode[]` into render-able rows in document order.
 *
 * The input is opaque (it belongs to the SDK), so every field is treated as
 * untrusted and a malformed node is skipped rather than crashing the dialog.
 * `leafId` marks the row the session is currently on, which is the row the view
 * disables "go to" for.
 */
export function flattenSessionTree(tree: unknown, leafId: string | null): SessionTreeRow[] {
  const rows: SessionTreeRow[] = [];
  const walk = (nodes: unknown, depth: number): void => {
    if (!Array.isArray(nodes) || depth > 64) return;
    for (const raw of nodes) {
      const node = asRecord(raw);
      const entry = asRecord(node.entry);
      const id = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : null;
      if (id) {
        rows.push({
          id,
          depth,
          type: typeof entry.type === "string" ? entry.type : "entry",
          role:
            typeof asRecord(entry.message).role === "string"
              ? String(asRecord(entry.message).role)
              : null,
          text: entryText(entry).slice(0, 200),
          label: typeof node.label === "string" && node.label.length > 0 ? node.label : null,
          timestamp: toEpoch(entry.timestamp),
          leaf: id === leafId,
        });
      }
      walk(node.children, depth + 1);
    }
  };
  walk(tree, 0);
  return rows;
}
