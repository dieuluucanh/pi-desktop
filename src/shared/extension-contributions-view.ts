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
  ACTION_PLACEMENTS,
  sortContributions,
  type ActionPlacement,
  type Contribution,
  type ContributionActionGroup,
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
  /**
   * Mode/mode-choice/composer-control only: id of the same-owner top-level
   * `kind:"action"` that owns execution and disabled state. A reference never
   * carries a command of its own.
   */
  actionRef?: string;
  /** Composer-control only: same-owner action that starts the transform. */
  transformActionRef?: string;
  /**
   * Mode-choice/composer-control only: presentation state (never a command).
   * For a mode-choice the referenced action still owns execution.
   */
  checked?: boolean;
  /**
   * Action only: additive v1 presentation group. Group identity is
   * `(ownerId, group.id)`; absent means a legacy ungrouped action.
   */
  group?: ContributionActionGroup;
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
    case "mode-choice":
      // Presentation data only: the referenced action owns execution. `checked`
      // is always present so a sanitizer round-trip is byte-stable.
      return {
        ...base,
        text: contribution.label,
        ...(contribution.description === undefined ? {} : { detail: contribution.description }),
        actionRef: contribution.actionRef,
        checked: contribution.checked === true,
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
        ...(contribution.group === undefined ? {} : { group: contribution.group }),
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

function asPlacement(value: unknown): ActionPlacement | undefined {
  return typeof value === "string" && (ACTION_PLACEMENTS as readonly string[]).includes(value)
    ? (value as ActionPlacement)
    : undefined;
}

/** Rebuilds an action group from a validated shape; a malformed group is dropped. */
function asActionGroup(value: unknown): ContributionActionGroup | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const group = value as Record<string, unknown>;
  const id = asString(group.id, 96);
  const label = asString(group.label, 120);
  const placement = asPlacement(group.placement);
  if (!id || !label || placement === undefined) return undefined;
  return {
    id,
    label,
    order: typeof group.order === "number" && Number.isFinite(group.order) ? group.order : 0,
    placement,
  };
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
        kind !== "mode-choice" &&
        kind !== "progress" &&
        kind !== "status" &&
        kind !== "action" &&
        kind !== "input" &&
        kind !== "related-session" &&
        kind !== COMPOSER_CONTROL_KIND
      ) {
        continue;
      }
      const slot = asString(entry.slot, 20) ?? kind;
      const command = asRecord(entry.command);
      const commandName = asString(command.name, 64);
      // A mode/mode-choice action reference is an id, never a command: the host
      // resolves the live action (and refuses a missing/other-owner one) at run
      // time. A mode-choice cannot be interactive without one.
      const actionRef = asString(entry.actionRef, 96);
      if (kind === "mode-choice") {
        // Own slot only: a choice must never claim the primary mode identity,
        // and its required reference must be a plain id.
        if (slot !== "mode-choice" || actionRef === undefined) continue;
      }
      const transformActionRef = asString(entry.transformActionRef, 96);
      const icon = asString(entry.icon, 24);
      const behavior = asString(entry.behavior, 24);
      const availability = asAvailability(entry.availability);
      const relation = asRelation(entry.relation);
      const sessionRef = asString(entry.sessionRef, 400);
      // A malformed group only loses its presentation metadata; the action
      // itself stays usable as a legacy ungrouped action.
      const group = kind === "action" ? asActionGroup(entry.group) : undefined;
      contributions.push({
        ownerId,
        id,
        kind,
        slot: slot as ContributionView["slot"],
        tone: (asString(entry.tone, 20) ?? "neutral") as ContributionView["tone"],
        order: typeof entry.order === "number" && Number.isFinite(entry.order) ? entry.order : 0,
        text,
        ...(asString(entry.detail, 1_200) === undefined
          ? {}
          : { detail: asString(entry.detail, 1_200) as string }),
        ...((kind === "mode" || kind === "mode-choice" || kind === COMPOSER_CONTROL_KIND) &&
        actionRef !== undefined
          ? { actionRef }
          : {}),
        ...(kind !== "mode-choice" && kind !== COMPOSER_CONTROL_KIND
          ? {}
          : {
              checked: entry.checked === true,
              ...(kind === COMPOSER_CONTROL_KIND
                ? {
                    ...(transformActionRef === undefined ? {} : { transformActionRef }),
                    ...(icon !== undefined &&
                    (COMPOSER_CONTROL_ICONS as readonly string[]).includes(icon)
                      ? { icon: icon as ComposerControlIcon }
                      : {}),
                    ...(behavior !== undefined &&
                    (COMPOSER_CONTROL_BEHAVIORS as readonly string[]).includes(behavior)
                      ? { behavior: behavior as ComposerControlBehavior }
                      : {}),
                  }
                : {}),
            }),
        ...(group === undefined ? {} : { group }),
        ...(typeof entry.done === "number" ? { done: entry.done } : {}),
        ...(typeof entry.total === "number" ? { total: entry.total } : {}),
        ...(entry.stale === true ? { stale: true } : {}),
        ...(availability === undefined ? {} : { availability }),
        ...(relation === undefined ? {} : { relation }),
        ...(sessionRef === undefined ? {} : { sessionRef }),
        ...(entry.focusable === true ? { focusable: true } : {}),
        // `enabled` is required on the view: absent means "not disabled", which
        // matches the wire default and keeps a sanitized row renderable. A
        // mode-choice owns no execution state: its referenced action does.
        enabled: kind === "mode-choice" ? true : entry.enabled !== false,
        ...(kind === "mode-choice" || asString(entry.disabledReason, 400) === undefined
          ? {}
          : { disabledReason: asString(entry.disabledReason, 400) as string }),
        // Only a top-level action is executable, so only it may carry a command
        // name through the frame; a mode-choice can never gain one.
        ...(commandName === undefined || kind !== "action"
          ? {}
          : { command: { name: commandName } }),
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

/** Inline bar buttons are capped; the rest move to their group or overflow. */
export const MAX_INLINE_ACTIONS = 3;

/**
 * One action group as the bar renders it. Group identity is
 * `(ownerId, group.id)`, so two publishers can never merge accidentally.
 *
 * Metadata comes from the FIRST declaration in presentation order; later
 * conflicting declarations for the same `(ownerId, group.id)` keep the first
 * `label`/`order`/`placement` and only contribute their actions here.
 */
export interface ContributionActionGroupView {
  ownerId: string;
  id: string;
  label: string;
  order: number;
  placement: ActionPlacement;
  /** Group members in action order/id order; empty groups are never emitted. */
  actions: ContributionView[];
}

/**
 * One mode-menu entry: the renderer-safe `mode-choice` view (label in `text`,
 * optional `detail`, `checked`) plus its resolved same-owner action.
 *
 * `action` is `null` when the reference is dangling, cross-owner, wrong-kind or
 * the choice carries no reference: the entry stays visible and non-actionable
 * rather than inventing a command.
 */
export interface ContributionModeChoice {
  choice: ContributionView;
  action: ContributionModeAction | null;
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
 * - `actions` excludes every same-owner action the corner control consumes:
 *   the primary mode's `actionRef` and each mode-choice's resolved
 *   `actionRef`. A publisher never shows the same control twice, and a
 *   dangling/cross-owner reference excludes nothing (the other owner keeps its
 *   action).
 * - `inlineActions`/`overflowActions`/`actionGroups` partition `actions` once
 *   (owner-namespaced) group metadata resolves, so the bar never re-derives
 *   placement or owner rules.
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
  /**
   * Mode-menu entries: `mode-choice` views from the primary mode's owner only,
   * in presentation order (order, then id). Empty when there is no primary mode
   * or a choice belongs to another owner.
   */
  modeChoices: ContributionModeChoice[];
  /** First `MAX_INLINE_ACTIONS` inline-grouped and legacy ungrouped actions. */
  inlineActions: ContributionView[];
  /** Menu groups plus inline groups whose actions overflowed the inline cap. */
  actionGroups: ContributionActionGroupView[];
  /** Legacy ungrouped actions beyond the inline cap. */
  overflowActions: ContributionView[];
  /** Progress/status views for the footer rail, in presentation order. */
  progressRows: ContributionView[];
  statusRows: ContributionView[];
}

const SLOT_RANK: Record<ContributionSlot, number> = {
  mode: 0,
  // A mode-choice is menu data only: it sorts after mode/action rows and is
  // never returned as `mode` or as an ordinary row.
  "mode-choice": 1,
  progress: 2,
  status: 3,
  action: 4,
  input: 5,
  sessions: 6,
  // Composer controls are projected by the composer-actions row in step 16;
  // the ordinary contribution bar does not render them.
  "composer-actions": 7,
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
 * Resolves a mode label's (or mode-choice's) referenced action from the
 * *same owner's* top-level actions. A dangling/cross-owner/wrong-kind id
 * resolves to `null`: the label/choice stays informative and non-interactive
 * rather than inventing a command. Only a top-level `kind:"action"` is ever
 * accepted, so a reference can never reach a non-executable contribution.
 */
export function resolveContributionAction(
  snapshot: ContributionSnapshot,
  source: ContributionView | null,
): ContributionModeAction | null {
  if (!source || (source.kind !== "mode" && source.kind !== "mode-choice")) return null;
  if (source.actionRef === undefined) return null;
  const action = snapshot.contributions.find(
    (entry) =>
      entry.ownerId === source.ownerId && entry.id === source.actionRef && entry.kind === "action",
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

/** Owner-namespaced group identity: two publishers never merge. */
function actionGroupKey(ownerId: string, groupId: string): string {
  return `${ownerId}\u0000${groupId}`;
}

/** Group members keep action order/id order, independent of input order. */
function actionOrder(a: ContributionView, b: ContributionView): number {
  return a.order - b.order || a.id.localeCompare(b.id);
}

export function buildContributionBar(snapshot: ContributionSnapshot): ContributionBarModel {
  const ordered = [...snapshot.contributions].sort(presentationOrder);
  // Identity is the primary mode only. A `mode-choice` has its own slot and
  // kind, so it can never be promoted here even when its order/id sorts first.
  const mode = ordered.find((entry) => entry.kind === "mode" && entry.slot === "mode") ?? null;
  const modeAction = resolveContributionAction(snapshot, mode);
  // The corner control consumes the primary mode and its referenced action.
  // Everything else the publisher sent stays visible as a row/action; only the
  // identical action reference is excluded so it is not shown twice. A
  // mode-choice is menu data only and never becomes an ordinary row.
  const rows = ordered.filter(
    (entry) =>
      entry !== mode &&
      entry.kind !== "mode-choice" &&
      (entry.slot === "progress" || entry.slot === "status" || entry.slot === "mode"),
  );

  // Mode menu: only choices from the primary mode's owner. A choice cannot be
  // actionable without a same-owner top-level action, so a bad reference is a
  // non-actionable entry rather than a command.
  const modeChoices: ContributionModeChoice[] =
    mode === null
      ? []
      : ordered
          .filter((entry) => entry.kind === "mode-choice" && entry.ownerId === mode.ownerId)
          .map((choice) => ({ choice, action: resolveContributionAction(snapshot, choice) }));

  // The mode menu consumes each choice's *resolved same-owner* action, exactly
  // like `modeAction`. Only resolved references are excluded: a dangling or
  // cross-owner id matches no action here, so an unrelated publisher keeps its
  // action in the bar/menu.
  const consumedActions = new Set<string>();
  const consume = (action: ContributionModeAction | null): void => {
    if (action !== null) consumedActions.add(`${action.ownerId}\u0000${action.id}`);
  };
  consume(modeAction);
  for (const entry of modeChoices) consume(entry.action);

  const actions = ordered.filter(
    (entry) => entry.slot === "action" && !consumedActions.has(`${entry.ownerId}\u0000${entry.id}`),
  );

  // Group metadata is resolved from the visible bar actions only. The FIRST
  // declaration in presentation order wins for label/order/placement; a later
  // conflicting declaration still joins the same `(ownerId, group.id)` group.
  const groupMetadata = new Map<string, ContributionActionGroup>();
  for (const entry of actions) {
    if (entry.group === undefined) continue;
    const key = actionGroupKey(entry.ownerId, entry.group.id);
    if (!groupMetadata.has(key)) groupMetadata.set(key, { ...entry.group });
  }

  // Inline slot: inline-grouped actions plus the legacy ungrouped fallback, in
  // presentation order, capped. The group's resolved placement (first
  // declaration wins) decides where an action goes.
  const inlineCandidates = actions.filter((entry) => {
    if (entry.group === undefined) return true;
    const meta = groupMetadata.get(actionGroupKey(entry.ownerId, entry.group.id));
    return meta?.placement === "inline";
  });
  const inlineActions = inlineCandidates.slice(0, MAX_INLINE_ACTIONS);
  const inlineOverflow = inlineCandidates.slice(MAX_INLINE_ACTIONS);

  // Ungrouped actions beyond the cap stay a flat overflow list; grouped ones
  // join the group that already contains their siblings.
  const overflowActions = inlineOverflow.filter((entry) => entry.group === undefined);

  const grouped = new Map<
    string,
    { meta: ContributionActionGroup; ownerId: string; actions: ContributionView[] }
  >();
  const addToGroup = (entry: ContributionView): void => {
    if (entry.group === undefined) return;
    const key = actionGroupKey(entry.ownerId, entry.group.id);
    const meta = groupMetadata.get(key);
    if (meta === undefined) return;
    const bucket = grouped.get(key);
    if (bucket) bucket.actions.push(entry);
    else grouped.set(key, { meta, ownerId: entry.ownerId, actions: [entry] });
  };
  // Every menu group action belongs in the menu; inline groups only surface
  // when the cap pushed some of their actions out of the bar.
  for (const entry of actions) {
    if (entry.group === undefined) continue;
    const meta = groupMetadata.get(actionGroupKey(entry.ownerId, entry.group.id));
    if (meta?.placement === "menu") addToGroup(entry);
  }
  for (const entry of inlineOverflow) addToGroup(entry);

  const actionGroups: ContributionActionGroupView[] = [...grouped.values()]
    .map((bucket) => ({
      ownerId: bucket.ownerId,
      id: bucket.meta.id,
      label: bucket.meta.label,
      order: bucket.meta.order,
      placement: bucket.meta.placement,
      actions: [...bucket.actions].sort(actionOrder),
    }))
    .sort(
      (a, b) => a.order - b.order || a.ownerId.localeCompare(b.ownerId) || a.id.localeCompare(b.id),
    );

  return {
    mode,
    modeAction,
    rows,
    actions,
    inputs: ordered.filter((entry) => entry.slot === "input"),
    sessions: ordered.filter((entry) => entry.slot === "sessions"),
    composerControls: ordered.filter((entry) => entry.slot === COMPOSER_CONTROL_SLOT),
    modeChoices,
    inlineActions,
    actionGroups,
    overflowActions,
    progressRows: ordered.filter((entry) => entry.kind === "progress"),
    statusRows: ordered.filter((entry) => entry.kind === "status"),
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
