/**
 * Generic extension→host contribution contract (v1) — Desktop reader.
 *
 * Pi Desktop must render extension-contributed modes, controls and related
 * sessions without knowing which extension produced them. The publisher's
 * contract lives in `@dieulc/workflow`'s `host-contributions.ts`; this module is
 * the independent Desktop reader for the same wire format.
 *
 * Two independent readers are deliberate: the contract is a wire format, not a
 * shared npm package, so Desktop must reject malformed payloads on its own. The
 * conformance fixture (`tests/shared/fixtures/host-contract.conformance.json`)
 * is copied verbatim from the Workflow package and both suites must agree on
 * every verdict — a contract change updates the fixture and both readers.
 *
 * Security posture:
 *   - No code, HTML or CSS crosses the boundary. Tones are a closed enum.
 *   - Actions name a registered command; the host resolves and validates it.
 *   - Strings are single-line and length-bounded; control characters are
 *     rejected rather than sanitized, so a payload cannot smuggle terminal
 *     escapes into a status row.
 *   - An unknown contract version is rejected wholesale; an unknown
 *     contribution kind is dropped, so an older Desktop still shows the rest.
 *
 * No SDK and no DOM import: this module is consumed by the node and web
 * TypeScript projects.
 */

export const HOST_CONTRIBUTION_VERSION = 1 as const;

export const HOST_CONTRIBUTION_LIMITS = {
  maxContributions: 64,
  maxPerKind: 32,
  maxActionsPerContribution: 8,
  maxIdChars: 96,
  maxLabelChars: 120,
  maxTextChars: 400,
  maxDetailChars: 1_200,
  maxArgsChars: 1_000,
  maxOwnerChars: 80,
  maxSessionRefChars: 400,
  maxRemoved: 64,
} as const;

export const CONTRIBUTION_TONES = [
  "neutral",
  "accent",
  "info",
  "success",
  "warning",
  "error",
] as const;
export type ContributionTone = (typeof CONTRIBUTION_TONES)[number];

export const CONTRIBUTION_KINDS = [
  "mode",
  "progress",
  "status",
  "action",
  "input",
  "related-session",
] as const;
export type ContributionKind = (typeof CONTRIBUTION_KINDS)[number];

export const CONTRIBUTION_SLOTS = [
  "mode",
  "progress",
  "status",
  "action",
  "input",
  "sessions",
] as const;
export type ContributionSlot = (typeof CONTRIBUTION_SLOTS)[number];

export const INPUT_AVAILABILITY = ["available", "restricted", "locked"] as const;
export type InputAvailability = (typeof INPUT_AVAILABILITY)[number];

export const SESSION_RELATIONS = ["parent", "child", "sibling"] as const;
export type SessionRelation = (typeof SESSION_RELATIONS)[number];

export interface ContributionAction {
  id: string;
  label: string;
  args?: string;
  enabled: boolean;
  disabledReason?: string;
}

interface ContributionBase {
  id: string;
  tone: ContributionTone;
  order: number;
}

export interface ModeContribution extends ContributionBase {
  kind: "mode";
  slot: "mode";
  label: string;
  detail?: string;
  actions: ContributionAction[];
}

export interface ProgressContribution extends ContributionBase {
  kind: "progress";
  slot: "progress";
  label: string;
  done: number;
  total: number;
  stale?: boolean;
  detail?: string;
  actions: ContributionAction[];
}

export interface StatusContribution extends ContributionBase {
  kind: "status";
  slot: "status";
  text: string;
}

export interface ActionContribution extends ContributionBase {
  kind: "action";
  slot: "action";
  label: string;
  description?: string;
  command: { name: string; args?: string };
  enabled: boolean;
  disabledReason?: string;
}

export interface InputContribution extends ContributionBase {
  kind: "input";
  slot: "input";
  availability: InputAvailability;
  reason?: string;
}

export interface RelatedSessionContribution extends ContributionBase {
  kind: "related-session";
  slot: "sessions";
  relation: SessionRelation;
  sessionRef: string;
  title: string;
  focusable: boolean;
}

export type Contribution =
  | ModeContribution
  | ProgressContribution
  | StatusContribution
  | ActionContribution
  | InputContribution
  | RelatedSessionContribution;

export interface HostContributionCapabilities {
  contractVersion: number;
  kinds: readonly ContributionKind[];
  slots: readonly ContributionSlot[];
  maxContributions?: number;
}

export interface ContributionEnvelope {
  version: typeof HOST_CONTRIBUTION_VERSION;
  owner: { id: string; version?: string };
  sessionId: string;
  epoch: number;
  revision: number;
  removed: string[];
  contributions: Contribution[];
}

