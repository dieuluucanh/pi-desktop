/**
 * Renderer-safe composer-control projection and per-tab operation reducer.
 *
 * This module is the renderer side of the generic `composer-transform-v1`
 * capability. It deliberately does **not** reuse the chat-run state: a composer
 * operation is presentation-adjacent state (one per tab) and never marks the
 * conversation as running, appends synthetic turns or shares a run disposition.
 *
 * Two responsibilities:
 *
 *   - `projectComposerControls` turns a sanitized contribution snapshot into
 *     descriptors. Only typed fields are read (checked/enabled/disabledReason,
 *     action references, generation). Status text is never parsed for control
 *     state, and a same-owner reference that does not resolve to a live
 *     `kind:"action"` is rejected instead of guessed.
 *   - `reduceComposerOperation` applies typed protocol events to one tab's
 *     operation. Descriptor and binding generations are carried and every
 *     event is fenced by request/operation id, so a stale receipt, a rebound
 *     host or a duplicate publish cannot re-arm, re-apply or replace a newer
 *     operation.
 *
 * Fail-safe rules:
 *
 *   - Unknown/old event shapes, unknown states and malformed ids are ignored
 *     (the reducer returns the previous state unchanged).
 *   - Publisher withdrawal removes the descriptor and conflicts an active
 *     operation while retaining its candidate text for recovery.
 *   - Multiple armed controls never pick one arbitrarily: the derived state is
 *     a conflict with a clear reason.
 *   - No extension identifier appears in this generic runtime: no branch reads
 *     a label, owner id or status string for behaviour.
 *
 * Pure TypeScript: no SDK, DOM, timers or storage.
 */

import {
  COMPOSER_TRANSFORM_EVENTS,
  COMPOSER_TRANSFORM_STATES,
  type ComposerControlBehavior,
  type ComposerControlIcon,
  type ComposerTransformBinding,
  type ComposerTransformState,
  type ComposerTransformStatus,
} from "./composer-transform";
import type { ContributionSnapshot, ContributionView } from "./extension-contributions-view";

export const COMPOSER_OPERATION_REDUCER_VERSION = 1 as const;

/** The binding generation the wire contract already defines. */
export type ComposerBindingGeneration = ComposerTransformBinding;

export interface ComposerDescriptorGeneration {
  ownerId: string;
  epoch: number;
  revision: number;
}

export interface ComposerControlDescriptor {
  ownerId: string;
  id: string;
  label: string;
  description?: string;
  icon?: ComposerControlIcon;
  tone: string;
  checked: boolean;
  enabled: boolean;
  disabledReason?: string;
  behavior: ComposerControlBehavior;
  actionRef: string;
  transformActionRef: string;
  /**
   * The registered command the same-owner transform action invokes, when the
   * snapshot resolved one. This is advertised metadata, not executable
   * content: a typed `/command <literal text>` can be matched against it by
   * exact name so the text runs through this control's structured operation
   * instead of the command's generic handler. Suffixed collision names are
   * never projected, so a `name:2` registration cannot be mistaken for the
   * publisher's declared command.
   */
  transformCommand?: string;
  /** Generation the descriptor was published under; an operation carries it. */
  descriptorGeneration: ComposerDescriptorGeneration;
}

export type ComposerControlRejectionReason =
  | "unknown-generation"
  | "duplicate-control"
  | "invalid-references"
  | "invalid-behavior"
  | "missing-toggle-action"
  | "missing-transform-action"
  | "foreign-action";

export interface ComposerControlRejection {
  ownerId: string;
  id: string;
  reason: ComposerControlRejectionReason;
}

export interface ComposerControlProjection {
  controls: ComposerControlDescriptor[];
  rejected: ComposerControlRejection[];
  descriptorGenerations: ComposerDescriptorGeneration[];
}

export const EMPTY_COMPOSER_CONTROL_PROJECTION: ComposerControlProjection = {
  controls: [],
  rejected: [],
  descriptorGenerations: [],
};

function controlKey(ownerId: string, id: string): string {
  return `${ownerId}:${id}`;
}

function isKnownBehavior(value: unknown): value is ComposerControlBehavior {
  return value === "one-shot-return" || value === "persistent";
}

function sameGeneration(a: ComposerDescriptorGeneration, b: ComposerDescriptorGeneration): boolean {
  return a.ownerId === b.ownerId && a.epoch === b.epoch && a.revision === b.revision;
}

function sameBinding(a: ComposerTransformBinding, b: ComposerTransformBinding): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.epoch === b.epoch &&
    a.bindingId === b.bindingId &&
    a.hostGeneration === b.hostGeneration
  );
}

/**
 * A base command name as the wire contract defines it. An SDK collision suffix
 * (`name:2`) deliberately does not match: the snapshot cannot say which
 * registration owns a suffix, so a suffixed name is never projected.
 */
const ADVERTISED_COMMAND_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

function actionIdsByOwner(snapshot: ContributionSnapshot): {
  actions: Map<string, Set<string>>;
  ownersById: Map<string, Set<string>>;
  commands: Map<string, string>;
} {
  const actions = new Map<string, Set<string>>();
  const ownersById = new Map<string, Set<string>>();
  const commands = new Map<string, string>();
  for (const entry of snapshot.contributions) {
    if (entry.kind !== "action") continue;
    const owned = actions.get(entry.ownerId) ?? new Set<string>();
    owned.add(entry.id);
    actions.set(entry.ownerId, owned);
    const owners = ownersById.get(entry.id) ?? new Set<string>();
    owners.add(entry.ownerId);
    ownersById.set(entry.id, owners);
    const command = entry.command?.name;
    if (typeof command === "string" && ADVERTISED_COMMAND_NAME.test(command)) {
      commands.set(controlKey(entry.ownerId, entry.id), command);
    }
  }
  return { actions, ownersById, commands };
}

