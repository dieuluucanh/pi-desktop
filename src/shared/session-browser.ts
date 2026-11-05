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
  /**
   * A display title computed in the host from the full row (including
   * `firstMessage`). The wire projection carries this instead of the message
   * text, so a large profile cannot spill its listing onto the blob path.
   */
  title?: string;
  /** The session this one was forked/cloned from, when Pi recorded it. */
  parentSessionPath: string | null;
}

/** How many session rows the browser keeps; the list is a working set, not an index. */
export const MAX_SESSION_SUMMARIES = 2000;

/** Longest title/query text accepted, so a hostile session cannot blow up the UI. */
const MAX_SESSION_TEXT = 4000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function clampText(value: unknown, maxChars: number = MAX_SESSION_TEXT): string {
  return typeof value === "string" ? value.slice(0, maxChars) : "";
}

/** Options for the sanitizers; the host keeps full text for search, the wire clamps it. */
export interface SanitizeSessionOptions {
  /** Maximum characters retained from `firstMessage` / `allMessagesText`. */
  maxTextChars?: number;
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
export function sanitizeSessionSummary(
  value: unknown,
  options: SanitizeSessionOptions = {},
): SessionSummary | null {
  const record = asRecord(value);
  const path = typeof record.path === "string" && record.path.length > 0 ? record.path : null;
  if (!path) return null;
  const maxTextChars = options.maxTextChars ?? MAX_SESSION_TEXT;
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
    firstMessage: clampText(record.firstMessage, maxTextChars),
    allMessagesText: clampText(record.allMessagesText, maxTextChars),
    ...(typeof record.title === "string" && record.title.trim().length > 0
      ? { title: clampText(record.title, maxTextChars) }
      : {}),
    parentSessionPath:
      typeof record.parentSessionPath === "string" && record.parentSessionPath.length > 0
        ? record.parentSessionPath
        : null,
  };
}

