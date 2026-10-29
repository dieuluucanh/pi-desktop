/**
 * The Office **pane registry** (plan step 20).
 *
 * The bridge extension (`@dieulc/pi-office-bridge`) owns the live registry of
 * attached Office task panes and publishes it on `GET /health` as `panes[]`.
 * This module is the pure, shared reading of that payload: the Documents panel,
 * the `#` completion source and the office tool cards all derive from these
 * types, and the main process only has to hand them a `/health` snapshot.
 *
 * Nothing here imports Electron or the host, and nothing throws on a malformed
 * pane: a version-skewed bridge must degrade to "fewer facts", never to a crash.
 */

import { PI_OFFICE_BRIDGE, officeHostLabel, type OfficeHost } from "./office";
import { projectBridgeCompatibility, type BridgeCompatibility } from "./office-bridge";
import type { TabRecord } from "./session-ipc";

/** One attached task pane, as the Documents panel and the completion source see it. */
export interface OfficeDocumentPane {
  /** Host app the pane belongs to, or null when the bridge did not say. */
  host: OfficeHost | null;
  /** Human-readable host label ("Excel", "Word", "PowerPoint", "Office"). */
  hostLabel: string;
  paneId: string | null;
  clientName: string | null;
  /** Stable document id hash (`url_sha256:…`), or null for an unsaved document. */
  documentId: string | null;
  documentName: string | null;
  /** Server routing key (stable id, or an ephemeral per-connection id). */
  targetId: string | null;
  focused: boolean;
  visible: boolean;
  /** How many attached windows show the same document (`>1` = same file twice). */
  windows: number;
  /** Ops the pane advertised; empty for a legacy pane (v1 op set only). */
  ops: string[];
  catalogVersion: number | null;
  protocolVersion: number | null;
  /** Ops the server dropped because this app does not know them. */
  opsIgnoredCount: number;
  /** Epoch ms the pane attached, or null when unknown. */
  connectedAt: number | null;
  /** Epoch ms of the last frame from the pane, or null when unknown. */
  lastSeen: number | null;
  model: string | null;
  provider: string | null;
  /**
   * What a `#` mention inserts for this pane: the name when it is unique among
   * the attached documents, otherwise the id (so the mention stays unambiguous).
   */
  mention: string;
}