function contributorGeneration(
  snapshot: ContributionSnapshot,
  ownerId: string,
): ComposerDescriptorGeneration | undefined {
  const owner = snapshot.owners.find((entry) => entry.ownerId === ownerId);
  if (!owner) return undefined;
  return { ownerId: owner.ownerId, epoch: owner.epoch, revision: owner.revision };
}

/**
 * Projects renderer-safe composer controls from a sanitized snapshot.
 *
 * A control is dropped (never guessed) when its descriptor has no owner
 * generation, its references are equal/missing, or either reference does not
 * resolve to an action owned by the same publisher.
 */
export function projectComposerControls(
  snapshot: ContributionSnapshot | undefined,
): ComposerControlProjection {
  if (!snapshot) return EMPTY_COMPOSER_CONTROL_PROJECTION;
  const { actions, ownersById, commands } = actionIdsByOwner(snapshot);
  const controls: ComposerControlDescriptor[] = [];
  const rejected: ComposerControlRejection[] = [];
  const seen = new Set<string>();

  for (const entry of snapshot.contributions) {
    if (entry.kind !== "composer-control") continue;
    const reject = (reason: ComposerControlRejectionReason): void => {
      rejected.push({ ownerId: entry.ownerId, id: entry.id, reason });
    };
    const generation = contributorGeneration(snapshot, entry.ownerId);
    if (!generation) {
      reject("unknown-generation");
      continue;
    }
    const key = controlKey(entry.ownerId, entry.id);
    if (seen.has(key)) {
      reject("duplicate-control");
      continue;
    }
    seen.add(key);

    const actionRef = entry.actionRef;
    const transformActionRef = entry.transformActionRef;
    if (!actionRef || !transformActionRef || actionRef === transformActionRef) {
      reject("invalid-references");
      continue;
    }
    const ownedActions = actions.get(entry.ownerId) ?? new Set<string>();
    if (!ownedActions.has(actionRef)) {
      reject(
        ownersById.has(actionRef) && !(ownersById.get(actionRef) as Set<string>).has(entry.ownerId)
          ? "foreign-action"
          : "missing-toggle-action",
      );
      continue;
    }
    if (!ownedActions.has(transformActionRef)) {
      reject(
        ownersById.has(transformActionRef) &&
          !(ownersById.get(transformActionRef) as Set<string>).has(entry.ownerId)
          ? "foreign-action"
          : "missing-transform-action",
      );
      continue;
    }
    if (!isKnownBehavior(entry.behavior)) {
      reject("invalid-behavior");
      continue;
    }

    const transformCommand = commands.get(controlKey(entry.ownerId, transformActionRef));
    controls.push({
      ownerId: entry.ownerId,
      id: entry.id,
      label: entry.text,
      ...(entry.detail === undefined ? {} : { description: entry.detail }),
      ...(entry.icon === undefined ? {} : { icon: entry.icon }),
      tone: entry.tone,
      checked: entry.checked === true,
      enabled: entry.enabled === true,
      ...(entry.disabledReason === undefined ? {} : { disabledReason: entry.disabledReason }),
      behavior: entry.behavior,
      actionRef,
      transformActionRef,
      ...(transformCommand === undefined ? {} : { transformCommand }),
      descriptorGeneration: generation,
    });
  }

  controls.sort(
    (a, b) =>
      a.descriptorGeneration.epoch - b.descriptorGeneration.epoch ||
      a.ownerId.localeCompare(b.ownerId) ||
      a.id.localeCompare(b.id),
  );
  rejected.sort(
    (a, b) =>
      a.ownerId.localeCompare(b.ownerId) ||
      a.id.localeCompare(b.id) ||
      a.reason.localeCompare(b.reason),
  );
  return {
    controls,
    rejected,
    descriptorGenerations: [...new Set(snapshot.owners.map((owner) => owner.ownerId))]
      .map((ownerId) => {
        const owner = snapshot.owners.find((entry) => entry.ownerId === ownerId);
        return {
          ownerId,
          epoch: owner?.epoch ?? 0,
          revision: owner?.revision ?? 0,
        };
      })
      .sort((a, b) => a.ownerId.localeCompare(b.ownerId)),
  };
}

// ── Operation state ──────────────────────────────────────────────────

export type ComposerOperationStatus =
  | "starting"
  | "running"
  | "awaiting-input"
  | "candidate"
  | "applied"
  | "cancelled"
  | "failed"
  | "conflict"
  | "expired";

export type ComposerOperationConflictKind =
  | "multiple-armed"
  | "not-armed"
  | "publisher-withdrawn"
  | "stale-descriptor"
  | "stale-binding"
  | "request-conflict"
  | "stale-base"
  | "invalid-control"
  // A host/session/policy/trust invalidation. The record is cancelled, never
  // left applicable, so a cached candidate cannot be applied after authority
  // or ownership changed (prompt-refinement plan step 23).
  | "invalidated";

export interface ComposerOperationConflict {
  kind: ComposerOperationConflictKind;
  message: string;
}

export interface ComposerOperationProgress {
  state: ComposerTransformState;
  phase?: string;
  done?: number;
  total?: number;
  message?: string;
  at: number;
}

export interface ComposerOperationCandidate {
  text: string;
  candidateRevision: number;
  summary?: string;
  at: number;
}

export interface ComposerAppliedReceipt {
  operationId: string;
  appliedRevision: number;
  disposition: "replaced" | "kept-candidate";
  appliedAt: number;
}

export interface ComposerOperationFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ComposerOperationRecord {
  requestId: string;
  operationId?: string;
  ownerId: string;
  controlId: string;
  descriptorGeneration: ComposerDescriptorGeneration;
  binding: ComposerTransformBinding;
  baseRevision: number;
  /** Attachment generation captured at start; a candidate applies only onto it. */
  baseAttachmentRevision?: number;
  /**
   * The captured draft text. Renderer memory only: it lets the conflict
   * surface offer the original for View/Copy after newer typing replaced it.
   */
  baseText?: string;
  status: ComposerOperationStatus;
  progress?: ComposerOperationProgress;
  candidate?: ComposerOperationCandidate;
  applied?: ComposerAppliedReceipt;
  failure?: ComposerOperationFailure;
  conflict?: ComposerOperationConflict;
  /** Monotonic local revision of this record (never decreases). */
  revision: number;
  updatedAt: number;
}

