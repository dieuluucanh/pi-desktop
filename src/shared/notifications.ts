/**
 * Extension-notification mute rules and notification classes
 * (2026-10-31 UI polish plan, 2026-11-08 updates/notifications plan,
 * 2026-11-15 extension-command-output parity).
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
 * Because no source is available, the coarse class is severity plus the one
 * app-owned kind: `update`, `error`, `warning`, `info`. `info` is off by default
 * so background chatter ("Server logs ready (local)") does not fill the bell or
 * toasts. The transcript always prints every `ctx.ui.notify` (terminal parity);
 * classes and mute rules never hide a transcript row. Class-hidden
 * notifications stay in the archive and can be revealed from the notification
 * popover.
 *
 * The rules are persisted in `prefs.notifications` (see `src/shared/prefs.ts`).
 * They are deliberately *not* a second notification archive: the history keeps
 * every arrival, and muting only hides it from the bell/toast surfaces so it can
 * be restored with Unmute.
 *
 * ## Two channels, one bell
 *
 * The archive holds *events*: extension `ctx.ui.notify` output only. The app's
 * own offers — a newer release and a set of outdated packages — are **state**,
 * not arrivals: {@link offerNotifications} derives them from live renderer state
 * on every render, and they are never stored. That makes a stale row
 * structurally impossible: an offer row exists iff its condition is true and the
 * user has not dismissed it (`prefs.updates.dismissedVersion` /
 * `prefs.packages.dismissedSignature`). Adding a third app-owned offer means
 * adding it to that one function and to the store's dismissal routing.
 *
 * Because offers are state, per-message mute rules never apply to them
 * ({@link isNotificationSuppressed} is for archived rows). An offer is gated by
 * its class switch and by an explicit `×`/Clear only.
 */

import { packageUpdateSignature } from "./packages";
import type { PackageUpdateSummary } from "./packages";
import type { ExtensionNotification, ExtensionNotifyType } from "./extension-ui";
import type { UpdatePhase } from "./updates";

/** The coarse classes the notification surfaces group and toggle. */
export const NOTIFICATION_CLASSES = ["update", "extension", "error", "warning", "info"] as const;
export type NotificationClass = (typeof NOTIFICATION_CLASSES)[number];

/** Copy for the Settings class switches. */
export interface NotificationClassMeta {
  label: string;
  description: string;
}

export const NOTIFICATION_CLASS_META: Record<NotificationClass, NotificationClassMeta> = {
  update: {
    label: "App updates",
    description: "New Pi Desktop versions and install prompts.",
  },
  extension: {
    label: "Extension updates",
    description: "New versions of installed packages and extensions.",
  },
  error: {
    label: "Errors",
    description: "Extension errors.",
  },
  warning: {
    label: "Warnings",
    description: "Extension warnings.",
  },
  info: {
    label: "Informational messages",
    description: "Status and command messages; the transcript always prints them.",
  },
};

/** Per-class visibility; a false value hides that class from the bell and toasts. */
export interface NotificationClassPrefs {
  update: boolean;
  extension: boolean;
  error: boolean;
  warning: boolean;
  info: boolean;
}

/**
 * Warnings and errors are actionable, updates are the app's own offer, but
 * informational chatter is opt-in for the bell and toasts: a fresh profile must
 * not be flooded there by an extension that reports every state change. The
 * transcript always prints extension output.
 */
export const DEFAULT_NOTIFICATION_CLASSES: NotificationClassPrefs = {
  update: true,
  extension: true,
  error: true,
  warning: true,
  info: false,
};

/** How a mute rule matches an incoming notification. */
export type NotificationMuteScope = "exact" | "template" | "type";

/** The minimum shape a rule needs to evaluate. */
export interface NotificationLike {
  message: string;
  type: ExtensionNotifyType;
  /**
   * The explicit class for app-owned notifications. Extension notifications and
   * transcript notices omit it; their class is their severity (see
   * {@link notificationClassOf}).
   */
  class?: NotificationClass;
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
  classes: NotificationClassPrefs;
  muted: NotificationMuteRule[];
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  classes: { ...DEFAULT_NOTIFICATION_CLASSES },
  muted: [],
};

/** What clicking a notification can do besides being dismissed. */
export type NotificationAction = { kind: "open-updates" } | { kind: "open-extensions" };