export interface ParsedEnvelope {
  envelope: ContributionEnvelope;
  ignoredKinds: string[];
}

export type ContributionResult<T> = { ok: true; value: T } | { ok: false; error: string };

function fail(error: string): ContributionResult<never> {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const COMMAND_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

function plainText(value: unknown, max: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  if (CONTROL.test(trimmed)) return undefined;
  return trimmed;
}

function tone(value: unknown, fallback: ContributionTone = "neutral"): ContributionTone {
  return typeof value === "string" && (CONTRIBUTION_TONES as readonly string[]).includes(value)
    ? (value as ContributionTone)
    : fallback;
}

function order(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function id(value: unknown): string | undefined {
  const text = plainText(value, HOST_CONTRIBUTION_LIMITS.maxIdChars);
  if (text === undefined) return undefined;
  return /^[A-Za-z0-9._-]+$/.test(text) ? text : undefined;
}

function parseAction(raw: unknown): ContributionResult<ContributionAction> {
  if (!isRecord(raw)) return fail("action must be an object");
  const actionId = id(raw.id);
  if (!actionId) return fail("action.id is invalid");
  const label = plainText(raw.label, HOST_CONTRIBUTION_LIMITS.maxLabelChars);
  if (!label) return fail(`action ${actionId} needs a label`);
  const args =
    raw.args === undefined
      ? undefined
      : plainText(raw.args, HOST_CONTRIBUTION_LIMITS.maxArgsChars, false);
  if (raw.args !== undefined && args === undefined) {
    return fail(`action ${actionId} args are invalid`);
  }
  const enabled = raw.enabled !== false;
  const disabledReason = plainText(raw.disabledReason, HOST_CONTRIBUTION_LIMITS.maxTextChars, false);
  const command = isRecord(raw.command) ? raw.command : undefined;
  if (command) {
    if (typeof command.name !== "string" || !COMMAND_NAME.test(command.name)) {
      return fail(`action ${actionId} has an invalid command name`);
    }
    if (command.args !== undefined && typeof command.args !== "string") {
      return fail(`action ${actionId} command args must be a string`);
    }
  }
  return {
    ok: true,
    value: {
      id: actionId,
      label,
      ...(args === undefined ? {} : { args }),
      enabled,
      ...(enabled || disabledReason === undefined ? {} : { disabledReason }),
    },
  };
}

function parseActions(raw: unknown): ContributionResult<ContributionAction[]> {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return fail("actions must be an array");
  if (raw.length > HOST_CONTRIBUTION_LIMITS.maxActionsPerContribution) {
    return fail("too many actions");
  }
  const out: ContributionAction[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const parsed = parseAction(entry);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.value.id)) return fail(`duplicate action id ${parsed.value.id}`);
    seen.add(parsed.value.id);
    out.push(parsed.value);
  }
  return { ok: true, value: out };
}