export interface ComposerTabOperationState {
  binding: ComposerTransformBinding | null;
  projection: ComposerControlProjection;
  /** Explicit local arm decisions by `owner:id`; absent means "use checked". */
  armedOverrides: Record<string, boolean>;
  operation: ComposerOperationRecord | null;
  conflict?: ComposerOperationConflict;
  revision: number;
  updatedAt: number;
}

export const EMPTY_COMPOSER_TAB_OPERATION_STATE: ComposerTabOperationState = {
  binding: null,
  projection: EMPTY_COMPOSER_CONTROL_PROJECTION,
  armedOverrides: {},
  operation: null,
  revision: 0,
  updatedAt: 0,
};

export interface ComposerOperationRegistry {
  version: typeof COMPOSER_OPERATION_REDUCER_VERSION;
  tabs: Record<string, ComposerTabOperationState>;
}

export function createComposerOperationRegistry(): ComposerOperationRegistry {
  return { version: COMPOSER_OPERATION_REDUCER_VERSION, tabs: {} };
}

export function composerTabOperation(
  registry: ComposerOperationRegistry,
  tabId: string,
): ComposerTabOperationState {
  return registry.tabs[tabId] ?? EMPTY_COMPOSER_TAB_OPERATION_STATE;
}

export function dropComposerOperationTab(
  registry: ComposerOperationRegistry,
  tabId: string,
): ComposerOperationRegistry {
  if (registry.tabs[tabId] === undefined) return registry;
  const tabs = { ...registry.tabs };
  delete tabs[tabId];
  return { ...registry, tabs };
}

// ── Derived presentation ─────────────────────────────────────────────

export type ComposerUiState =
  "eligible" | "armed" | "running" | "awaiting-input" | "candidate" | "conflict";

export interface ComposerOperationDerived {
  uiState: ComposerUiState | null;
  eligible: ComposerControlDescriptor[];
  armed: ComposerControlDescriptor[];
  armedControl: ComposerControlDescriptor | null;
  runningControl: ComposerControlDescriptor | null;
  isRunning: boolean;
  isAwaitingInput: boolean;
  hasCandidate: boolean;
  candidateText: string | null;
  /** The publisher's short change summary for a ready candidate. */
  candidateSummary: string | null;
  /** The typed stage the publisher reported (never parsed from a label). */
  stage: string | null;
  /** The publisher's bounded progress line (model + stage for refinement). */
  statusMessage: string | null;
  /** Captured original text, present only while the record still holds it. */
  originalText: string | null;
  isConflict: boolean;
  conflict: ComposerOperationConflict | null;
  canStart: boolean;
  canCancel: boolean;
  canApply: boolean;
}

/**
 * Host event names that belong to the composer operation surface. They are
 * reduced into per-tab operation state and never into the transcript reducer,
 * so a refinement cannot append synthetic turns or mark the conversation as
 * running.
 */
export const COMPOSER_OPERATION_HOST_EVENTS: readonly string[] = [
  COMPOSER_TRANSFORM_EVENTS.progress,
  COMPOSER_TRANSFORM_EVENTS.result,
  COMPOSER_TRANSFORM_EVENTS.applied,
];

/**
 * Maps one host composer-transform event onto a typed reducer event.
 *
 * Unknown names and malformed payloads return `undefined` (fail safe: the
 * caller drops the frame instead of guessing). A result frame is a candidate
 * only when it carries candidate text; a failure must carry a code and
 * message.
 */
export function composerOperationEventFromHost(
  event: string,
  payload: unknown,
): unknown | undefined {
  if (!COMPOSER_OPERATION_HOST_EVENTS.includes(event)) return undefined;
  const record = asRecord(payload);
  switch (event) {
    case COMPOSER_TRANSFORM_EVENTS.progress:
      return typeof record.state === "string" ? { type: "progress", progress: payload } : undefined;
    case COMPOSER_TRANSFORM_EVENTS.result:
      if (typeof record.text === "string" && record.text.length > 0) {
        return { type: "candidate", candidate: payload };
      }
      if (typeof record.code === "string" && typeof record.message === "string") {
        return { type: "failure", failure: payload };
      }
      return undefined;
    default:
      // `applied` is the host's own receipt echo; the renderer applied locally
      // and reconciled through its receipt table, so there is nothing to reduce.
      return undefined;
  }
}

const ACTIVE_STATUSES: readonly ComposerOperationStatus[] = [
  "starting",
  "running",
  "awaiting-input",
  "candidate",
];