/** Sanitizes Pi's whole listing, dropping duplicates and unusable rows. */
export function sanitizeSessionList(
  value: unknown,
  options: SanitizeSessionOptions = {},
): SessionSummary[] {
  const input = Array.isArray(value) ? value : [];
  const sessions: SessionSummary[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    const session = sanitizeSessionSummary(entry, options);
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

/** The title the browser shows: a host-computed title, an explicit name, else the first user message. */
export function sessionDisplayTitle(session: SessionSummary): string {
  const provided = session.title?.trim();
  if (provided && provided.length > 0) {
    return provided.length > 90 ? `${provided.slice(0, 89)}…` : provided;
  }
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

/**
 * A parsed browser query (plan step 16). Terminal Pi's session selector accepts
 * a regex (`re:`), exact phrases (`"two words"`) and plain whitespace tokens
 * that all have to match. A bad regex is an error the bar shows; an unbalanced
 * quote degrades to plain tokens rather than empty results.
 */
export interface SessionQuery {
  /** Lowercase literal terms; every one must appear somewhere. */
  terms: string[];
  /** An exact phrase (quoted), matched case-insensitively. */
  phrase: string | null;
  /** A compiled `re:` pattern, or null. */
  regex: RegExp | null;
  /** The regex engine's message when `re:` is invalid. */
  error: string | null;
}

export function parseSessionQuery(query: string): SessionQuery {
  const raw = query.trim();
  if (raw.length === 0) return { terms: [], phrase: null, regex: null, error: null };

  const regexMatch = /^re:(.*)$/s.exec(raw);
  if (regexMatch) {
    const body = regexMatch[1] ?? "";
    try {
      return { terms: [], phrase: null, regex: new RegExp(body, "i"), error: null };
    } catch (error) {
      return {
        terms: [],
        phrase: null,
        regex: null,
        error: error instanceof Error ? error.message : "Invalid regular expression",
      };
    }
  }

  // A balanced quoted phrase wins; tokens outside it still have to match.
  const phraseMatch = /"([^"]*)"/.exec(raw);
  const remainder = phraseMatch ? raw.replace(phraseMatch[0], " ") : raw;
  const terms = remainder
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .map((term) => term.toLowerCase());
  return {
    terms,
    phrase: phraseMatch?.[1] && phraseMatch[1].length > 0 ? phraseMatch[1].toLowerCase() : null,
    regex: null,
    error: null,
  };
}

function sessionHaystack(session: SessionSummary): string {
  return [
    session.name ?? "",
    session.firstMessage,
    session.allMessagesText,
    session.cwd,
    session.id,
  ]
    .join("\n")
    .toLowerCase();
}

/** Tests one parsed query against a session (all parts must match). */
export function matchesParsedQuery(session: SessionSummary, parsed: SessionQuery): boolean {
  if (parsed.error) return false;
  const haystack = sessionHaystack(session);
  if (parsed.regex) {
    // A fresh scanner each call: `.test` on a global/sticky regex keeps state.
    const scanner = new RegExp(parsed.regex.source, parsed.regex.flags.replace(/[gy]/g, ""));
    return scanner.test(haystack);
  }
  if (parsed.phrase && !haystack.includes(parsed.phrase)) return false;
  return parsed.terms.every((term) => haystack.includes(term));
}

/** Case-insensitive search across the fields a user can recognise. */
export function matchesSessionQuery(session: SessionSummary, query: string): boolean {
  return matchesParsedQuery(session, parseSessionQuery(query));
}

/** What search + ordering score a session got, so `relevance` can order by it. */
function relevanceScore(session: SessionSummary, parsed: SessionQuery): number {
  const name = (session.name ?? "").toLowerCase();
  const first = session.firstMessage.toLowerCase();
  const all = session.allMessagesText.toLowerCase();
  let score = 0;
  for (const term of parsed.terms) {
    if (name.includes(term)) score += 5;
    if (first.includes(term)) score += 3;
    if (all.includes(term)) score += 1;
  }
  if (parsed.phrase) {
    if (name.includes(parsed.phrase)) score += 6;
    if (first.includes(parsed.phrase)) score += 4;
  }
  if (parsed.regex && name.includes(parsed.regex.source.toLowerCase())) score += 2;
  return score;
}

export type SessionScope = "all" | "current";
export type SessionSort = "recent" | "threaded" | "relevance";

/** The browser's filter controls (terminal Pi's selector has the same set). */
export interface SessionListOptions {
  query?: string;
  scope?: SessionScope;
  /** The `current` scope's project directory. */
  cwd?: string | null;
  sort?: SessionSort;
  /** Only sessions with an explicit name. */
  namedOnly?: boolean;
}

/** The root of a session's fork chain within the listing, for `threaded`. */
function threadRoot(session: SessionSummary, byPath: Map<string, SessionSummary>): string {
  let current = session;
  const seen = new Set<string>([current.path]);
  while (current.parentSessionPath) {
    const parent = byPath.get(current.parentSessionPath);
    if (!parent || seen.has(parent.path)) break;
    seen.add(parent.path);
    current = parent;
  }
  return current.path;
}

/**
 * Threaded order (plan step 16): a fork chain stays together, the newest thread
 * first, and inside a thread the parent precedes its children (by `created`).
 */
export function sortSessionsThreaded(sessions: readonly SessionSummary[]): SessionSummary[] {
  const byPath = new Map(sessions.map((session) => [session.path, session]));
  const threads = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const root = threadRoot(session, byPath);
    const list = threads.get(root) ?? [];
    list.push(session);
    threads.set(root, list);
  }
  const ordered = [...threads.entries()].sort(([, left], [, right]) => {
    const leftLatest = Math.max(...left.map((session) => session.modified));
    const rightLatest = Math.max(...right.map((session) => session.modified));
    return rightLatest - leftLatest;
  });
  return ordered.flatMap(([, thread]) =>
    [...thread].sort((left, right) => left.created - right.created),
  );
}