/**
 * The updater phases that still ask the user to act (or are acting on their
 * behalf). Every other phase means there is nothing to offer.
 */
export const UPDATE_OFFER_PHASES = ["available", "downloading", "downloaded"] as const;

export type UpdateOfferPhase = (typeof UPDATE_OFFER_PHASES)[number];

/** Narrows any updater phase to the ones an offer row describes. */
export function isUpdateOfferPhase(
  phase: UpdatePhase | null | undefined,
): phase is UpdateOfferPhase {
  return typeof phase === "string" && (UPDATE_OFFER_PHASES as readonly string[]).includes(phase);
}

/**
 * One row in the unified archive. Extension notifications carry the tab that
 * raised them; app-owned notifications have no tab and may carry an action.
 */
export interface AppNotification extends NotificationLike {
  id: string;
  class: NotificationClass;
  tabId: string | null;
  at: number;
  action: NotificationAction | null;
}

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

/** The class a notification belongs to; an explicit app class wins. */
export function notificationClassOf(notification: NotificationLike): NotificationClass {
  return notification.class ?? notification.type;
}

/**
 * True unless the user turned this class off. A missing field (an older
 * app-state file or a test fixture) falls back to the class default.
 */
export function isNotificationClassEnabled(
  prefs: NotificationPrefs | undefined,
  klass: NotificationClass,
): boolean {
  return prefs?.classes?.[klass] ?? DEFAULT_NOTIFICATION_CLASSES[klass];
}

/** Converts the wire shape into an archived app notification. */
export function appNotificationFromExtension(notification: ExtensionNotification): AppNotification {
  return {
    id: notification.id,
    message: notification.message,
    type: notification.type,
    class: notification.type,
    tabId: notification.tabId,
    at: notification.at,
    action: null,
  };
}

/** The stable id of an update offer's notification. */
export function updateNotificationId(version: string): string {
  return `app:update:${version}`;
}

/** The copy for each phase an update offer can describe. */
const UPDATE_OFFER_MESSAGES: Record<UpdateOfferPhase, (label: string) => string> = {
  available: (label) => `Pi Desktop v${label} is available.`,
  downloading: (label) => `Pi Desktop v${label} is downloading.`,
  downloaded: (label) => `Pi Desktop v${label} is ready to install.`,
};

/**
 * The row describing an offered release. `phase` is appended so the existing
 * positional `(version, at)` calls keep working; the copy follows the updater so
 * a downloaded release never reads "is available".
 */
export function updateNotification(
  version: string,
  at = Date.now(),
  phase: UpdateOfferPhase = "available",
): AppNotification {
  const label = version.trim().replace(/^v/i, "");
  return {
    id: updateNotificationId(version),
    message: UPDATE_OFFER_MESSAGES[phase](label),
    type: "info",
    class: "update",
    tabId: null,
    at,
    action: { kind: "open-updates" },
  };
}

/** FNV-1a, so a long update signature becomes a short stable row id. */
function notificationKeyFingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The stable id of the "extensions can be updated" row. The signature is the
 * *set* of outdated packages, so a new package or a newer target raises a new
 * row while a dismissed identical set stays dismissed.
 */
export function packageUpdateNotificationId(signature: string): string {
  return `app:packages:${notificationKeyFingerprint(signature)}`;
}

/** The one notification raised when installed packages have newer versions. */
export function packageUpdateNotification(
  count: number,
  signature: string,
  at = Date.now(),
): AppNotification {
  const safeCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
  return {
    id: packageUpdateNotificationId(signature),
    message: `${safeCount} extension update${safeCount === 1 ? "" : "s"} available.`,
    type: "info",
    class: "extension",
    tabId: null,
    at,
    action: { kind: "open-extensions" },
  };
}

/**
 * Everything {@link offerNotifications} reads. Deliberately structural (phase,
 * version, the update list and the prefs it needs) so the renderer can pass its
 * state without this module importing the prefs module.
 */
