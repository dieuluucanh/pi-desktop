/**
 * The Extensions hub's data model (plan step 13).
 *
 * The host reports what Pi actually loaded (extensions, skills, prompt
 * templates, themes) with their provenance, contributed tools/commands/
 * shortcuts/flags and loader diagnostics. Everything here is pure and shared by
 * the host, the renderer and the tests, so the wire shape has exactly one
 * definition and a hostile/foreign payload can be sanitized before it is used.
 *
 * Enable/disable is not a separate mechanism: Pi resolves resources through the
 * `extensions` / `skills` / `prompts` / `themes` settings arrays, where `-path`
 * force-excludes and `+path` force-includes an exact resource. The helpers here
 * build those entries so the app never hand-writes a Pi state file.
 */

import type { SettingsScope } from "./settings-schema";

/** The four settings arrays that own resources. */
export const RESOURCE_KINDS = ["extensions", "skills", "prompts", "themes"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export function isResourceKind(value: unknown): value is ResourceKind {
  return typeof value === "string" && (RESOURCE_KINDS as readonly string[]).includes(value);
}

export const RESOURCE_SCOPES = ["user", "project", "temporary"] as const;
export type ResourceScope = (typeof RESOURCE_SCOPES)[number];

export function isResourceScope(value: unknown): value is ResourceScope {
  return typeof value === "string" && (RESOURCE_SCOPES as readonly string[]).includes(value);
}

export const RESOURCE_ORIGINS = ["package", "top-level"] as const;
export type ResourceOrigin = (typeof RESOURCE_ORIGINS)[number];

export function isResourceOrigin(value: unknown): value is ResourceOrigin {
  return typeof value === "string" && (RESOURCE_ORIGINS as readonly string[]).includes(value);
}

export type ContributedKind = "tool" | "command" | "shortcut" | "flag";

/** One thing an extension registered, shown on its card. */
export interface ResourceContribution {
  kind: ContributedKind;
  name: string;
  description?: string;
  /** Argument hint for commands, current value for flags. */
  detail?: string;
}

/** One loaded (or explicitly disabled) resource. */
export interface ResourceSummary {
  /** Stable identity: `<kind>:<posix path>`. */
  id: string;
  kind: ResourceKind;
  name: string;
  description?: string;
  /** Absolute path Pi loaded it from (as reported by Pi). */
  path: string;
  /** `path` with forward slashes — the token a settings override uses. */
  overridePath: string;
  source: string;
  scope: ResourceScope;
  origin: ResourceOrigin;
  /** The settings array that owns this resource's enable/disable override. */
  settingsKey: ResourceKind;
  enabled: boolean;
  hidden?: boolean;
  contributed?: ResourceContribution[];
  /** A load error Pi reported for this resource specifically. */
  error?: string;
  /** Prompt templates carry an argument hint. */
  argumentHint?: string;
  /** Skills excluded from the model prompt. */
  disableModelInvocation?: boolean;
  /** The raw settings entry that disabled this resource (when `enabled` is false). */
  override?: string;
}

/** An override entry that targets a glob the app cannot turn into a resource. */
export interface ResourceOverride {
  kind: ResourceKind;
  scope: SettingsScope;
  entry: string;
}

export interface ResourceDiagnosticSummary {
  type: "warning" | "error" | "collision";
  message: string;
  path?: string;
  collision?: {
    resourceType: string;
    name: string;
    winnerPath: string;
    loserPath: string;
    winnerSource?: string;
    loserSource?: string;
  };
}

/** An error an extension threw while handling a live event (session hosts only). */
export interface ExtensionRuntimeErrorSummary {
  extensionPath: string;
  event: string;
  error: string;
  stack?: string;
  at: number;
}

/** The whole hub payload. */
export interface ResourcesSnapshot {
  cwd: string | null;
  /** Which host answered: the app-wide control host, or a live session. */
  scope: "control" | "session";
  resources: ResourceSummary[];
  overrides: ResourceOverride[];
  diagnostics: ResourceDiagnosticSummary[];
  runtimeErrors: ExtensionRuntimeErrorSummary[];
  loadedAt: number;
}

export const EMPTY_RESOURCES: ResourcesSnapshot = {
  cwd: null,
  scope: "control",
  resources: [],
  overrides: [],
  diagnostics: [],
  runtimeErrors: [],
  loadedAt: 0,
};

/** Forward slashes on every platform so an override written on Windows matches. */
export function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

/** Strips a leading `+`/`-`/`!` override prefix and normalizes separators. */
export function normalizeOverrideToken(entry: string): string {
  const trimmed = entry.trim();
  const bare =
    trimmed.startsWith("+") || trimmed.startsWith("-") || trimmed.startsWith("!")
      ? trimmed.slice(1)
      : trimmed;
  return toPosixPath(bare);
}

/** True when a settings entry carries an override prefix (`+`, `-` or `!`). */
export function isOverrideEntry(entry: string): boolean {
  const trimmed = entry.trim();
  return trimmed.startsWith("+") || trimmed.startsWith("-") || trimmed.startsWith("!");
}

/** A `!`/`-` entry that disables its target (a `+` entry enables). */
export function isDisabledOverride(entry: string): boolean {
  const trimmed = entry.trim();
  return trimmed.startsWith("-") || trimmed.startsWith("!");
}

/** True when an override token is a glob (for example `!path/to/*.ts`). */
export function hasGlobChars(value: string): boolean {
  return value.includes("*") || value.includes("?");
}

export function resourceIdOf(kind: ResourceKind, path: string): string {
  return `${kind}:${toPosixPath(path)}`;
}

/** Which settings scope carries a resource's enable/disable override. */
export function settingsScopeForResource(scope: ResourceScope): SettingsScope {
  return scope === "project" ? "project" : "global";
}

/**
 * The settings array after toggling one exact resource.
 *
 * Pi's rule (`isEnabledByOverrides`): `-path` force-excludes, `+path` force-
 * includes, and later entries win. Adding the token after removing any earlier
 * one for the same path makes the operation idempotent.
 */
export function applyResourceOverride(
  entries: readonly string[],
  overridePath: string,
  enabled: boolean,
): string[] {
  const target = toPosixPath(overridePath);
  const kept = entries.filter((entry) => normalizeOverrideToken(entry) !== target);
  return [...kept, `${enabled ? "+" : "-"}${target}`];
}

/** The entry that would disable a loaded resource (used to render "Disable"). */
export function resourceOverrideEntry(resource: ResourceSummary): string {
  return `${resource.enabled ? "-" : "+"}${resource.overridePath}`;
}

/** Finds a resource by its stable id. */
export function findResource(
  resources: readonly ResourceSummary[],
  id: string,
): ResourceSummary | undefined {
  return resources.find((resource) => resource.id === id);
}

// ---------------------------------------------------------------------------
// Sanitizers — the renderer never trusts a raw host payload.
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asScope(value: unknown): ResourceScope {
  return (RESOURCE_SCOPES as readonly string[]).includes(value as string)
    ? (value as ResourceScope)
    : "user";
}

function asOrigin(value: unknown): ResourceOrigin {
  return value === "package" || value === "top-level" ? value : "top-level";
}

const CONTRIBUTED_KINDS: readonly ContributedKind[] = ["tool", "command", "shortcut", "flag"];

function sanitizeContribution(value: unknown): ResourceContribution | null {
  const record = asRecord(value);
  const kind = record.kind;
  const name = asString(record.name);
  if (!name || !(CONTRIBUTED_KINDS as readonly string[]).includes(kind as string)) return null;
  const description = asString(record.description);
  const detail = asString(record.detail);
  return {
    kind: kind as ContributedKind,
    name,
    ...(description ? { description } : {}),
    ...(detail ? { detail } : {}),
  };
}

export function sanitizeResourceSummary(value: unknown): ResourceSummary | null {
  const record = asRecord(value);
  const kind = record.kind;
  const path = asString(record.path);
  if (!isResourceKind(kind) || !path) return null;
  const overridePath = toPosixPath(asString(record.overridePath) ?? path);
  const contributions = Array.isArray(record.contributed)
    ? record.contributed
        .map(sanitizeContribution)
        .filter((entry): entry is ResourceContribution => entry !== null)
    : [];
  const argumentHint = asString(record.argumentHint);
  const override = asString(record.override);
  const error = asString(record.error);
  const description = asString(record.description);
  return {
    id: asString(record.id) ?? resourceIdOf(kind, overridePath),
    kind,
    name: asString(record.name) ?? basenameOf(overridePath),
    ...(description ? { description } : {}),
    path,
    overridePath,
    source: asString(record.source) ?? "unknown",
    scope: asScope(record.scope),
    origin: asOrigin(record.origin),
    settingsKey: isResourceKind(record.settingsKey) ? record.settingsKey : kind,
    enabled: asBoolean(record.enabled) ?? true,
    ...(asBoolean(record.hidden) === true ? { hidden: true } : {}),
    ...(contributions.length > 0 ? { contributed: contributions } : {}),
    ...(error ? { error } : {}),
    ...(argumentHint ? { argumentHint } : {}),
    ...(asBoolean(record.disableModelInvocation) === true ? { disableModelInvocation: true } : {}),
    ...(override ? { override } : {}),
  };
}

const DIAGNOSTIC_TYPES: readonly ResourceDiagnosticSummary["type"][] = [
  "warning",
  "error",
  "collision",
];

function sanitizeDiagnostic(value: unknown): ResourceDiagnosticSummary | null {
  const record = asRecord(value);
  const message = asString(record.message);
  if (!message) return null;
  const type = (DIAGNOSTIC_TYPES as readonly string[]).includes(record.type as string)
    ? (record.type as ResourceDiagnosticSummary["type"])
    : "warning";
  const path = asString(record.path);
  const collisionSource = asRecord(record.collision);
  const collision =
    message.length > 0 && asString(collisionSource.name)
      ? {
          resourceType: asString(collisionSource.resourceType) ?? "extension",
          name: asString(collisionSource.name) ?? "",
          winnerPath: asString(collisionSource.winnerPath) ?? "",
          loserPath: asString(collisionSource.loserPath) ?? "",
          ...(asString(collisionSource.winnerSource)
            ? { winnerSource: asString(collisionSource.winnerSource) }
            : {}),
          ...(asString(collisionSource.loserSource)
            ? { loserSource: asString(collisionSource.loserSource) }
            : {}),
        }
      : undefined;
  return {
    type,
    message,
    ...(path ? { path } : {}),
    ...(collision ? { collision } : {}),
  };
}

function sanitizeRuntimeError(value: unknown): ExtensionRuntimeErrorSummary | null {
  const record = asRecord(value);
  const error = asString(record.error);
  if (!error) return null;
  const stack = asString(record.stack);
  return {
    extensionPath: asString(record.extensionPath) ?? "",
    event: asString(record.event) ?? "unknown",
    error,
    ...(stack ? { stack } : {}),
    at: asNumber(record.at) ?? 0,
  };
}

export function sanitizeResourcesSnapshot(value: unknown): ResourcesSnapshot {
  const record = asRecord(value);
  const resources = Array.isArray(record.resources)
    ? record.resources
        .map(sanitizeResourceSummary)
        .filter((entry): entry is ResourceSummary => entry !== null)
    : [];
  const overrides = Array.isArray(record.overrides)
    ? record.overrides.flatMap((entry): ResourceOverride[] => {
        const item = asRecord(entry);
        const kind = item.kind;
        const raw = asString(item.entry);
        if (!isResourceKind(kind) || !raw) return [];
        return [
          {
            kind,
            scope: item.scope === "project" ? "project" : "global",
            entry: raw,
          },
        ];
      })
    : [];
  const diagnostics = Array.isArray(record.diagnostics)
    ? record.diagnostics
        .map(sanitizeDiagnostic)
        .filter((entry): entry is ResourceDiagnosticSummary => entry !== null)
    : [];
  const runtimeErrors = Array.isArray(record.runtimeErrors)
    ? record.runtimeErrors
        .map(sanitizeRuntimeError)
        .filter((entry): entry is ExtensionRuntimeErrorSummary => entry !== null)
    : [];
  return {
    cwd: asString(record.cwd) ?? null,
    scope: record.scope === "session" ? "session" : "control",
    resources,
    overrides,
    diagnostics,
    runtimeErrors,
    loadedAt: asNumber(record.loadedAt) ?? 0,
  };
}

/** Last path segment, for a display name when Pi reported none. */
export function basenameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed || path;
}