/** The full browser pipeline: filter (scope/query/named) then order. */
export function listSessions(
  sessions: readonly SessionSummary[],
  options: SessionListOptions = {},
): { sessions: SessionSummary[]; error: string | null } {
  const parsed = parseSessionQuery(options.query ?? "");
  if (parsed.error) return { sessions: [], error: parsed.error };
  const scope = options.scope ?? "all";
  const cwd = options.cwd ?? null;
  const filtered = sessions.filter((session) => {
    if (scope === "current" && (cwd === null || session.cwd !== cwd)) return false;
    if (options.namedOnly === true && !session.name) return false;
    return matchesParsedQuery(session, parsed);
  });
  const sort = options.sort ?? "recent";
  if (sort === "threaded") return { sessions: sortSessionsThreaded(filtered), error: null };
  if (sort === "relevance") {
    return {
      sessions: [...filtered].sort(
        (left, right) =>
          relevanceScore(right, parsed) - relevanceScore(left, parsed) ||
          right.modified - left.modified,
      ),
      error: null,
    };
  }
  return { sessions: sortSessionsByRecency(filtered), error: null };
}

/** Search + recency ordering, the browser's default pipeline. */
export function filterSessions(
  sessions: readonly SessionSummary[],
  query: string,
): SessionSummary[] {
  return listSessions(sessions, { query }).sessions;
}

// ---------------------------------------------------------------------------
// Host-projected session list (the wire shape behind `session.list`)
// ---------------------------------------------------------------------------

/**
 * How many rows the host may return. The browser keeps the same working-set
 * bound as {@link MAX_SESSION_SUMMARIES}, but the byte budget below usually
 * stops earlier on very large profiles.
 */
export const MAX_SESSION_LIST_ROWS = MAX_SESSION_SUMMARIES;

/**
 * Hard budget for one projected page. It stays well below
 * `BLOB_SPILL_THRESHOLD_BYTES` (1 MiB) so `session.list` never takes the blob
 * path, no matter how much text the profile holds.
 */
export const MAX_SESSION_LIST_BYTES = 768 * 1024;

/** The host-side query accepted by `session.list`. */
export interface SessionListQuery extends SessionListOptions {
  /** Page size; clamped to {@link MAX_SESSION_LIST_ROWS}. */
  limit?: number;
  /** Bypass the control host's short catalog cache. */
  refresh?: boolean;
}

/**
 * One row on the wire. Deliberately smaller than {@link SessionSummary}: the
 * host keeps `firstMessage`, `allMessagesText` and `parentSessionPath` so the
 * payload does not grow with the size of the transcripts.
 */
export interface SessionListEntry {
  path: string;
  id: string;
  cwd: string;
  name: string | null;
  created: number;
  modified: number;
  messageCount: number;
  /** Already shortened by `sessionDisplayTitle` in the host. */
  title: string;
}

/** A bounded, filtered page of sessions. */
export interface SessionListPage<T = SessionSummary> {
  sessions: T[];
  /** Every session in the profile (before filtering). */
  total: number;
  /** Sessions matching the query/scope filters (before the page cap). */
  matched: number;
  /** Rows were dropped by the row/byte budget. */
  truncated: boolean;
  /** A query parse error (invalid `re:`), or null. */
  error: string | null;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function clampSessionListLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return MAX_SESSION_LIST_ROWS;
  return Math.min(Math.max(1, Math.floor(value)), MAX_SESSION_LIST_ROWS);
}

function toCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

/** The single row the host sends for one session. */
export function projectSessionListEntry(session: SessionSummary): SessionListEntry {
  const title = sessionDisplayTitle(session);
  return {
    path: session.path,
    id: session.id,
    cwd: session.cwd,
    // A `session_info` name is user text; keep one row from blowing the budget.
    name: session.name === null ? null : session.name.slice(0, 120),
    created: session.created,
    modified: session.modified,
    messageCount: session.messageCount,
    // A long `session_info` name is user text, so bound it like the first line.
    title: title.length > 90 ? `${title.slice(0, 89)}…` : title,
  };
}