function parseContribution(raw: unknown): ContributionResult<Contribution | undefined> {
  if (!isRecord(raw)) return fail("contribution must be an object");
  const kind = raw.kind;
  if (typeof kind !== "string") return fail("contribution.kind is required");
  if (!(CONTRIBUTION_KINDS as readonly string[]).includes(kind)) {
    return { ok: true, value: undefined };
  }
  const contributionId = id(raw.id);
  if (!contributionId) return fail("contribution.id is invalid");
  const base = { id: contributionId, tone: tone(raw.tone), order: order(raw.order) };

  switch (kind as ContributionKind) {
    case "mode": {
      const label = plainText(raw.label, HOST_CONTRIBUTION_LIMITS.maxLabelChars);
      if (!label) return fail(`mode ${contributionId} needs a label`);
      const detail = plainText(raw.detail, HOST_CONTRIBUTION_LIMITS.maxDetailChars, false);
      if (raw.detail !== undefined && detail === undefined) {
        return fail(`mode ${contributionId} detail is invalid`);
      }
      const actions = parseActions(raw.actions);
      if (!actions.ok) return actions;
      return {
        ok: true,
        value: {
          ...base,
          kind: "mode",
          slot: "mode",
          label,
          ...(detail === undefined ? {} : { detail }),
          actions: actions.value,
        },
      };
    }
    case "progress": {
      const label = plainText(raw.label, HOST_CONTRIBUTION_LIMITS.maxLabelChars);
      if (!label) return fail(`progress ${contributionId} needs a label`);
      const done = raw.done;
      const total = raw.total;
      if (
        typeof done !== "number" ||
        typeof total !== "number" ||
        !Number.isInteger(done) ||
        !Number.isInteger(total) ||
        done < 0 ||
        total < 1 ||
        done > total
      ) {
        return fail(`progress ${contributionId} needs 0 <= done <= total`);
      }
      const detail = plainText(raw.detail, HOST_CONTRIBUTION_LIMITS.maxDetailChars, false);
      if (raw.detail !== undefined && detail === undefined) {
        return fail(`progress ${contributionId} detail is invalid`);
      }
      const actions = parseActions(raw.actions);
      if (!actions.ok) return actions;
      return {
        ok: true,
        value: {
          ...base,
          kind: "progress",
          slot: "progress",
          label,
          done,
          total,
          ...(raw.stale === true ? { stale: true } : {}),
          ...(detail === undefined ? {} : { detail }),
          actions: actions.value,
        },
      };
    }
    case "status": {
      const text = plainText(raw.text, HOST_CONTRIBUTION_LIMITS.maxTextChars);
      if (!text) return fail(`status ${contributionId} needs text`);
      return { ok: true, value: { ...base, kind: "status", slot: "status", text } };
    }
    case "action": {
      const label = plainText(raw.label, HOST_CONTRIBUTION_LIMITS.maxLabelChars);
      if (!label) return fail(`action ${contributionId} needs a label`);
      const description = plainText(raw.description, HOST_CONTRIBUTION_LIMITS.maxTextChars, false);
      if (raw.description !== undefined && description === undefined) {
        return fail(`action ${contributionId} description is invalid`);
      }
      const command = isRecord(raw.command) ? raw.command : undefined;
      if (!command || typeof command.name !== "string" || !COMMAND_NAME.test(command.name)) {
        return fail(`action ${contributionId} has an invalid command`);
      }
      const args = plainText(command.args, HOST_CONTRIBUTION_LIMITS.maxArgsChars, false);
      if (command.args !== undefined && args === undefined) {
        return fail(`action ${contributionId} command args are invalid`);
      }
      const enabled = raw.enabled !== false;
      const disabledReason = plainText(raw.disabledReason, HOST_CONTRIBUTION_LIMITS.maxTextChars, false);
      return {
        ok: true,
        value: {
          ...base,
          kind: "action",
          slot: "action",
          label,
          ...(description === undefined ? {} : { description }),
          command: { name: command.name, ...(args === undefined ? {} : { args }) },
          enabled,
          ...(enabled || disabledReason === undefined ? {} : { disabledReason }),
        },
      };
    }
    case "input": {
      const availability = raw.availability;
      if (!(INPUT_AVAILABILITY as readonly unknown[]).includes(availability)) {
        return fail(`input ${contributionId} has an invalid availability`);
      }
      const reason = plainText(raw.reason, HOST_CONTRIBUTION_LIMITS.maxTextChars, false);
      if (raw.reason !== undefined && reason === undefined) {
        return fail(`input ${contributionId} reason is invalid`);
      }
      return {
        ok: true,
        value: {
          ...base,
          kind: "input",
          slot: "input",
          availability: availability as InputAvailability,
          ...(reason === undefined ? {} : { reason }),
        },
      };
    }
    case "related-session": {
      const relation = raw.relation;
      if (!(SESSION_RELATIONS as readonly unknown[]).includes(relation)) {
        return fail(`related-session ${contributionId} has an invalid relation`);
      }
      const sessionRef = plainText(raw.sessionRef, HOST_CONTRIBUTION_LIMITS.maxSessionRefChars);
      if (!sessionRef) return fail(`related-session ${contributionId} needs sessionRef`);
      const title = plainText(raw.title, HOST_CONTRIBUTION_LIMITS.maxLabelChars);
      if (!title) return fail(`related-session ${contributionId} needs a title`);
      return {
        ok: true,
        value: {
          ...base,
          kind: "related-session",
          slot: "sessions",
          relation: relation as SessionRelation,
          sessionRef,
          title,
          focusable: raw.focusable === true,
        },
      };
    }
    default:
      return { ok: true, value: undefined };
  }
}

export function negotiateContributionVersion(
  capabilities: HostContributionCapabilities,
): ContributionResult<typeof HOST_CONTRIBUTION_VERSION> {
  if (!Number.isInteger(capabilities.contractVersion)) {
    return fail("host did not advertise a contract version");
  }
  if (capabilities.contractVersion < HOST_CONTRIBUTION_VERSION) {
    return fail(
      `host contract v${capabilities.contractVersion} is older than v${HOST_CONTRIBUTION_VERSION}; fall back to status/widgets`,
    );
  }
  return { ok: true, value: HOST_CONTRIBUTION_VERSION };
}