function isActive(status: ComposerOperationStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

function isTerminalStatus(status: ComposerOperationStatus): boolean {
  return (
    status === "applied" ||
    status === "cancelled" ||
    status === "failed" ||
    status === "conflict" ||
    status === "expired"
  );
}

/**
 * True while an operation still belongs to a live host/binding and could make
 * further progress. A renderer that reloaded/reattached uses this to decide
 * whether to reconcile the live operation instead of starting another one.
 */
export function composerOperationReconcilable(
  operation: ComposerOperationRecord | null | undefined,
): operation is ComposerOperationRecord & { operationId: string } {
  if (!operation) return false;
  if (operation.operationId === undefined) return false;
  return isActive(operation.status);
}

/**
 * Event fencing (plan step 23). A frame may only touch an operation when it
 * names the same binding generation it was minted for. `undefined` means the
 * frame did not carry a binding (older host): the operationId/requestId match
 * is then the only fence, which is safe because ids are host-minted CSPRNG
 * values scoped to this tab's IPC.
 */
function fenceMismatch(
  operation: ComposerOperationRecord,
  rawEvent: Record<string, unknown>,
): boolean {
  if (rawEvent.binding === undefined) return false;
  const binding = parseBinding(rawEvent.binding);
  if (!binding) return true;
  return !sameBinding(operation.binding, binding);
}

function controlFor(
  projection: ComposerControlProjection,
  ownerId: string,
  controlId: string,
): ComposerControlDescriptor | undefined {
  return projection.controls.find(
    (control) => control.ownerId === ownerId && control.id === controlId,
  );
}

function isArmed(state: ComposerTabOperationState, control: ComposerControlDescriptor): boolean {
  return state.armedOverrides[controlKey(control.ownerId, control.id)] ?? control.checked;
}

function operationConflict(
  operation: ComposerOperationRecord,
  conflict: ComposerOperationConflict,
  at: number,
): ComposerOperationRecord {
  return {
    ...operation,
    status: "conflict",
    conflict,
    revision: operation.revision + 1,
    updatedAt: at,
  };
}

/**
 * Derives what a composer may show right now.
 *
 * Nothing here reads a label, owner id or status string: eligibility comes from
 * `enabled`, arming from `checked` plus explicit local decisions, and progress
 * from the typed operation status. A descriptor/binding generation mismatch or
 * a withdrawn publisher is surfaced as a conflict, never as an applicable
 * candidate.
 */
export function deriveComposerOperation(
  state: ComposerTabOperationState,
): ComposerOperationDerived {
  const eligible = state.projection.controls.filter((control) => control.enabled);
  const armed = state.projection.controls.filter((control) => isArmed(state, control));
  const operation = state.operation;

  let conflict: ComposerOperationConflict | null = state.conflict ?? null;
  if (operation && isActive(operation.status)) {
    const control = controlFor(state.projection, operation.ownerId, operation.controlId);
    if (!control) {
      conflict ??= {
        kind: "publisher-withdrawn",
        message: "The publisher withdrew this control while an operation was active.",
      };
    } else if (!sameGeneration(control.descriptorGeneration, operation.descriptorGeneration)) {
      conflict ??= {
        kind: "stale-descriptor",
        message: "The control was republished after this operation started.",
      };
    } else if (state.binding && !sameBinding(state.binding, operation.binding)) {
      conflict ??= {
        kind: "stale-binding",
        message: "The composer binding changed after this operation started.",
      };
    }
  }
  if (conflict === null && armed.length > 1) {
    conflict = {
      kind: "multiple-armed",
      message: "More than one transform control is armed; choose one before sending.",
    };
  }
  if (conflict === null && operation?.conflict) conflict = operation.conflict;

  const active = operation !== null && isActive(operation.status) && conflict === null;
  const isRunning = active && (operation.status === "starting" || operation.status === "running");
  const isAwaitingInput = active && operation.status === "awaiting-input";
  const hasCandidate =
    active && operation.status === "candidate" && operation.candidate !== undefined;
  const runningControl =
    operation === null
      ? null
      : (controlFor(state.projection, operation.ownerId, operation.controlId) ?? null);

  let uiState: ComposerUiState | null = null;
  if (conflict) uiState = "conflict";
  else if (hasCandidate) uiState = "candidate";
  else if (isAwaitingInput) uiState = "awaiting-input";
  else if (isRunning) uiState = "running";
  else if (armed.length === 1) uiState = "armed";
  else if (eligible.length > 0) uiState = "eligible";

  return {
    uiState,
    eligible,
    armed,
    armedControl: armed.length === 1 ? (armed[0] ?? null) : null,
    runningControl,
    isRunning,
    isAwaitingInput,
    hasCandidate,
    // A candidate stays viewable through a conflict: the text is recoverable
    // even when it must not replace a newer draft automatically.
    candidateText: operation?.candidate?.text ?? null,
    candidateSummary: operation?.candidate?.summary ?? null,
    stage: operation?.progress?.phase ?? null,
    statusMessage: operation?.progress?.message ?? null,
    originalText: operation?.baseText ?? null,
    isConflict: conflict !== null,
    conflict,
    canStart:
      conflict === null &&
      armed.length === 1 &&
      // A publisher-disabled control can be armed (its `checked` state is the
      // honest reason Send refuses) but it can never start an operation: the
      // missing capability stays disabled (plan step 29).
      armed[0]?.enabled === true &&
      (operation === null || isTerminalStatus(operation.status)),
    canCancel: active && operation !== null && !isTerminalStatus(operation.status),
    canApply: hasCandidate && conflict === null,
  };
}

// ── Reducer ──────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function timestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseBinding(raw: unknown): ComposerTransformBinding | null {
  const record = asRecord(raw);
  const sessionId = text(record.sessionId);
  const epoch = nonNegativeInt(record.epoch);
  const bindingId = text(record.bindingId);
  const hostGeneration = nonNegativeInt(record.hostGeneration);
  if (!sessionId || epoch === undefined || !bindingId || hostGeneration === undefined) return null;
  return { sessionId, epoch, bindingId, hostGeneration };
}

function parseGeneration(raw: unknown): ComposerDescriptorGeneration | null {
  const record = asRecord(raw);
  const ownerId = text(record.ownerId);
  const epoch = nonNegativeInt(record.epoch);
  const revision = positiveInt(record.revision);
  if (!ownerId || epoch === undefined || revision === undefined) return null;
  return { ownerId, epoch, revision };
}

function parseProgressState(value: unknown): ComposerTransformState | undefined {
  return typeof value === "string" &&
    (COMPOSER_TRANSFORM_STATES as readonly string[]).includes(value)
    ? (value as ComposerTransformState)
    : undefined;
}

function parseReconcileStatus(raw: unknown): ComposerTransformStatus | null {
  const record = asRecord(raw);
  const requestIdValue = text(record.requestId);
  const operationId = text(record.operationId);
  const state = parseProgressState(record.state);
  const revision = positiveInt(record.revision);
  const updatedAt = nonNegativeInt(record.updatedAt);
  if (!requestIdValue || !operationId || !state) return null;
  if (revision === undefined || updatedAt === undefined) return null;
  return {
    contract: "composer-transform-v1",
    requestId: requestIdValue,
    operationId,
    state,
    revision,
    updatedAt,
    terminal: (
      ["applied", "cancelled", "failed", "conflicted", "expired"] as readonly string[]
    ).includes(state),
  };
}

