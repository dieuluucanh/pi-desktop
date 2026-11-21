/**
 * Generic extension contribution view model (v1).
 *
 * The wire contract lives in `extension-contributions.ts` (validated envelopes).
 * This module turns the host registry into one renderer-safe snapshot:
 *
 *   - contributions are grouped by owner and ordered deterministically
 *     (owner `order`, then owner id, then contribution id);
 *   - actions carry only a command name that the host will re-validate;
 *   - nothing here is extension-specific, so the renderer never learns
 *     "workflow", "review" or "orchestrator".
 *
 * The snapshot is also what the host returns over `contributions.state`, so the
 * renderer and any RPC client see the same data.
 */

import {
  sortContributions,
  type Contribution,
  type ContributionEnvelope,
  type ContributionKind,
  type ContributionSlot,
  type ContributionTone,
  type InputAvailability,
  type SessionRelation,
} from "./extension-contributions";

export const CONTRIBUTION_SNAPSHOT_VERSION = 1 as const;

export interface ContributionView {
  ownerId: string;
  id: string;
  kind: ContributionKind;
  slot: ContributionSlot;
  tone: ContributionTone;
  order: number;
  /** Mode/progress/status/action label or text. */
  text: string;
  /** Secondary line (mode/progress detail, action description). */
  detail?: string;
  /** Progress only. */
  done?: number;
  total?: number;
  stale?: boolean;
  /** Input only. */
  availability?: InputAvailability;
  /** Related-session only. */
  relation?: SessionRelation;
  sessionRef?: string;
  focusable?: boolean;
  /** Action command, when the contribution is actionable. */
  command?: { name: string; args?: string };
  enabled: boolean;
  disabledReason?: string;
}

export interface ContributionOwnerView {
  ownerId: string;
  revision: number;
  epoch: number;
}

export interface ContributionSnapshot {
  version: typeof CONTRIBUTION_SNAPSHOT_VERSION;
  supported: boolean;
  /** Why contributions are absent, when `supported` is false. */
  reason?: string;
  owners: ContributionOwnerView[];
  contributions: ContributionView[];
  updatedAt: number;
}

export const EMPTY_CONTRIBUTION_SNAPSHOT: ContributionSnapshot = {
  version: CONTRIBUTION_SNAPSHOT_VERSION,
  supported: false,
  reason: "no host contribution registry",
  owners: [],
  contributions: [],
  updatedAt: 0,
};

/** One registry entry, as the host stores it. */
export interface ContributionRegistryEntry {
  ownerId: string;
  epoch: number;
  revision: number;
  contributions: Contribution[];
}

function toView(ownerId: string, contribution: Contribution): ContributionView {
  const base = {
    ownerId,
    id: contribution.id,
    kind: contribution.kind,
    slot: contribution.slot,
    tone: contribution.tone,
    order: contribution.order,
    enabled: true,
  };
  switch (contribution.kind) {
    case "mode":
      return {
        ...base,
        text: contribution.label,
        ...(contribution.detail === undefined ? {} : { detail: contribution.detail }),
      };
    case "progress":
      return {
        ...base,
        text: contribution.label,
        done: contribution.done,
        total: contribution.total,
        ...(contribution.stale === true ? { stale: true } : {}),
        ...(contribution.detail === undefined ? {} : { detail: contribution.detail }),
      };
    case "status":
      return { ...base, text: contribution.text };
    case "action":
      return {
        ...base,
        text: contribution.label,
        ...(contribution.description === undefined ? {} : { detail: contribution.description }),
        command: { ...contribution.command },
        enabled: contribution.enabled,
        ...(contribution.disabledReason === undefined
          ? {}
          : { disabledReason: contribution.disabledReason }),
      };
    case "input":
      return {
        ...base,
        text: contribution.availability,
        availability: contribution.availability,
        ...(contribution.reason === undefined ? {} : { detail: contribution.reason }),
      };
    case "related-session":
      return {
        ...base,
        text: contribution.title,
        relation: contribution.relation,
        sessionRef: contribution.sessionRef,
        focusable: contribution.focusable,
      };
    default:
      return { ...base, text: "" };
  }
}

/**
 * Builds the merged snapshot. Owners with no contributions are omitted; the
 * snapshot is deterministic for a given registry state.
 */
export function buildContributionSnapshot(
  entries: readonly ContributionRegistryEntry[],
  options: {
    supported: boolean;
    reason?: string;
    updatedAt: number;
  },
): ContributionSnapshot {
  const flat: Array<{ ownerId: string; contribution: Contribution }> = [];
  for (const entry of entries) {
    for (const contribution of entry.contributions) {
      flat.push({ ownerId: entry.ownerId, contribution });
    }
  }
  const ordered = sortContributions(flat);
  return {
    version: CONTRIBUTION_SNAPSHOT_VERSION,
    supported: options.supported,
    ...(options.supported
      ? {}
      : { reason: options.reason ?? "host does not support contributions" }),
    owners: [...entries]
      .filter((entry) => entry.contributions.length > 0)
      .sort((a, b) => a.ownerId.localeCompare(b.ownerId))
      .map((entry) => ({ ownerId: entry.ownerId, revision: entry.revision, epoch: entry.epoch })),
    contributions: ordered.map((item) => toView(item.ownerId, item.contribution)),
    updatedAt: options.updatedAt,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, max = 400): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : undefined;
}

/**
 * Sanitizes a snapshot crossing the IPC frame (or restored from a stale tab).
 * Unknown kinds are dropped, actions keep only a plain command name, and no
 * field can carry executable content.
 */
