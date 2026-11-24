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
  type ContributionKind,
  type ContributionSlot,
  type ContributionTone,
  type InputAvailability,
  type SessionRelation,
} from "./extension-contributions";
import {
  COMPOSER_CONTROL_BEHAVIORS,
  COMPOSER_CONTROL_ICONS,
  COMPOSER_CONTROL_KIND,
  COMPOSER_CONTROL_SLOT,
  type ComposerControlBehavior,
  type ComposerControlIcon,
} from "./composer-transform";

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
  /** Mode/composer-control only: id of the same-owner action that activates this label. */
  actionRef?: string;
  /** Composer-control only: same-owner action that starts the transform. */
  transformActionRef?: string;
  /** Composer-control only: presentation state (never a command). */
  checked?: boolean;
  icon?: ComposerControlIcon;
  behavior?: ComposerControlBehavior;
  /** Related-session only. */
  relation?: SessionRelation;
  sessionRef?: string;
  focusable?: boolean;
  /**
   * Action command name, when the contribution is actionable. Renderer
   * snapshots never carry `command.args`: the host re-resolves the live action
   * (and its arguments) from its own registry before executing anything.
   */
  command?: { name: string };
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
        ...(contribution.actionRef === undefined ? {} : { actionRef: contribution.actionRef }),
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
        command: { name: contribution.command.name },
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
    case COMPOSER_CONTROL_KIND:
      return {
        ...base,
        text: contribution.label,
        ...(contribution.description === undefined ? {} : { detail: contribution.description }),
        ...(contribution.icon === undefined ? {} : { icon: contribution.icon }),
        ...(contribution.behavior === undefined ? {} : { behavior: contribution.behavior }),
        checked: contribution.checked,
        enabled: contribution.enabled,
        ...(contribution.disabledReason === undefined
          ? {}
          : { disabledReason: contribution.disabledReason }),
        actionRef: contribution.actionRef,
        transformActionRef: contribution.transformActionRef,
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

const INPUT_AVAILABILITIES = ["available", "restricted", "locked"] as const;
const SESSION_RELATIONS = ["parent", "child", "sibling"] as const;

function asAvailability(value: unknown): ContributionView["availability"] | undefined {
  return typeof value === "string" && (INPUT_AVAILABILITIES as readonly string[]).includes(value)
    ? (value as ContributionView["availability"])
    : undefined;
}

function asRelation(value: unknown): ContributionView["relation"] | undefined {
  return typeof value === "string" && (SESSION_RELATIONS as readonly string[]).includes(value)
    ? (value as ContributionView["relation"])
    : undefined;
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
        kind !== "related-session" &&
        kind !== COMPOSER_CONTROL_KIND
      ) {
        continue;
      }
      const command = asRecord(entry.command);
      const commandName = asString(command.name, 64);
      // A mode action reference is an id, never a command: the host resolves the
      // live action (and refuses a missing/other-owner one) at run time.
      const actionRef = asString(entry.actionRef, 96);
      const transformActionRef = asString(entry.transformActionRef, 96);
      const icon = asString(entry.icon, 24);
      const behavior = asString(entry.behavior, 24);
      const availability = asAvailability(entry.availability);
      const relation = asRelation(entry.relation);
      const sessionRef = asString(entry.sessionRef, 400);
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
        ...((kind === "mode" || kind === COMPOSER_CONTROL_KIND) && actionRef !== undefined
          ? { actionRef }
          : {}),
        ...(kind !== COMPOSER_CONTROL_KIND
          ? {}
          : {
              ...(transformActionRef === undefined ? {} : { transformActionRef }),
              checked: entry.checked === true,
              ...(icon !== undefined && (COMPOSER_CONTROL_ICONS as readonly string[]).includes(icon)
                ? { icon: icon as ComposerControlIcon }
                : {}),
              ...(behavior !== undefined &&
              (COMPOSER_CONTROL_BEHAVIORS as readonly string[]).includes(behavior)
                ? { behavior: behavior as ComposerControlBehavior }
                : {}),
            }),
        ...(typeof entry.done === "number" ? { done: entry.done } : {}),
        ...(typeof entry.total === "number" ? { total: entry.total } : {}),
        ...(entry.stale === true ? { stale: true } : {}),
        ...(availability === undefined ? {} : { availability }),
        ...(relation === undefined ? {} : { relation }),
        ...(sessionRef === undefined ? {} : { sessionRef }),
        ...(entry.focusable === true ? { focusable: true } : {}),
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

export interface ContributionModeAction {
  /** Owner of the mode and of the referenced action (always the same). */
  ownerId: string;
  /** The referenced action contribution id. */
  id: string;
  /** The publisher's action label, used as the control's accessible action. */
  text: string;
  detail?: string;
  enabled: boolean;
  disabledReason?: string;
}

/**
 * One deterministic presentation resolved from a validated snapshot.
 *
 * - `mode` is identity only: a mode contribution, never a progress/status row
 *   promoted into a mode. The composer binds its label and tone to it.
 * - `modeAction` is the mode's optional same-owner activation, resolved from a
 *   live top-level action. It carries no command: the host re-validates the
 *   action and command when it runs.
 * - `rows` keep every progress/status/secondary-mode row visible, including
 *   those from unrelated owners. Nothing is filtered by label, owner or
 *   command name.
 * - `actions` excludes the mode action only when the corner control consumes
 *   it, so a publisher never shows the same control twice.
 */
export interface ContributionBarModel {
  mode: ContributionView | null;
  modeAction: ContributionModeAction | null;
  rows: ContributionView[];
  actions: ContributionView[];
  inputs: ContributionView[];
  sessions: ContributionView[];
  /**
   * Additive `composer-control` contributions, renderer-safe (no command, no
   * operation metadata). The composer-actions row renders these; an older
   * Desktop simply never receives the kind.
   */
  composerControls: ContributionView[];
}

const SLOT_RANK: Record<ContributionSlot, number> = {
  mode: 0,
  progress: 1,
  status: 2,
  action: 3,
  input: 4,
  sessions: 5,
  // Composer controls are projected by the composer-actions row in step 16;
  // the ordinary contribution bar does not render them.
  "composer-actions": 6,
};

/** Stable, owner-independent presentation order (slot, order, owner, id). */
function presentationOrder(a: ContributionView, b: ContributionView): number {
  return (
    SLOT_RANK[a.slot] - SLOT_RANK[b.slot] ||
    a.order - b.order ||
    a.ownerId.localeCompare(b.ownerId) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Resolves a mode's referenced action from the *same owner's* top-level
 * actions. A dangling/cross-owner/wrong-kind id resolves to `null`: the label
 * stays informative and non-interactive rather than inventing a command.
 */
export function resolveContributionAction(
  snapshot: ContributionSnapshot,
  mode: ContributionView | null,
): ContributionModeAction | null {
  if (!mode || mode.kind !== "mode" || mode.actionRef === undefined) return null;
  const action = snapshot.contributions.find(
    (entry) =>
      entry.ownerId === mode.ownerId && entry.id === mode.actionRef && entry.kind === "action",
  );
  if (!action) return null;
  return {
    ownerId: action.ownerId,
    id: action.id,
    text: action.text,
    ...(action.detail === undefined ? {} : { detail: action.detail }),
    enabled: action.enabled,
    ...(action.disabledReason === undefined ? {} : { disabledReason: action.disabledReason }),
  };
}

export function buildContributionBar(snapshot: ContributionSnapshot): ContributionBarModel {
  const ordered = [...snapshot.contributions].sort(presentationOrder);
  const mode = ordered.find((entry) => entry.slot === "mode") ?? null;
  const modeAction = resolveContributionAction(snapshot, mode);
  // The corner control consumes the primary mode and its referenced action.
  // Everything else the publisher sent stays visible as a row/action; only the
  // identical action reference is excluded so it is not shown twice.
  const rows = ordered.filter(
    (entry) =>
      entry !== mode &&
      (entry.slot === "progress" || entry.slot === "status" || entry.slot === "mode"),
  );
  const actions = ordered.filter(
    (entry) =>
      entry.slot === "action" &&
      !(modeAction !== null && entry.ownerId === modeAction.ownerId && entry.id === modeAction.id),
  );
  return {
    mode,
    modeAction,
    rows,
    actions,
    inputs: ordered.filter((entry) => entry.slot === "input"),
    sessions: ordered.filter((entry) => entry.slot === "sessions"),
    composerControls: ordered.filter((entry) => entry.slot === COMPOSER_CONTROL_SLOT),
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