/** The Documents panel's whole world: one `/health` probe, projected. */
export interface OfficeDocumentsView {
  /** True when the bridge answered `/health` (even with zero panes). */
  available: boolean;
  /** The port probed — the Office host's bridge port (`PI_OFFICE_BRIDGE.defaultPort`). */
  port: number;
  /** The probe result: `ok`, `unreachable`, `not-our-bridge`, `invalid-response`. */
  status: string;
  serverVersion: string | null;
  protocolVersion: number | null;
  catalogVersion: number | null;
  /** Version-skew verdict (streamed deltas, pane-side Stop). */
  compatibility: BridgeCompatibility | null;
  panes: OfficeDocumentPane[];
  /** ISO timestamp of the probe. */
  fetchedAt: string;
  /** Probe failure detail, or null when the probe succeeded. */
  error: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asHost(value: unknown): OfficeHost | null {
  return value === "excel" || value === "word" || value === "powerpoint" ? value : null;
}

function asOps(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * What a `#` mention inserts: `#<name>` when the name is unique among the
 * attached documents, otherwise `#<id>` (mirrors the bridge's own mention
 * provider, `document-mentions.ts`). Focused panes are not special-cased here —
 * ranking happens in the completion source.
 */
export function documentMentionValue(
  pane: Pick<OfficeDocumentPane, "documentId" | "targetId" | "documentName">,
  all: readonly Pick<OfficeDocumentPane, "documentName">[],
): string {
  const name = pane.documentName;
  const id = pane.documentId ?? pane.targetId;
  if (name !== null && name.length > 0) {
    const key = name.toLowerCase();
    const count = all.filter((entry) => entry.documentName?.toLowerCase() === key).length;
    if (count <= 1) return name;
  }
  return id ?? name ?? "untitled";
}

/** Parse one `/health` pane entry. Returns null only when the entry is not an object. */
export function parseOfficeDocumentPane(
  value: unknown,
  all: readonly unknown[] = [],
): OfficeDocumentPane | null {
  const pane = asRecord(value);
  if (!pane) return null;
  const document = asRecord(pane.document);
  const documentId = asString(document?.id) ?? asString(pane.documentId);
  const documentName = asString(document?.name) ?? asString(pane.documentName);
  const targetId = asString(pane.targetId);
  const host = asHost(pane.host);
  const ops = asOps(pane.ops);

  // Names are counted across the whole payload, so build the raw name list from
  // whatever the caller passed (already-parsed panes or raw entries).
  const names = all.map((entry) => {
    const record = asRecord(entry);
    const doc = asRecord(record?.document);
    return asString(doc?.name) ?? asString(record?.documentName);
  });

  const mention = documentMentionValue(
    { documentId, documentName, targetId },
    names.map((name) => ({ documentName: name })),
  );

  return {
    host,
    hostLabel: host ? officeHostLabel(host) : "Office",
    paneId: asString(pane.paneId),
    clientName: asString(pane.clientName),
    documentId,
    documentName,
    targetId,
    focused: asBoolean(pane.focused),
    visible: asBoolean(pane.visible),
    windows: Math.max(1, asNumber(pane.windows) ?? 1),
    ops,
    catalogVersion: asNumber(pane.catalogVersion),
    protocolVersion: asNumber(pane.protocolVersion),
    opsIgnoredCount: Math.max(0, asNumber(pane.opsIgnoredCount) ?? 0),
    connectedAt: asNumber(pane.connectedAt),
    lastSeen: asNumber(pane.lastSeen),
    model: asString(pane.model),
    provider: asString(pane.provider),
    mention,
  };
}

/**
 * Project a bridge `/health` payload into the Documents view. `status` is the
 * probe's own verdict; a payload is only parsed when the probe called it `ok`.
 */
export function parseOfficeDocumentsView(input: {
  payload: unknown;
  status: string;
  port?: number;
  error?: string | null;
  fetchedAt: string;
}): OfficeDocumentsView {
  const port = input.port ?? PI_OFFICE_BRIDGE.defaultPort;
  const root = asRecord(input.payload);
  const rawPanes = root && Array.isArray(root.panes) ? root.panes : [];
  const panes: OfficeDocumentPane[] = [];
  for (const entry of rawPanes) {
    const pane = parseOfficeDocumentPane(entry, rawPanes);
    if (pane) panes.push(pane);
  }

  const capabilities = root && Array.isArray(root.capabilities) ? asOps(root.capabilities) : null;
  const protocolVersion = root ? asNumber(root.protocolVersion) : null;
  const catalogVersion = root ? asNumber(root.catalogVersion) : null;
  const serverVersion = root
    ? (asString(root.serverVersion) ?? asString(root.serviceVersion))
    : null;
  const available = input.status === "ok" && root !== null;

  return {
    available,
    port,
    status: input.status,
    serverVersion,
    protocolVersion,
    catalogVersion,
    compatibility: available
      ? projectBridgeCompatibility({
          protocolVersion,
          capabilities,
          serverVersion,
          catalogVersion,
        })
      : null,
    panes,
    fetchedAt: input.fetchedAt,
    error: input.error ?? null,
  };
}

/** The view before the first probe: not available, no panes. */
export function emptyOfficeDocumentsView(
  port: number = PI_OFFICE_BRIDGE.defaultPort,
): OfficeDocumentsView {
  return {
    available: false,
    port,
    status: "unknown",
    serverVersion: null,
    protocolVersion: null,
    catalogVersion: null,
    compatibility: null,
    panes: [],
    fetchedAt: new Date(0).toISOString(),
    error: null,
  };
}

/**
 * The document tag a "chat about this document" prompt carries. It matches
 * `formatDocumentTag` in the bridge's `pane-replies.ts`
 * (`[office:excel "Book1.xlsx" id=url_sha256:…]`) so the shared conversation
 * shows which document a message came from and the model can reuse the id as a
 * `document` target.
 */
export function officeDocumentTag(
  pane: Pick<OfficeDocumentPane, "host" | "documentName" | "documentId" | "targetId">,
): string | null {
  if (!pane.host) return null;
  const label = pane.documentName ?? "untitled";
  const id = pane.documentId ?? pane.targetId;
  return `[office:${pane.host} "${label}"${id === null ? "" : ` id=${id}`}]`;
}

/** "just now", "12s ago", "3m ago", "2h ago" from a `lastSeen` timestamp. */
export function formatPaneAge(lastSeen: number | null, now: number = Date.now()): string {
  if (lastSeen === null) return "unknown";
  const seconds = Math.max(0, Math.floor((now - lastSeen) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Short display form of a document id (`url_sha256:abcd…` → `abcd…`). */
export function shortDocumentId(id: string | null): string {
  if (id === null || id.length === 0) return "—";
  const raw = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
  return raw.slice(0, 8);
}

/** The structural shape the `#` completion source consumes. */
export interface DocumentMentionEntry {
  id: string;
  name: string;
  kind?: string;
  description?: string;
}

/**
 * Turn the pane registry into `#` completion entries: focused documents first,
 * then by name (mirrors the bridge's own mention ordering). The `name` is the
 * pane's mention value, so an ambiguous name falls back to the id.
 */
export function toDocumentMentions(panes: readonly OfficeDocumentPane[]): DocumentMentionEntry[] {
  return [...panes]
    .sort((a, b) => {
      if (a.focused !== b.focused) return a.focused ? -1 : 1;
      return (a.documentName ?? "").localeCompare(b.documentName ?? "");
    })
    .map((pane) => {
      const notes = [
        pane.hostLabel,
        pane.focused ? "focused" : null,
        pane.windows > 1 ? `${pane.windows} windows` : null,
      ].filter((note): note is string => note !== null);
      return {
        id: pane.documentId ?? pane.targetId ?? pane.mention,
        name: pane.mention,
        kind: pane.hostLabel,
        ...(notes.length > 0 ? { description: notes.join(" · ") } : {}),
      };
    });
}

/**
 * The `office_<host>_<op>` tool name for a catalog entry, and its inverse.
 * Mirrors `officeToolName`/`hostForToolName` in the bridge's catalog adapter.
 */
export function officeToolTarget(toolName: string): { host: OfficeHost; op: string } | null {
  const match = /^office_(excel|word|powerpoint)_(.+)$/.exec(toolName);
  const host = match?.[1];
  const rest = match?.[2];
  if (!host || !rest) return null;
  return { host: host as OfficeHost, op: `${host}.${rest}` };
}

/** How an office tool call relates to the attached panes' advertised ops. */
export type OfficeToolCapability = "advertised" | "legacy" | "gated" | "unattached" | "unknown";

/**
 * Whether an office tool call was capability-gated: the tool is only active for
 * ops the attached pane advertised (`active-tools.ts` in the bridge), so a call
 * against a legacy pane runs the v1 op set and a call with no matching op would
 * not have been offered at all.
 */
export function officeToolCapability(
  toolName: string,
  panes: readonly Pick<OfficeDocumentPane, "host" | "ops">[],
): OfficeToolCapability {
  const target = officeToolTarget(toolName);
  if (!target) return "unknown";
  const hostPanes = panes.filter((pane) => pane.host === target.host);
  if (hostPanes.length === 0) return "unattached";
  if (hostPanes.some((pane) => pane.ops.includes(target.op))) return "advertised";
  if (hostPanes.some((pane) => pane.ops.length === 0)) return "legacy";
  return "gated";
}

/** One-line, user-facing explanation of an office tool call's capability state. */
export function officeCapabilityLabel(state: OfficeToolCapability): string | null {
  switch (state) {
    case "advertised":
      return null;
    case "legacy":
      return "legacy pane (v1 ops)";
    case "gated":
      return "op not advertised by the attached pane";
    case "unattached":
      return "no document attached";
    case "unknown":
      return null;
  }
}

/**
 * Resolve the document a call targets, for the tool card's chip. `"active"` (or
 * an absent argument) means the focused pane of that host; an explicit value is
 * matched by id, target id, or name (case-insensitive) against the registry.
 */
export function resolveToolDocument(
  toolName: string,
  args: unknown,
  panes: readonly OfficeDocumentPane[],
): { label: string; pane: OfficeDocumentPane | null; explicit: boolean } | null {
  const target = officeToolTarget(toolName);
  if (!target) return null;
  const record = asRecord(args);
  const requested = asString(record?.document);
  const explicit = requested !== null && requested.toLowerCase() !== "active";
  const hostPanes = panes.filter((pane) => pane.host === target.host);

  if (!explicit) {
    const focused = hostPanes.find((pane) => pane.focused) ?? null;
    return { label: focused?.documentName ?? "active document", pane: focused, explicit: false };
  }

  const needle = requested.toLowerCase();
  const pane =
    hostPanes.find(
      (entry) =>
        entry.documentId?.toLowerCase() === needle ||
        entry.targetId?.toLowerCase() === needle ||
        entry.documentName?.toLowerCase() === needle,
    ) ?? null;
  return { label: pane?.documentName ?? requested, pane, explicit: true };
}

/**
 * Parse the `office_list_documents` result (a markdown table the bridge emits)
 * into rows so the tool card can render it as a table with per-row actions.
 */
export interface OfficeDocumentListRow {
  document: string;
  id: string;
  host: string;
  focused: boolean;
  windows: number;
}

export function parseDocumentListTable(text: string): OfficeDocumentListRow[] {
  const rows: OfficeDocumentListRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;
    const cells = trimmed
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length < 5) continue;
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue; // separator
    const [document, id, host, focused, windows] = cells;
    if (document === undefined || document === "document") continue; // header
    rows.push({
      document,
      id: (id ?? "").replace(/^`|`$/g, ""),
      host: host ?? "",
      focused: focused === "yes",
      windows: Number.parseInt(windows ?? "1", 10) || 1,
    });
  }
  return rows;
}

/**
 * Which tab owns bridge port 38617 — the **Office host**.
 *
 * Main reserves that port for the single `office`-kind tab (`host-supervisor`),
 * and promotes one tab at a time (`session-service` demotes every other `office`
 * tab when promotion happens). The renderer needs the same rule to answer "is
 * *this* session the one that can serve an `office_*` call?", so it lives here
 * rather than as a third copy of the predicate.
 *
 * `status !== "stopped"` matters: a stopped tab keeps its record (and its kind)
 * until it is closed, but it no longer holds the port, so it is not a host. Note
 * a `crashed`/`failed` tab is still the host — it is assigned the port, and
 * whether its process currently answers is a different question from identity.
 */
export function officeHostTab(
  tabs: readonly Pick<TabRecord, "id" | "kind" | "cwd" | "title" | "status">[],
): Pick<TabRecord, "id" | "kind" | "cwd" | "title" | "status"> | null {
  return tabs.find((tab) => tab.kind === "office" && tab.status !== "stopped") ?? null;
}

/** The Office host, as the Documents scope line renders it. */
export interface OfficeHostInfo {
  id: string;
  title: string;
  /** The folder the host session works in — where its documents live. */
  projectPath: string;
  status: TabRecord["status"];
}

export interface OfficeDocumentScope {
  /** The host tab, or null when no session holds the bridge. */
  host: OfficeHostInfo | null;
  /** True when the **active** tab is the host, i.e. its `office_*` calls land. */
  isHost: boolean;
}

/**
 * Resolve the Documents menu's scope for the active tab.
 *
 * Since the bridge is app-wide but a *session* is what runs the tools, there are
 * three states worth distinguishing, and this projection separates the middle
 * one from nothing: a host exists and you are it, a host exists and you are not,
 * and no host exists at all. The last one is the only case where "start a
 * session" is the useful action.
 */
export function officeDocumentScope(
  _panes: readonly OfficeDocumentPane[],
  tabs: readonly Pick<TabRecord, "id" | "kind" | "cwd" | "title" | "status">[],
  activeTabId: string | null,
): OfficeDocumentScope {
  const host = officeHostTab(tabs);
  if (!host) return { host: null, isHost: false };
  return {
    host: { id: host.id, title: host.title, projectPath: host.cwd, status: host.status },
    isHost: activeTabId !== null && host.id === activeTabId,
  };
}

/**
 * The `#` completion entries for the **active** session.
 *
 * Only the host session can serve an `office_*` call: the tool reaches whichever
 * host owns port 38617, so in any other tab a mention would tag a prompt the
 * bridge never answers. A list that offers what cannot work is worse than an
 * empty one, so a non-host session gets `[]` and the UI explains why (plan D10).
 */
export function documentMentionsForHost(
  panes: readonly OfficeDocumentPane[],
  tabs: readonly Pick<TabRecord, "id" | "kind" | "cwd" | "title" | "status">[],
  activeTabId: string | null,
): DocumentMentionEntry[] {
  const { isHost } = officeDocumentScope(panes, tabs, activeTabId);
  return isHost ? toDocumentMentions(panes) : [];
}