/**
 * Filters/sorts the full listing in the host and projects a bounded page.
 *
 * Search runs over the full {@link SessionSummary} (including
 * `allMessagesText`), so a term deep in an old transcript is still found even
 * though the text never crosses the transport. Rows are added newest-first
 * until the row limit or the byte budget, whichever comes first.
 */
export function projectSessionListPage(
  all: readonly SessionSummary[],
  query: SessionListQuery = {},
): SessionListPage<SessionListEntry> {
  const total = all.length;
  const limit = clampSessionListLimit(query.limit);
  const { sessions: filtered, error } = listSessions(all, query);
  if (error) {
    return { sessions: [], total, matched: 0, truncated: false, error };
  }

  const sessions: SessionListEntry[] = [];
  let bytes = 0;
  for (const session of filtered.slice(0, limit)) {
    const entry = projectSessionListEntry(session);
    const size = utf8Bytes(JSON.stringify(entry)) + 1;
    // Always keep at least one row; after that the budget wins.
    if (sessions.length > 0 && bytes + size > MAX_SESSION_LIST_BYTES) break;
    sessions.push(entry);
    bytes += size;
  }

  return {
    sessions,
    total,
    matched: filtered.length,
    truncated: sessions.length < filtered.length,
    error: null,
  };
}

/** Parses untrusted `session.list` params; every field is optional. */
export function parseSessionListQuery(value: unknown): SessionListQuery {
  const record = asRecord(value);
  const query =
    typeof record.query === "string" ? record.query.slice(0, MAX_SESSION_TEXT) : undefined;
  const cwd = typeof record.cwd === "string" && record.cwd.length > 0 ? record.cwd : null;
  const sort: SessionSort =
    record.sort === "threaded" || record.sort === "relevance" ? record.sort : "recent";
  const limit = toCount(record.limit);
  return {
    ...(query === undefined ? {} : { query }),
    scope: record.scope === "current" ? "current" : "all",
    cwd,
    sort,
    namedOnly: record.namedOnly === true,
    ...(limit === null ? {} : { limit: clampSessionListLimit(limit) }),
    ...(record.refresh === true ? { refresh: true } : {}),
  };
}

/**
 * Parses an untrusted `session.list` response into the renderer's shape.
 *
 * Unlike `sanitizeSessionList`, this **throws** when `sessions` is not an
 * array. That is deliberate: a spilled `{ $blob }` response used to be
 * sanitized into `[]` and shown as an innocent empty profile. A malformed page
 * must surface instead.
 */
export function parseSessionListPage(value: unknown): SessionListPage {
  const record = asRecord(value);
  if (!Array.isArray(record.sessions)) {
    throw new Error("The host returned an unreadable session list.");
  }
  const sessions = sanitizeSessionList(record.sessions);
  return {
    sessions,
    total: toCount(record.total) ?? sessions.length,
    matched: toCount(record.matched) ?? sessions.length,
    truncated: record.truncated === true,
    error: typeof record.error === "string" && record.error.length > 0 ? record.error : null,
  };
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
  /** The entry's tree parent, so the view can fold a subtree (plan step 17). */
  parentId: string | null;
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
      // Tool calls are part of what the row is about: Pi's tree search matches a
      // tool name and its arguments too (plan step 17).
      const parts: string[] = [];
      for (const block of content) {
        const record = asRecord(block);
        if (record.type === "text") parts.push(String(record.text ?? ""));
        else if (record.type === "toolCall") {
          parts.push(`${String(record.name ?? "")} ${stringOrText(record.arguments)}`);
        }
      }
      return parts.join(" ").replace(/\s+/g, " ").trim();
    }
    return "";
  }
  if (role === "bashExecution") {
    return `$ ${String(message.command ?? "")} ${stringOrText(message.output)}`
      .replace(/\s+/g, " ")
      .trim();
  }
  if (role === "custom" || role === "custom_message") {
    return stringOrText(message.content);
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
  // A tool call's arguments arrive as an object; search should still find the
  // path/pattern the row is about.
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value).replace(/\s+/g, " ").trim();
    } catch {
      return "";
    }
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
  const walk = (nodes: unknown, depth: number, parentId: string | null): void => {
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
          parentId,
          timestamp: toEpoch(entry.timestamp),
          leaf: id === leafId,
        });
      }
      walk(node.children, depth + 1, id ?? parentId);
    }
  };
  walk(tree, 0, null);
  return rows;
}