export function parseContributionEnvelope(raw: unknown): ContributionResult<ParsedEnvelope> {
  if (!isRecord(raw)) return fail("envelope must be an object");
  if (raw.version !== HOST_CONTRIBUTION_VERSION) {
    return fail(`unsupported contribution version ${String(raw.version)}`);
  }
  if (!isRecord(raw.owner)) return fail("owner must be an object");
  const ownerId = plainText(raw.owner.id, HOST_CONTRIBUTION_LIMITS.maxOwnerChars);
  if (!ownerId) return fail("owner.id is required");
  const ownerVersion = plainText(raw.owner.version, 40, false);
  if (raw.owner.version !== undefined && ownerVersion === undefined) {
    return fail("owner.version is invalid");
  }
  const sessionId = plainText(raw.sessionId, HOST_CONTRIBUTION_LIMITS.maxSessionRefChars);
  if (!sessionId) return fail("sessionId is required");
  if (typeof raw.epoch !== "number" || !Number.isInteger(raw.epoch) || raw.epoch < 0) {
    return fail("epoch must be a non-negative integer");
  }
  if (typeof raw.revision !== "number" || !Number.isInteger(raw.revision) || raw.revision < 1) {
    return fail("revision must be a positive integer");
  }

  if (raw.removed !== undefined && !Array.isArray(raw.removed)) return fail("removed must be an array");
  const removedRaw = (raw.removed as unknown[] | undefined) ?? [];
  if (removedRaw.length > HOST_CONTRIBUTION_LIMITS.maxRemoved) return fail("too many removed ids");
  const removed: string[] = [];
  for (const entry of removedRaw) {
    const removedId = id(entry);
    if (!removedId) return fail("removed contains an invalid id");
    if (!removed.includes(removedId)) removed.push(removedId);
  }

  if (!Array.isArray(raw.contributions)) return fail("contributions must be an array");
  if (raw.contributions.length > HOST_CONTRIBUTION_LIMITS.maxContributions) {
    return fail("too many contributions");
  }

  const contributions: Contribution[] = [];
  const ignoredKinds: string[] = [];
  const seen = new Set<string>();
  const perKind = new Map<ContributionKind, number>();
  for (const entry of raw.contributions) {
    const parsed = parseContribution(entry);
    if (!parsed.ok) return parsed;
    if (parsed.value === undefined) {
      const unknownKind =
        isRecord(entry) && typeof entry.kind === "string" ? entry.kind : "unknown";
      if (!ignoredKinds.includes(unknownKind)) ignoredKinds.push(unknownKind);
      continue;
    }
    if (seen.has(parsed.value.id)) return fail(`duplicate contribution id ${parsed.value.id}`);
    seen.add(parsed.value.id);
    const count = (perKind.get(parsed.value.kind) ?? 0) + 1;
    if (count > HOST_CONTRIBUTION_LIMITS.maxPerKind) {
      return fail(`too many ${parsed.value.kind} contributions`);
    }
    perKind.set(parsed.value.kind, count);
    contributions.push(parsed.value);
  }

  return {
    ok: true,
    value: {
      envelope: {
        version: HOST_CONTRIBUTION_VERSION,
        owner: { id: ownerId, ...(ownerVersion === undefined ? {} : { version: ownerVersion }) },
        sessionId,
        epoch: raw.epoch,
        revision: raw.revision,
        removed,
        contributions,
      },
      ignoredKinds,
    },
  };
}

export function sortContributions(
  entries: ReadonlyArray<{ ownerId: string; contribution: Contribution }>,
): Array<{ ownerId: string; contribution: Contribution }> {
  return [...entries].sort(
    (a, b) =>
      a.contribution.order - b.contribution.order ||
      a.ownerId.localeCompare(b.ownerId) ||
      a.contribution.id.localeCompare(b.contribution.id),
  );
}

export function applyEnvelope(
  current:
    | { epoch: number; revision: number; contributions: Map<string, Contribution> }
    | undefined,
  envelope: ContributionEnvelope,
): ContributionResult<{
  epoch: number;
  revision: number;
  contributions: Map<string, Contribution>;
}> {
  if (current) {
    if (envelope.epoch < current.epoch) return fail("stale epoch");
    if (envelope.epoch === current.epoch && envelope.revision <= current.revision) {
      return fail("stale or duplicate revision");
    }
  }
  const contributions = new Map(
    current && envelope.epoch === current.epoch ? current.contributions : [],
  );
  for (const removedId of envelope.removed) contributions.delete(removedId);
  for (const contribution of envelope.contributions) {
    contributions.set(contribution.id, contribution);
  }
  return {
    ok: true,
    value: { epoch: envelope.epoch, revision: envelope.revision, contributions },
  };
}