function parseCandidate(raw: unknown): ComposerOperationCandidate | null {
  const record = asRecord(raw);
  const candidateText = text(record.text);
  const candidateRevision = positiveInt(record.candidateRevision);
  const at = nonNegativeInt(record.at);
  if (candidateText === undefined || candidateRevision === undefined || at === undefined) {
    return null;
  }
  const summary = text(record.summary);
  return {
    text: candidateText,
    candidateRevision,
    ...(summary === undefined ? {} : { summary }),
    at,
  };
}

function parseProgress(raw: unknown): ComposerOperationProgress | null {
  const record = asRecord(raw);
  const state = parseProgressState(record.state);
  const at = nonNegativeInt(record.at);
  if (!state || at === undefined) return null;
  const phase = text(record.phase);
  const message = text(record.message);
  const done = nonNegativeInt(record.done);
  const total = nonNegativeInt(record.total);
  return {
    state,
    ...(phase === undefined ? {} : { phase }),
    ...(done === undefined ? {} : { done }),
    ...(total === undefined ? {} : { total }),
    ...(message === undefined ? {} : { message }),
    at,
  };
}

function progressStatus(state: ComposerTransformState): ComposerOperationStatus | null {
  switch (state) {
    case "accepted":
    case "running":
      return "running";
    case "awaiting-input":
      return "awaiting-input";
    case "candidate":
      // Candidate text travels on its own frame; a bare "candidate" progress
      // cannot make an applicable result.
      return null;
    case "applied":
      return "applied";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "conflicted":
      return "conflict";
    case "expired":
      return "expired";
    default:
      return null;
  }
}

function withConflict(
  state: ComposerTabOperationState,
  conflict: ComposerOperationConflict,
  at: number,
): ComposerTabOperationState {
  return {
    ...state,
    conflict,
    revision: state.revision + 1,
    updatedAt: at,
  };
}

function applyDescriptorEvent(
  state: ComposerTabOperationState,
  event: Record<string, unknown>,
  at: number,
): ComposerTabOperationState {
  const snapshot = event.snapshot;
  if (!snapshot || typeof snapshot !== "object") return state;
  const record = asRecord(snapshot);
  if (!Array.isArray(record.contributions)) return state;
  const projection = projectComposerControls(snapshot as ContributionSnapshot);
  const keys = new Set(
    projection.controls.map((control) => controlKey(control.ownerId, control.id)),
  );
  const armedOverrides: Record<string, boolean> = {};
  for (const [key, armed] of Object.entries(state.armedOverrides)) {
    if (keys.has(key)) armedOverrides[key] = armed;
  }
  let next: ComposerTabOperationState = {
    ...state,
    projection,
    armedOverrides,
    revision: state.revision + 1,
    updatedAt: at,
  };
  const operation = state.operation;
  if (operation && isActive(operation.status)) {
    const control = controlFor(projection, operation.ownerId, operation.controlId);
    if (!control || control.enabled === false) {
      // A publisher withdraw/disable invalidates the job: the candidate is no
      // longer applicable, but its text stays viewable (plan step 23).
      next = {
        ...next,
        operation: {
          ...operation,
          status: "cancelled",
          conflict: {
            kind: "publisher-withdrawn",
            message: "The publisher withdrew this control while an operation was active.",
          },
          revision: operation.revision + 1,
          updatedAt: at,
        },
      };
    } else if (!sameGeneration(control.descriptorGeneration, operation.descriptorGeneration)) {
      // A republished descriptor is a new generation: the old operation cannot
      // deliver an applicable result under it.
      next = {
        ...next,
        operation: {
          ...operation,
          status: "cancelled",
          conflict: {
            kind: "stale-descriptor",
            message: "The control was republished after this operation started.",
          },
          revision: operation.revision + 1,
          updatedAt: at,
        },
      };
    }
  }
  return next;
}

/**
 * Applies one event to one tab. The event is intentionally `unknown`: frames
 * cross IPC, and an old/forged/unknown shape must leave the state untouched.
 */