// ---------------------------------------------------------------------------
// Session tree view (plan step 17)
// ---------------------------------------------------------------------------

/** Terminal Pi's tree filters (`tree-filter.js`). */
export type SessionTreeFilter = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

export const SESSION_TREE_FILTERS: readonly SessionTreeFilter[] = [
  "default",
  "no-tools",
  "user-only",
  "labeled-only",
  "all",
];

/** True when a row type is a tool-ish entry the `default` filter hides. */
function isToolRow(row: SessionTreeRow): boolean {
  return row.type === "tool" || row.role === "toolResult" || row.role === "bashExecution";
}

/** Applies one of Pi's tree filters. */
export function filterSessionTreeRows(
  rows: readonly SessionTreeRow[],
  filter: SessionTreeFilter,
): SessionTreeRow[] {
  switch (filter) {
    case "all":
      return [...rows];
    case "user-only":
      return rows.filter((row) => row.role === "user");
    case "labeled-only":
      return rows.filter((row) => row.label !== null);
    case "no-tools":
      return rows.filter((row) => !isToolRow(row) || row.leaf);
    default:
      // `default` keeps the conversation shape: no assistant tool-only rows and
      // no bare bash rows, unless the row is the leaf or carries an error.
      return rows.filter((row) => !isToolRow(row) || row.leaf || /error|cancel/i.test(row.text));
  }
}

/** Case-insensitive search over the label and the row's visible text. */
export function sessionTreeRowMatches(row: SessionTreeRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return `${row.label ?? ""}
${row.text}
${row.type}
${row.role ?? ""}`
    .toLowerCase()
    .includes(needle);
}

/**
 * The rows the tree actually draws: filtered, searched, and with the descendants
 * of every folded entry removed. Folding is by id, so a filtered-out parent can
 * still hide its children (they are hidden with it).
 */
export function visibleSessionTreeRows(
  rows: readonly SessionTreeRow[],
  options: {
    filter?: SessionTreeFilter;
    query?: string;
    folded?: ReadonlySet<string>;
  } = {},
): SessionTreeRow[] {
  const filtered = filterSessionTreeRows(rows, options.filter ?? "default");
  const query = options.query ?? "";
  const folded = options.folded ?? new Set<string>();
  // A row is hidden when any ancestor (by id) is folded, even if that ancestor
  // was filtered out: the subtree belongs to it.
  const foldedAncestors = new Set<string>();
  const visible: SessionTreeRow[] = [];
  const allById = new Map(rows.map((row) => [row.id, row]));
  const isHiddenByFold = (row: SessionTreeRow): boolean => {
    let parentId = row.parentId;
    const seen = new Set<string>();
    while (parentId) {
      if (seen.has(parentId)) break;
      seen.add(parentId);
      if (folded.has(parentId) || foldedAncestors.has(parentId)) return true;
      parentId = allById.get(parentId)?.parentId ?? null;
    }
    return false;
  };
  for (const row of filtered) {
    if (isHiddenByFold(row)) {
      foldedAncestors.add(row.id);
      continue;
    }
    if (query.length > 0 && !sessionTreeRowMatches(row, query)) continue;
    visible.push(row);
  }
  return visible;
}

/** The ids of a row's visible children, for the fold caret's state. */
export function sessionTreeHasChildren(rows: readonly SessionTreeRow[], id: string): boolean {
  return rows.some((row) => row.parentId === id);
}
