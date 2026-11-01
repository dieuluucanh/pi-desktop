/**
 * Extension-notification mute rules (2026-10-31 UI polish plan).
 *
 * Pi's `ctx.ui.notify(message, type)` is shared by every installed extension and
 * carries **no source attribution** — the SDK hands each extension the same
 * `ExtensionUIContext`, so the host cannot tell which extension raised a
 * warning. The desktop therefore derives a stable rule from the message itself:
 *
 *  - `exact`    — the normalized text (lower-case, whitespace-collapsed);
 *  - `template` — the text with variable-looking tokens replaced by `*`
 *                 (numbers, quoted values, `provider/model` refs and thinking
 *                 levels). This is the "warnings like this" choice;
 *  - `type`     — every notification of one type (`info`/`warning`/`error`).
 *
 * The rules are persisted in `prefs.notifications` (see `src/shared/prefs.ts`).
 * They are deliberately *not* a second notification archive: the history keeps
 * every arrival, and muting only hides it from the transcript/toast surfaces so
 * it can be restored with Unmute.
 */

import type { ExtensionNotifyType } from "./extension-ui";

/** How a mute rule matches an incoming notification. */
export type NotificationMuteScope = "exact" | "template" | "type";

/** The minimum shape a rule needs to evaluate. */
export interface NotificationLike {
  message: string;
  type: ExtensionNotifyType;
}

/** One persisted mute rule. */
export interface NotificationMuteRule {
  /** Stable identity, recomputed from `scope`, `type` and `value`. */
  id: string;
  scope: NotificationMuteScope;
  type: ExtensionNotifyType;
  /** Normalized text (`exact`), signature (`template`), or the type (`type`). */
  value: string;
  /** A bounded copy of a message that produced the rule, for the Settings list. */
  sample: string;
  /** Arrival time of the rule (ms since epoch). */
  createdAt: number;
}