export interface NotificationOfferInput {
  /** Offers stay blank until the stored class switches have loaded. */
  prefsLoaded: boolean;
  prefs: NotificationPrefs;
  update: { phase: UpdatePhase; version: string | null; checkedAt: number | null } | null;
  packageUpdates: readonly PackageUpdateSummary[];
  packageUpdatesCheckedAt: number | null;
  /** The release whose row the user removed with `×`/Clear. */
  dismissedVersion: string | null;
  /** The update set whose row the user removed with `×`/Clear. */
  dismissedSignature: string | null;
}

/**
 * The app-owned offer rows that describe *current* state, newest concern first:
 * the release offer, then the extension-update offer. An empty answer is the
 * normal "nothing to do" case.
 *
 * Each row is produced only when its class switch is on and its identity is not
 * the persisted dismissal marker, so a stale row cannot survive a state change
 * and a dismissed set stays dismissed until a new version/set appears. Per-message
 * mute rules are intentionally ignored here (see the module header).
 */
export function offerNotifications(input: NotificationOfferInput): AppNotification[] {
  if (!input.prefsLoaded) return [];
  const offers: AppNotification[] = [];

  const update = input.update;
  if (
    update &&
    isNotificationClassEnabled(input.prefs, "update") &&
    typeof update.version === "string" &&
    update.version.length > 0 &&
    isUpdateOfferPhase(update.phase) &&
    input.dismissedVersion !== update.version
  ) {
    offers.push(updateNotification(update.version, update.checkedAt ?? 0, update.phase));
  }

  if (isNotificationClassEnabled(input.prefs, "extension") && input.packageUpdates.length > 0) {
    const signature = packageUpdateSignature(input.packageUpdates);
    if (signature.length > 0 && input.dismissedSignature !== signature) {
      offers.push(
        packageUpdateNotification(
          input.packageUpdates.length,
          signature,
          input.packageUpdatesCheckedAt ?? 0,
        ),
      );
    }
  }

  return offers;
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

/** True when a rule silences the notification (class-independent). */
export function isNotificationMuted(
  notification: NotificationLike,
  prefs: NotificationPrefs | undefined,
): boolean {
  return matchingMuteRule(notification, prefs?.muted ?? []) !== null;
}

/**
 * True when an *archived* notification must not appear in the bell or a toast:
 * its class is off, or a per-message rule silences it. The transcript always
 * prints `ctx.ui.notify` output (terminal parity); the archive still keeps every
 * arrival (see the module header). App-owned offers are not archived and are
 * never passed through this predicate: a `type: "info"` rule must not hide an
 * update offer.
 */
export function isNotificationSuppressed(
  notification: NotificationLike,
  prefs: NotificationPrefs | undefined,
): boolean {
  if (!isNotificationClassEnabled(prefs, notificationClassOf(notification))) return true;
  return isNotificationMuted(notification, prefs);
}

/**
 * Adds a rule, newest first, dropping a previous rule with the same id and
 * trimming the list to {@link MAX_MUTE_RULES}. The input object is not mutated.
 */
export function withMuteRule(
  prefs: NotificationPrefs,
  rule: NotificationMuteRule,
): NotificationPrefs {
  const rest = prefs.muted.filter((entry) => entry.id !== rule.id);
  return { ...prefs, muted: [rule, ...rest].slice(0, MAX_MUTE_RULES) };
}

/** Removes one rule by id. */
export function removeMuteRule(prefs: NotificationPrefs, id: string): NotificationPrefs {
  return { ...prefs, muted: prefs.muted.filter((entry) => entry.id !== id) };
}

/** Removes every rule that silences this notification (the history's Unmute). */
export function removeMutesForNotification(
  prefs: NotificationPrefs,
  notification: NotificationLike,
): NotificationPrefs {
  return {
    ...prefs,
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
 * Unknown scopes/types/classes, empty values and malformed samples are dropped,
 * the `id` is recomputed (a hand-edited file cannot alias two rules), duplicates
 * and over-cap lists are trimmed, and the result always contains fresh objects.
 */
export function sanitizeNotificationPrefs(input: unknown): NotificationPrefs {
  const source = asRecord(input);
  const rawClasses = asRecord(source.classes);
  const classes: NotificationClassPrefs = { ...DEFAULT_NOTIFICATION_CLASSES };
  for (const klass of NOTIFICATION_CLASSES) {
    const value = rawClasses[klass];
    if (typeof value === "boolean") classes[klass] = value;
  }
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
  return { classes, muted };
}