export function reduceComposerOperation(
  state: ComposerTabOperationState,
  rawEvent: unknown,
  now = Date.now(),
): ComposerTabOperationState {
  const event = asRecord(rawEvent);
  const at = timestamp(event.at, now);

  switch (event.type) {
    case "descriptor":
      return applyDescriptorEvent(state, event, at);

    case "binding": {
      const binding = parseBinding(event.binding);
      if (!binding) return state;
      const next: ComposerTabOperationState = {
        ...state,
        binding,
        revision: state.revision + 1,
        updatedAt: at,
      };
      const operation = state.operation;
      if (operation && isActive(operation.status) && !sameBinding(operation.binding, binding)) {
        // A rebound host/session invalidates the job; the draft is untouched.
        return {
          ...next,
          operation: {
            ...operation,
            status: "cancelled",
            conflict: {
              kind: "stale-binding",
              message: "The composer binding changed after this operation started.",
            },
            revision: operation.revision + 1,
            updatedAt: at,
          },
        };
      }
      return next;
    }

    case "arm": {
      const ownerId = text(event.ownerId);
      const controlId = text(event.controlId);
      if (!ownerId || !controlId || typeof event.armed !== "boolean") return state;
      const control = controlFor(state.projection, ownerId, controlId);
      if (!control) return state;
      // Arming a control the publisher disabled is refused, not remembered: a
      // missing capability stays disabled instead of becoming a pending Send
      // that can only fail later (plan step 29). Toggle-off is still accepted so
      // a stale local override can be cleared.
      if (event.armed === true && !control.enabled) return state;
      const armedOverrides = {
        ...state.armedOverrides,
        [controlKey(ownerId, controlId)]: event.armed,
      };
      let next: ComposerTabOperationState = {
        ...state,
        armedOverrides,
        revision: state.revision + 1,
        updatedAt: at,
      };
      const operation = state.operation;
      if (
        event.armed === false &&
        operation &&
        operation.ownerId === ownerId &&
        operation.controlId === controlId &&
        isActive(operation.status)
      ) {
        // Explicit toggle-off cancels the live operation; the candidate (if any)
        // stays recoverable and nothing is applied.
        next = {
          ...next,
          operation: {
            ...operation,
            status: "cancelled",
            conflict: undefined,
            revision: operation.revision + 1,
            updatedAt: at,
          },
        };
      }
      return next;
    }

    case "start": {
      const requestId = text(event.requestId);
      const ownerId = text(event.ownerId);
      const controlId = text(event.controlId);
      const baseRevision = positiveInt(event.baseRevision);
      const baseAttachmentRevision = nonNegativeInt(event.baseAttachmentRevision);
      const baseText = typeof event.baseText === "string" ? event.baseText : undefined;
      const binding = parseBinding(event.binding);
      const descriptorGeneration = parseGeneration(event.descriptorGeneration);
      if (!requestId || !ownerId || !controlId || baseRevision === undefined) return state;
      if (!binding || !descriptorGeneration) return state;
      const control = controlFor(state.projection, ownerId, controlId);
      if (!control || !control.enabled) {
        return withConflict(
          state,
          { kind: "invalid-control", message: "The composer control is no longer eligible." },
          at,
        );
      }
      if (state.binding && !sameBinding(state.binding, binding)) {
        return withConflict(
          state,
          { kind: "stale-binding", message: "The composer binding is stale." },
          at,
        );
      }
      if (!sameGeneration(control.descriptorGeneration, descriptorGeneration)) {
        return withConflict(
          state,
          {
            kind: "stale-descriptor",
            message: "The composer control was republished.",
          },
          at,
        );
      }
      const existing = state.operation;
      if (existing && isActive(existing.status)) {
        return withConflict(
          state,
          {
            kind: "request-conflict",
            message: "An operation is already active for this composer.",
          },
          at,
        );
      }
      const armed = state.projection.controls.filter((entry) => isArmed(state, entry));
      if (armed.length > 1) {
        return withConflict(
          state,
          {
            kind: "multiple-armed",
            message: "More than one transform control is armed; choose one before sending.",
          },
          at,
        );
      }
      if (!isArmed(state, control)) {
        return withConflict(
          state,
          { kind: "not-armed", message: "This transform control is not armed." },
          at,
        );
      }
      return {
        ...state,
        conflict: undefined,
        revision: state.revision + 1,
        updatedAt: at,
        operation: {
          requestId,
          ownerId,
          controlId,
          descriptorGeneration,
          binding,
          baseRevision,
          ...(baseAttachmentRevision === undefined ? {} : { baseAttachmentRevision }),
          ...(baseText === undefined ? {} : { baseText }),
          status: "starting",
          revision: 1,
          updatedAt: at,
        },
      };
    }

    case "started": {
      const receipt = asRecord(event.receipt);
      const requestId = text(receipt.requestId);
      const operationId = text(receipt.operationId);
      const receiptBinding = parseBinding(receipt.binding);
      const operation = state.operation;
      if (!operation || !requestId || !operationId || !receiptBinding) return state;
      if (operation.requestId !== requestId) return state;
      if (isTerminalStatus(operation.status)) return state;
      if (!sameBinding(operation.binding, receiptBinding)) {
        return {
          ...state,
          operation: operationConflict(
            operation,
            { kind: "stale-binding", message: "The started receipt belongs to another binding." },
            at,
          ),
          revision: state.revision + 1,
          updatedAt: at,
        };
      }
      if (operation.operationId !== undefined && operation.operationId !== operationId) {
        return state;
      }
      return {
        ...state,
        revision: state.revision + 1,
        updatedAt: at,
        operation: {
          ...operation,
          operationId,
          status: "running",
          revision: operation.revision + 1,
          updatedAt: at,
        },
      };
    }

    case "progress": {
      const progress = parseProgress(event.progress);
      const operation = state.operation;
      if (!progress || !operation || operation.operationId === undefined) return state;
      if (fenceMismatch(operation, event)) return state;
      if (isTerminalStatus(operation.status)) return state;
      const status = progressStatus(progress.state);
      if (status === null) return state;
      return {
        ...state,
        revision: state.revision + 1,
        updatedAt: at,
        operation: {
          ...operation,
          ...(status === "conflict"
            ? {
                conflict: {
                  kind: "request-conflict" as const,
                  message: progress.message ?? "The operation reported a conflict.",
                },
              }
            : {}),
          status,
          progress,
          revision: operation.revision + 1,
          updatedAt: at,
        },
      };
    }

    case "candidate": {
      const candidate = parseCandidate(event.candidate);
      const operation = state.operation;
      if (!candidate || !operation || operation.operationId === undefined) return state;
      if (fenceMismatch(operation, event)) return state;
      if (isTerminalStatus(operation.status)) return state;
      if (
        operation.candidate &&
        operation.candidate.candidateRevision === candidate.candidateRevision
      ) {
        return state;
      }
      return {
        ...state,
        revision: state.revision + 1,
        updatedAt: at,
        operation: {
          ...operation,
          status: "candidate",
          candidate,
          revision: operation.revision + 1,
          updatedAt: at,
        },
      };
    }

    case "applied": {
      const operation = state.operation;
      const operationId = text(event.operationId);
      const appliedRevision = positiveInt(event.appliedRevision);
      const disposition = event.disposition;
      const appliedAt = nonNegativeInt(event.appliedAt) ?? at;
      if (!operation || !operationId || appliedRevision === undefined) return state;
      if (fenceMismatch(operation, event)) return state;
      if (disposition !== "replaced" && disposition !== "kept-candidate") {
        return state;
      }
      if (operation.operationId !== operationId) return state;
      if (operation.applied) return state;
      if (operation.status === "cancelled" || operation.status === "expired") return state;
      // A successful apply is the one automatic disarm: the one-shot control is
      // turned off for this tab, and only this operation's receipt can do it.
      const armedOverrides = {
        ...state.armedOverrides,
        [controlKey(operation.ownerId, operation.controlId)]: false,
      };
      return {
        ...state,
        armedOverrides,
        revision: state.revision + 1,
        updatedAt: at,
        operation: {
          ...operation,
          status: "applied",
          applied: { operationId, appliedRevision, disposition, appliedAt },
          revision: operation.revision + 1,
          updatedAt: at,
        },
      };
    }

    case "failure": {
      const failure = asRecord(event.failure);
      const requestId = text(failure.requestId);
      const operationId = text(failure.operationId);
      const code = text(failure.code);
      const message = text(failure.message);
      const operation = state.operation;
      if (!operation || !requestId || !code || !message) return state;
      if (fenceMismatch(operation, event)) return state;
      if (operation.requestId !== requestId) return state;
      if (
        operation.operationId !== undefined &&
        operationId !== undefined &&
        operation.operationId !== operationId
      ) {
        return state;
      }
      if (isTerminalStatus(operation.status)) return state;
      return {
        ...state,
        revision: state.revision + 1,
        updatedAt: at,
        operation: {
          ...operation,
          status: "failed",
          failure: {
            code,
            message,
            retryable: failure.retryable === true,
          },
          revision: operation.revision + 1,
          updatedAt: at,
        },
      };
    }

    case "cancel": {
      const operation = state.operation;
      if (!operation || isTerminalStatus(operation.status)) return state;
      return {
        ...state,
        revision: state.revision + 1,
        updatedAt: at,
        operation: {
          ...operation,
          status: "cancelled",
          revision: operation.revision + 1,
          updatedAt: at,
        },
      };
    }

    case "candidate-conflict": {
      // The candidate could not be applied automatically (the draft moved on).
      // Keep the operation and its candidate text recoverable instead of
      // turning it into a terminal conflict with no result to view.
      const operation = state.operation;
      if (!operation || isTerminalStatus(operation.status)) return state;
      const kind = text(event.kind);
      const message = text(event.message);
      if (kind === undefined || message === undefined) return state;
      const allowed: readonly string[] = [
        "multiple-armed",
        "not-armed",
        "publisher-withdrawn",
        "stale-descriptor",
        "stale-binding",
        "request-conflict",
        "stale-base",
        "invalid-control",
      ];
      if (!allowed.includes(kind)) return state;
      return {
        ...state,
        revision: state.revision + 1,
        updatedAt: at,
        operation: {
          ...operation,
          conflict: { kind: kind as ComposerOperationConflictKind, message },
          revision: operation.revision + 1,
          updatedAt: at,
        },
      };
    }

    case "conflict": {
      const kind = text(event.kind);
      const message = text(event.message);
      if (kind === undefined || message === undefined) return state;
      const allowed: readonly string[] = [
        "multiple-armed",
        "not-armed",
        "publisher-withdrawn",
        "stale-descriptor",
        "stale-binding",
        "request-conflict",
        "stale-base",
        "invalid-control",
      ];
      if (!allowed.includes(kind)) return state;
      const conflict: ComposerOperationConflict = {
        kind: kind as ComposerOperationConflictKind,
        message,
      };
      const operation = state.operation;
      if (operation && isActive(operation.status)) {
        return {
          ...state,
          revision: state.revision + 1,
          updatedAt: at,
          operation: operationConflict(operation, conflict, at),
        };
      }
      return withConflict(state, conflict, at);
    }

    case "reconcile": {
      // Reconciliation from a live host read (plan step 23). It never carries
      // (or applies) draft text by itself: candidate text travels separately and
      // only the explicit apply path writes the draft. A host that reports
      // `applied` for a candidate this renderer already applied must not restart
      // anything or replace the draft twice; the local applied receipt wins.
      const status = parseReconcileStatus(event.status);
      const operation = state.operation;
      if (!status || !operation) return state;
      if (status.requestId !== operation.requestId) return state;
      if (operation.operationId !== undefined && operation.operationId !== status.operationId) {
        return state;
      }
      if (fenceMismatch(operation, event)) return state;
      if (operation.applied) return state;
      const mapped = progressStatus(status.state);
      if (mapped === null) {
        // A bare candidate status cannot manufacture a result; adopt the
        // candidate frame the current read carried, if it is newer.
        const carried = parseCandidate(event.candidate);
        if (!carried) return state;
        if (isTerminalStatus(operation.status)) return state;
        if (
          operation.candidate &&
          operation.candidate.candidateRevision >= carried.candidateRevision
        ) {
          return state;
        }
        return {
          ...state,
          revision: state.revision + 1,
          updatedAt: at,
          operation: {
            ...operation,
            operationId: status.operationId,
            status: "candidate",
            candidate: carried,
            revision: Math.max(operation.revision + 1, status.revision),
            updatedAt: at,
          },
        };
      }
      if (isTerminalStatus(operation.status) && mapped !== "applied") return state;
      if (mapped === "applied") {
        // Only this operation's own receipt can mark it applied. Without a
        // local receipt the candidate revision is the best identity we have;
        // the draft is never rewritten from a reconciliation read.
        const appliedRevision = operation.candidate?.candidateRevision ?? operation.baseRevision;
        return {
          ...state,
          revision: state.revision + 1,
          updatedAt: at,
          operation: {
            ...operation,
            operationId: status.operationId,
            status: "applied",
            applied: {
              operationId: status.operationId,
              appliedRevision,
              disposition: "replaced",
              appliedAt: status.updatedAt,
            },
            revision: Math.max(operation.revision + 1, status.revision),
            updatedAt: at,
          },
        };
      }
      const terminalFailure: ComposerOperationFailure | undefined =
        mapped === "cancelled" || mapped === "failed" || mapped === "expired"
          ? {
              code: mapped,
              message:
                mapped === "cancelled"
                  ? "The host cancelled this operation. Your draft is unchanged."
                  : mapped === "expired"
                    ? "The host no longer has this operation. Your draft is unchanged."
                    : "The operation failed on the host. Your draft is unchanged.",
              retryable: false,
            }
          : undefined;
      return {
        ...state,
        revision: state.revision + 1,
        updatedAt: at,
        operation: {
          ...operation,
          operationId: status.operationId,
          status: mapped,
          ...(terminalFailure === undefined ? {} : { failure: terminalFailure }),
          ...(mapped === "conflict"
            ? {
                conflict: {
                  kind: "invalidated" as const,
                  message: "The host reported this operation as conflicted.",
                },
              }
            : {}),
          revision: Math.max(operation.revision + 1, status.revision),
          updatedAt: at,
        },
      };
    }

    case "adopt": {
      // Adopts the one live operation the host reports for this binding (plan
      // step 23). This is the reload/reattach path: the renderer lost its
      // in-memory record, so it queries the host instead of starting a second
      // operation. The adopted record has no captured base revision, which
      // deliberately makes an automatic candidate apply refuse `stale-base`:
      // after a reload the user must confirm an explicit replace.
      const binding = parseBinding(event.binding);
      const requestIdValue = text(event.requestId);
      const operationId = text(event.operationId);
      const ownerId = text(event.ownerId);
      const controlId = text(event.controlId);
      const hostState = parseProgressState(event.state);
      const hostRevision = positiveInt(event.revision);
      const updatedAt = nonNegativeInt(event.updatedAt);
      if (!binding || !requestIdValue || !operationId || !ownerId || !controlId) return state;
      if (!hostState || hostRevision === undefined || updatedAt === undefined) return state;
      if (state.operation && isTerminalStatus(state.operation.status)) return state;
      if (fenceMismatch({ binding } as ComposerOperationRecord, event)) return state;
      if (state.binding && !sameBinding(state.binding, binding)) return state;
      const control = controlFor(state.projection, ownerId, controlId);
      const candidate = parseCandidate(event.candidate);
      const mapped =
        hostState === "candidate"
          ? candidate === null
            ? null
            : "candidate"
          : progressStatus(hostState);
      if (mapped === null) return state;
      const descriptorGeneration: ComposerDescriptorGeneration = control
        ? control.descriptorGeneration
        : { ownerId, epoch: 0, revision: 1 };
      return {
        ...state,
        conflict: undefined,
        revision: state.revision + 1,
        updatedAt: at,
        operation: {
          requestId: requestIdValue,
          operationId,
          ownerId,
          controlId,
          descriptorGeneration,
          binding,
          // Unknown base: a candidate is recoverable but never auto-applied
          // over the reloaded draft.
          baseRevision: 0,
          status: mapped,
          ...(candidate === null ? {} : { candidate }),
          progress: {
            state: hostState,
            at: updatedAt,
          },
          revision: Math.max(1, hostRevision),
          updatedAt: at,
        },
      };
    }

    case "invalidate": {
      // Host/session/policy/trust/publisher invalidation (plan step 23). It can
      // only cancel live work: a candidate becomes non-applicable but stays
      // viewable, and the draft is untouched. An already applied operation is
      // never rolled back by an invalidation.
      const operation = state.operation;
      if (!operation) return state;
      if (operation.applied) return state;
      const kind = text(event.kind);
      const message = text(event.message);
      if (!message) return state;
      const allowed: readonly string[] = [
        "publisher-withdrawn",
        "stale-binding",
        "stale-descriptor",
        "invalid-control",
        "invalidated",
      ];
      if (kind !== undefined && !allowed.includes(kind)) return state;
      const conflict: ComposerOperationConflict = {
        kind: (kind ?? "invalidated") as ComposerOperationConflictKind,
        message,
      };
      const busy = isActive(operation.status) || operation.status === "conflict";
      if (!busy) {
        // Only raise the explanation; nothing live is cancelled.
        return {
          ...state,
          revision: state.revision + 1,
          updatedAt: at,
          operation: {
            ...operation,
            conflict,
            revision: operation.revision + 1,
            updatedAt: at,
          },
        };
      }
      return {
        ...state,
        revision: state.revision + 1,
        updatedAt: at,
        operation: {
          ...operation,
          status: "cancelled",
          conflict,
          revision: operation.revision + 1,
          updatedAt: at,
        },
      };
    }

    default:
      // Old/unknown frames are ignored, never guessed.
      return state;
  }
}

export function reduceComposerOperationForTab(
  registry: ComposerOperationRegistry,
  tabId: string,
  event: unknown,
  now = Date.now(),
): ComposerOperationRegistry {
  if (typeof tabId !== "string" || tabId.length === 0) return registry;
  const current = composerTabOperation(registry, tabId);
  const next = reduceComposerOperation(current, event, now);
  if (next === current) return registry;
  return { ...registry, tabs: { ...registry.tabs, [tabId]: next } };
}

/** Convenience for tests/UI: typed control view from the projection. */
export function composerControlView(control: ComposerControlDescriptor): ContributionView {
  return {
    ownerId: control.ownerId,
    id: control.id,
    kind: "composer-control",
    slot: "composer-actions",
    tone: control.tone as ContributionView["tone"],
    order: 0,
    text: control.label,
    ...(control.description === undefined ? {} : { detail: control.description }),
    ...(control.icon === undefined ? {} : { icon: control.icon }),
    ...(control.behavior === undefined ? {} : { behavior: control.behavior }),
    checked: control.checked,
    enabled: control.enabled,
    ...(control.disabledReason === undefined ? {} : { disabledReason: control.disabledReason }),
    actionRef: control.actionRef,
    transformActionRef: control.transformActionRef,
  };
}