/** The notification slice of `UiPrefs`. */
export interface NotificationPrefs {
  muted: NotificationMuteRule[];
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = { muted: [] };

/** Keep `app-state.json` bounded; old rules fall off the end. */
export const MAX_MUTE_RULES = 50;

/** A repeated identical toast is suppressed for this long (per tab). */
export const NOTIFICATION_REPEAT_WINDOW_MS = 5 * 60_000;

/** The longest message copy retained for a rule's Settings label. */
export const MAX_NOTIFICATION_SAMPLE = 160;

/** The longest stored `value` (a normalized message can be long). */
export const MAX_NOTIFICATION_VALUE = 400;

const NOTIFICATION_TYPES: readonly ExtensionNotifyType[] = ["info", "warning", "error"];
const MUTE_SCOPES: readonly NotificationMuteScope[] = ["exact", "template", "type"];

/** Lower-case and collapse whitespace; matching is intentionally case-insensitive. */
export function normalizeNotificationText(message: string): string {
  return message.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The "warnings like this" signature.
 *
 * Real-world messages carry the changing part in a few predictable places: a
 * requested/effective thinking level, a model reference, a number, or a quoted
 * value. Replacing those with `*` keeps the stable sentence shape and makes
 * `Workflow plan: thinking xhigh → high (…)` and
 * `Workflow plan: thinking medium → high (…)` the same rule.
 */
export function notificationSignature(message: string): string {
  return normalizeNotificationText(message)
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "*")
    .replace(/\b[\w.-]+(?:\/[\w.:-]+)+\b/g, "*")
    .replace(/\b(?:off|minimal|low|medium|high|xhigh|max)\b/g, "*")
    .replace(/\d+(?:\.\d+)?/g, "*")
    .replace(/\s+/g, " ")
    .trim();
}

/** The deterministic id for a rule (the stored `id` is never trusted). */
export function notificationRuleId(
  scope: NotificationMuteScope,
  type: ExtensionNotifyType,
  value: string,
): string {
  return `${scope}\u0000${type}\u0000${value}`;
}

/** Builds the rule a mute-dialog choice would save. */
export function muteRuleFor(
  notification: NotificationLike,
  scope: NotificationMuteScope,
  now = Date.now(),
): NotificationMuteRule {
  const value =
    scope === "type"
      ? notification.type
      : scope === "template"
        ? notificationSignature(notification.message)
        : normalizeNotificationText(notification.message);
  return {
    id: notificationRuleId(scope, notification.type, value),
    scope,
    type: notification.type,
    value,
    sample: notification.message.slice(0, MAX_NOTIFICATION_SAMPLE),
    createdAt: now,
  };
}

/** True when one rule silences this notification. */
export function notificationMatchesRule(
  notification: NotificationLike,
  rule: NotificationMuteRule,
): boolean {
  if (rule.type !== notification.type) return false;
  if (rule.scope === "type") return true;
  const text =
    rule.scope === "template"
      ? notificationSignature(notification.message)
      : normalizeNotificationText(notification.message);
  return text === rule.value;
}

/** The first rule that silences a notification, or null. */
export function matchingMuteRule(
  notification: NotificationLike,
  rules: readonly NotificationMuteRule[],
): NotificationMuteRule | null {
  for (const rule of rules) {
    if (notificationMatchesRule(notification, rule)) return rule;
  }
  return null;
}

/** True when any persisted rule silences the notification. */
export function isNotificationMuted(
  notification: NotificationLike,
  prefs: NotificationPrefs | undefined,
): boolean {
  return matchingMuteRule(notification, prefs?.muted ?? []) !== null;
}

/**
 * Adds a rule, newest first, dropping a previous rule with the same id and
 * trimming the list to {@link MAX_MUTE_RULES}. The input array is not mutated.
 */
export function withMuteRule(
  prefs: NotificationPrefs,
  rule: NotificationMuteRule,
): NotificationPrefs {
  const rest = prefs.muted.filter((entry) => entry.id !== rule.id);
  return { muted: [rule, ...rest].slice(0, MAX_MUTE_RULES) };
}

/** Removes one rule by id. */
export function removeMuteRule(prefs: NotificationPrefs, id: string): NotificationPrefs {
  return { muted: prefs.muted.filter((entry) => entry.id !== id) };
}

/** Removes every rule that silences this notification (the history's Unmute). */
export function removeMutesForNotification(
  prefs: NotificationPrefs,
  notification: NotificationLike,
): NotificationPrefs {
  return {
    muted: prefs.muted.filter((rule) => !notificationMatchesRule(notification, rule)),
  };
}

/** A short, human-readable label for the Settings list. */
export function notificationRuleLabel(rule: NotificationMuteRule): string {
  if (rule.scope === "type") return `All ${rule.type} notifications`;
  if (rule.scope === "exact") return `“${rule.sample}”`;
  return `Notifications like “${rule.sample}”`;
}

/**
 * True when an identical notification arrived recently enough that its toast
 * should be suppressed. A clock that moved backwards is treated as "not
 * recent" rather than suppressing a new warning indefinitely.
 */
export function shouldCollapseNotification(
  lastAt: number | undefined,
  now: number,
  windowMs = NOTIFICATION_REPEAT_WINDOW_MS,
): boolean {
  if (typeof lastAt !== "number" || !Number.isFinite(lastAt) || lastAt <= 0) return false;
  const delta = now - lastAt;
  return delta >= 0 && delta < windowMs;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asType(value: unknown): ExtensionNotifyType | null {
  return typeof value === "string" && (NOTIFICATION_TYPES as readonly string[]).includes(value)
    ? (value as ExtensionNotifyType)
    : null;
}

function asScope(value: unknown): NotificationMuteScope | null {
  return typeof value === "string" && (MUTE_SCOPES as readonly string[]).includes(value)
    ? (value as NotificationMuteScope)
    : null;
}

/**
 * Validates a persisted `prefs.notifications` document.
 *
 * Unknown scopes/types, empty values and malformed samples are dropped, the
 * `id` is recomputed (a hand-edited file cannot alias two rules), duplicates and
 * over-cap lists are trimmed, and the result always contains a fresh array.
 */
export function sanitizeNotificationPrefs(input: unknown): NotificationPrefs {
  const source = asRecord(input);
  const raw = Array.isArray(source.muted) ? source.muted : [];
  const seen = new Set<string>();
  const muted: NotificationMuteRule[] = [];
  for (const entry of raw) {
    if (muted.length >= MAX_MUTE_RULES) break;
    const record = asRecord(entry);
    const scope = asScope(record.scope);
    const type = asType(record.type);
    const value = asString(record.value);
    if (!scope || !type || !value) continue;
    const storedValue = value.slice(0, MAX_NOTIFICATION_VALUE);
    const id = notificationRuleId(scope, type, storedValue);
    if (seen.has(id)) continue;
    seen.add(id);
    const sample = (asString(record.sample) ?? storedValue).trim();
    const createdAt =
      typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
        ? Math.max(0, Math.floor(record.createdAt))
        : 0;
    muted.push({
      id,
      scope,
      type,
      value: storedValue,
      sample: sample.slice(0, MAX_NOTIFICATION_SAMPLE),
      createdAt,
    });
  }
  return { muted };
}