export function sanitizeContributionSnapshot(value: unknown): ContributionSnapshot {
  const record = asRecord(value);
  if (record.version !== CONTRIBUTION_SNAPSHOT_VERSION) return EMPTY_CONTRIBUTION_SNAPSHOT;
  const contributions: ContributionView[] = [];
  if (Array.isArray(record.contributions)) {
    for (const raw of record.contributions) {
      const entry = asRecord(raw);
      const ownerId = asString(entry.ownerId, 80);
      const id = asString(entry.id, 96);
      const text = asString(entry.text, 1_200);
      if (!ownerId || !id || text === undefined) continue;
      const kind = entry.kind;
      if (
        kind !== "mode" &&
        kind !== "progress" &&
        kind !== "status" &&
        kind !== "action" &&
        kind !== "input" &&
        kind !== "related-session"
      ) {
        continue;
      }
      const command = asRecord(entry.command);
      const commandName = asString(command.name, 64);
      contributions.push({
        ownerId,
        id,
        kind,
        slot: (asString(entry.slot, 20) ?? kind) as ContributionView["slot"],
        tone: (asString(entry.tone, 20) ?? "neutral") as ContributionView["tone"],
        order: typeof entry.order === "number" && Number.isFinite(entry.order) ? entry.order : 0,
        text,
        ...(asString(entry.detail, 1_200) === undefined
          ? {}
          : { detail: asString(entry.detail, 1_200) as string }),
        ...(typeof entry.done === "number" ? { done: entry.done } : {}),
        ...(typeof entry.total === "number" ? { total: entry.total } : {}),
        ...(entry.stale === true ? { stale: true } : {}),
        // `enabled` is required on the view: absent means "not disabled", which
        // matches the wire default and keeps a sanitized row renderable.
        enabled: entry.enabled !== false,
        ...(asString(entry.disabledReason, 400) === undefined
          ? {}
          : { disabledReason: asString(entry.disabledReason, 400) as string }),
        ...(commandName === undefined ? {} : { command: { name: commandName } }),
      });
    }
  }
  const owners: ContributionOwnerView[] = [];
  if (Array.isArray(record.owners)) {
    for (const raw of record.owners) {
      const entry = asRecord(raw);
      const ownerId = asString(entry.ownerId, 80);
      if (!ownerId) continue;
      owners.push({
        ownerId,
        revision: typeof entry.revision === "number" ? entry.revision : 0,
        epoch: typeof entry.epoch === "number" ? entry.epoch : 0,
      });
    }
  }
  return {
    version: CONTRIBUTION_SNAPSHOT_VERSION,
    supported: record.supported === true,
    ...(asString(record.reason, 400) === undefined
      ? {}
      : { reason: asString(record.reason, 400) as string }),
    owners,
    contributions,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
  };
}

/** Convenience: every mode contribution (for a composer badge). */
export function contributionViewsBySlot(
  snapshot: ContributionSnapshot,
  slot: ContributionSlot,
): ContributionView[] {
  return snapshot.contributions.filter((entry) => entry.slot === slot);
}

export type { ContributionEnvelope };

/**
 * One generic bar row the renderer can draw without knowing the extension.
 *
 * The badge is a single line (mode, else progress, else status); the remaining
 * contributions are rows/actions. Nothing here is extension-specific, so an
 * arbitrary publisher gets the same UI.
 */
export interface ContributionBarModel {
  badge: ContributionView | null;
  rows: ContributionView[];
  actions: ContributionView[];
  inputs: ContributionView[];
  sessions: ContributionView[];
}

const SLOT_RANK: Record<ContributionSlot, number> = {
  mode: 0,
  progress: 1,
  status: 2,
  action: 3,
  input: 4,
  sessions: 5,
};

export function buildContributionBar(snapshot: ContributionSnapshot): ContributionBarModel {
  const ordered = [...snapshot.contributions].sort(
    (a, b) => SLOT_RANK[a.slot] - SLOT_RANK[b.slot] || a.order - b.order,
  );
  const modes = ordered.filter((entry) => entry.slot === "mode");
  const progress = ordered.filter((entry) => entry.slot === "progress");
  const statuses = ordered.filter((entry) => entry.slot === "status");
  // Exactly one badge, chosen by priority; everything else stays visible.
  const badge = modes[0] ?? progress[0] ?? statuses[0] ?? null;
  const rows = ordered.filter(
    (entry) =>
      entry !== badge &&
      (entry.slot === "mode" || entry.slot === "progress" || entry.slot === "status"),
  );
  return {
    badge,
    rows,
    actions: ordered.filter((entry) => entry.slot === "action"),
    inputs: ordered.filter((entry) => entry.slot === "input"),
    sessions: ordered.filter((entry) => entry.slot === "sessions"),
  };
}

/** Stable DOM key for a contribution row (owner-namespaced). */
export function contributionKey(entry: ContributionView): string {
  return `${entry.ownerId}:${entry.id}`;
}

/**
 * The strongest input state any publisher declared, if one did.
 *
 * `locked` wins over `restricted`, which wins over `available`. A host uses this
 * instead of parsing a status line: the extension itself says whether a surface
 * owns the turn.
 */
export function contributionInputAvailability(
  snapshot: ContributionSnapshot | undefined,
): InputAvailability | null {
  if (!snapshot) return null;
  let seen: InputAvailability | null = null;
  for (const entry of snapshot.contributions) {
    if (entry.kind !== "input") continue;
    const availability = entry.availability;
    if (availability === "locked") return "locked";
    if (availability === "restricted") seen = "restricted";
    else if (seen === null) seen = "available";
  }
  return seen;
}

/** True when a published input contribution refuses ordinary prose. */
export function contributionInputLocked(snapshot: ContributionSnapshot | undefined): boolean {
  return contributionInputAvailability(snapshot) === "locked";
}