/**
 * A stable sort for display: kind, then name. The host list is a set, not an
 * order, so the UI must not depend on Pi's load order.
 */
export function sortResources(resources: readonly ResourceSummary[]): ResourceSummary[] {
  const kindRank = new Map<string, number>(RESOURCE_KINDS.map((kind, index) => [kind, index]));
  return [...resources].sort((a, b) => {
    const byKind = (kindRank.get(a.kind) ?? 0) - (kindRank.get(b.kind) ?? 0);
    if (byKind !== 0) return byKind;
    return a.name.localeCompare(b.name);
  });
}

/** What a runtime reload changed, for the hub's "what changed" note. */
export interface ResourceChangeSummary {
  added: ResourceSummary[];
  removed: ResourceSummary[];
  changed: Array<{ before: ResourceSummary; after: ResourceSummary; reason: string }>;
}

/**
 * Compares two snapshots by resource id. Only observable fields count, so a
 * reload that changed nothing reports nothing instead of a noisy list.
 */
export function diffResources(
  before: readonly ResourceSummary[],
  after: readonly ResourceSummary[],
): ResourceChangeSummary {
  const beforeById = new Map(before.map((resource) => [resource.id, resource]));
  const afterById = new Map(after.map((resource) => [resource.id, resource]));
  const added: ResourceSummary[] = [];
  const removed: ResourceSummary[] = [];
  const changed: ResourceChangeSummary["changed"] = [];

  for (const resource of after) {
    if (!beforeById.has(resource.id)) added.push(resource);
  }
  for (const resource of before) {
    const next = afterById.get(resource.id);
    if (!next) {
      removed.push(resource);
      continue;
    }
    if (next.enabled !== resource.enabled) {
      changed.push({
        before: resource,
        after: next,
        reason: next.enabled ? "enabled" : "disabled",
      });
      continue;
    }
    if ((next.contributed?.length ?? 0) !== (resource.contributed?.length ?? 0)) {
      const delta = (next.contributed?.length ?? 0) - (resource.contributed?.length ?? 0);
      changed.push({
        before: resource,
        after: next,
        reason: `${delta > 0 ? "+" : ""}${delta} registered item(s)`,
      });
      continue;
    }
    if ((next.error ? 1 : 0) !== (resource.error ? 1 : 0)) {
      changed.push({
        before: resource,
        after: next,
        reason: next.error ? "now failing" : "recovered",
      });
    }
  }

  return { added, removed, changed };
}

/** True when a reload changed nothing the hub shows. */
export function isResourceChangeEmpty(summary: ResourceChangeSummary): boolean {
  return summary.added.length === 0 && summary.removed.length === 0 && summary.changed.length === 0;
}
