/**
 * The Extensions hub's host-side collector (plan step 13).
 *
 * Pi loads resources through `ResourceLoader` and, for a live session, binds them
 * to an `ExtensionRunner`. This module turns those SDK objects into the plain
 * `ResourcesSnapshot` the renderer consumes — and it is deliberately **pure**:
 * it reads `Map`s and plain records through small accessors, so a test can feed
 * fixture shapes with no SDK process and the composition root decides whether
 * the source is a live session or a control host's fresh `DefaultResourceLoader`.
 *
 * Enable/disable lives in the settings arrays, so the collector also derives the
 * *disabled* resources from `-`/`!` override entries; otherwise a disabled
 * resource would vanish from the hub and could never be re-enabled.
 */

import type { HostMethod } from "../shared/host-protocol";
import {
  basenameOf,
  hasGlobChars,
  isDisabledOverride,
  isOverrideEntry,
  isResourceOrigin,
  isResourceScope,
  normalizeOverrideToken,
  resourceIdOf,
  sortResources,
  toPosixPath,
  type ContributedKind,
  type ExtensionRuntimeErrorSummary,
  type ResourceContribution,
  type ResourceDiagnosticSummary,
  type ResourceKind,
  type ResourceOrigin,
  type ResourceScope,
  type ResourceOverride,
  type ResourceSummary,
  type ResourcesSnapshot,
} from "../shared/resources";
import type { SettingsScope } from "../shared/settings-schema";
import type { HostHandler } from "./service";

/** A handler that is deliberately not wired yet, with the step that owns it. */
export class ResourceError extends Error {
  readonly code: string;

  constructor(message: string, code = "not_implemented") {
    super(message);
    this.name = "ResourceError";
    this.code = code;
  }
}

/** The methods this module answers. */
export const RESOURCE_METHODS = ["resources.list"] as const satisfies readonly HostMethod[];

/** The four Pi loader collections, exactly as `ResourceLoader` returns them. */
export interface ResourceLoaderSource {
  extensions?: unknown;
  skills?: unknown;
  prompts?: unknown;
  themes?: unknown;
}

export interface ResourceInspectionInput {
  cwd: string | null;
  scope: "control" | "session";
  /** Both settings scopes; only the four resource arrays are read. */
  settings: { global: Record<string, unknown>; project: Record<string, unknown> };
  source: ResourceLoaderSource;
  /** Live `extension_error` history (a session host only). */
  runtimeErrors?: readonly unknown[];
  now?: () => number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Map or plain object → entries, so tests can pass either. */
function mapEntries(value: unknown): Array<[string, unknown]> {
  if (value instanceof Map) {
    const entries: Array<[string, unknown]> = [];
    for (const [key, entry] of value) entries.push([String(key), entry]);
    return entries;
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value as Record<string, unknown>)
    : [];
}

interface Provenance {
  source: string;
  scope: ResourceScope;
  origin: ResourceOrigin;
  path: string | null;
}

function provenanceOf(record: Record<string, unknown>): Provenance {
  const info = asRecord(record.sourceInfo);
  return {
    source: asString(info.source) ?? "unknown",
    scope: isResourceScope(info.scope) ? info.scope : "user",
    origin: isResourceOrigin(info.origin) ? info.origin : "top-level",
    path: asString(info.path) ?? null,
  };
}

function contribution(
  kind: ContributedKind,
  name: string,
  description: string | undefined,
  detail: string | undefined,
): ResourceContribution {
  return {
    kind,
    name,
    ...(description ? { description } : {}),
    ...(detail ? { detail } : {}),
  };
}

/** Everything one `Extension` registered, for its detail card. */
function extensionContributions(record: Record<string, unknown>): ResourceContribution[] {
  const contributed: ResourceContribution[] = [];
  for (const [key, value] of mapEntries(record.tools)) {
    const definition = asRecord(asRecord(value).definition);
    contributed.push(
      contribution(
        "tool",
        asString(definition.name) ?? key,
        asString(definition.description),
        undefined,
      ),
    );
  }
  for (const [key, value] of mapEntries(record.commands)) {
    const command = asRecord(value);
    contributed.push(
      contribution(
        "command",
        asString(command.name) ?? key,
        asString(command.description),
        undefined,
      ),
    );
  }
  for (const [key, value] of mapEntries(record.flags)) {
    const flag = asRecord(value);
    contributed.push(
      contribution(
        "flag",
        asString(flag.name) ?? key,
        asString(flag.description),
        asString(flag.type),
      ),
    );
  }
  for (const [key, value] of mapEntries(record.shortcuts)) {
    const shortcut = asRecord(value);
    contributed.push(
      contribution(
        "shortcut",
        asString(shortcut.shortcut) ?? key,
        asString(shortcut.description),
        undefined,
      ),
    );
  }
  return contributed;
}

function diagnosticOf(value: unknown): ResourceDiagnosticSummary | null {
  const record = asRecord(value);
  const message = asString(record.message);
  if (!message) return null;
  const type = record.type;
  const path = asString(record.path);
  const collision = asRecord(record.collision);
  const collisionName = asString(collision.name);
  return {
    type: type === "error" || type === "collision" ? type : "warning",
    message,
    ...(path ? { path } : {}),
    ...(collisionName
      ? {
          collision: {
            resourceType: asString(collision.resourceType) ?? "extension",
            name: collisionName,
            winnerPath: asString(collision.winnerPath) ?? "",
            loserPath: asString(collision.loserPath) ?? "",
            ...(asString(collision.winnerSource)
              ? { winnerSource: asString(collision.winnerSource) }
              : {}),
            ...(asString(collision.loserSource)
              ? { loserSource: asString(collision.loserSource) }
              : {}),
          },
        }
      : {}),
  };
}

function diagnosticsOf(value: unknown): ResourceDiagnosticSummary[] {
  const record = asRecord(value);
  return asArray(record.diagnostics)
    .map(diagnosticOf)
    .filter((entry): entry is ResourceDiagnosticSummary => entry !== null);
}

function runtimeErrorOf(value: unknown): ExtensionRuntimeErrorSummary | null {
  const record = asRecord(value);
  const error = asString(record.error);
  if (!error) return null;
  const stack = asString(record.stack);
  return {
    extensionPath: asString(record.extensionPath) ?? "",
    event: asString(record.event) ?? "unknown",
    error,
    ...(stack ? { stack } : {}),
    at: typeof record.at === "number" && Number.isFinite(record.at) ? record.at : 0,
  };
}

/** Load-time errors Pi reported for individual extension paths. */
function extensionErrorMap(value: unknown): Map<string, string> {
  const errors = asArray(asRecord(value).errors);
  const map = new Map<string, string>();
  for (const entry of errors) {
    const record = asRecord(entry);
    const path = asString(record.path);
    const error = asString(record.error);
    if (path && error) map.set(toPosixPath(path), error);
  }
  return map;
}

function buildExtensions(
  source: unknown,
  diagnostics: ResourceDiagnosticSummary[],
): { resources: ResourceSummary[]; errors: Array<{ path: string; error: string }> } {
  const result = asRecord(source);
  const loadErrors = extensionErrorMap(result);
  const resources: ResourceSummary[] = [];

  for (const value of asArray(result.extensions)) {
    const record = asRecord(value);
    const rawPath = asString(record.resolvedPath) ?? asString(record.path);
    if (!rawPath) continue;
    const overridePath = toPosixPath(rawPath);
    const provenance = provenanceOf(record);
    const contributed = extensionContributions(record);
    const error = loadErrors.get(overridePath);
    resources.push({
      id: resourceIdOf("extensions", overridePath),
      kind: "extensions",
      name: basenameOf(overridePath),
      path: rawPath,
      overridePath,
      source: provenance.source,
      scope: provenance.scope,
      origin: provenance.origin,
      settingsKey: "extensions",
      enabled: true,
      ...(record.hidden === true ? { hidden: true } : {}),
      ...(contributed.length > 0 ? { contributed } : {}),
      ...(error ? { error } : {}),
    });
  }

  // Loader diagnostics for the resource kinds ride along on the snapshot, and an
  // extension that failed to load entirely (so it never became a resource) must
  // still surface — never hidden, per the step-13 acceptance.
  diagnostics.push(...diagnosticsOf({ diagnostics: asArray(result.diagnostics) }));
  const matched = new Set(
    resources
      .filter((resource) => resource.error !== undefined)
      .map((resource) => resource.overridePath),
  );
  for (const [path, error] of loadErrors) {
    if (!matched.has(path)) diagnostics.push({ type: "error", message: error, path });
  }

  return {
    resources,
    errors: [...loadErrors.entries()].map(([path, error]) => ({ path, error })),
  };
}

function provenanceFromSourceInfo(record: Record<string, unknown>): Provenance {
  return provenanceOf(record);
}

function buildSkills(source: unknown, diagnostics: ResourceDiagnosticSummary[]): ResourceSummary[] {
  const result = asRecord(source);
  diagnostics.push(...diagnosticsOf(result));
  const resources: ResourceSummary[] = [];
  for (const value of asArray(result.skills)) {
    const record = asRecord(value);
    const provenance = provenanceFromSourceInfo(record);
    const rawPath = asString(record.filePath) ?? provenance.path;
    if (!rawPath) continue;
    const overridePath = toPosixPath(rawPath);
    resources.push({
      id: resourceIdOf("skills", overridePath),
      kind: "skills",
      name: asString(record.name) ?? basenameOf(overridePath),
      path: rawPath,
      overridePath,
      source: provenance.source,
      scope: provenance.scope,
      origin: provenance.origin,
      settingsKey: "skills",
      enabled: true,
      ...(asString(record.description) ? { description: asString(record.description) } : {}),
      ...(record.disableModelInvocation === true ? { disableModelInvocation: true } : {}),
    });
  }
  return resources;
}

function buildPrompts(
  source: unknown,
  diagnostics: ResourceDiagnosticSummary[],
): ResourceSummary[] {
  const result = asRecord(source);
  diagnostics.push(...diagnosticsOf(result));
  const resources: ResourceSummary[] = [];
  for (const value of asArray(result.prompts)) {
    const record = asRecord(value);
    const provenance = provenanceFromSourceInfo(record);
    const rawPath = asString(record.filePath) ?? provenance.path;
    if (!rawPath) continue;
    const overridePath = toPosixPath(rawPath);
    resources.push({
      id: resourceIdOf("prompts", overridePath),
      kind: "prompts",
      name: asString(record.name) ?? basenameOf(overridePath),
      path: rawPath,
      overridePath,
      source: provenance.source,
      scope: provenance.scope,
      origin: provenance.origin,
      settingsKey: "prompts",
      enabled: true,
      ...(asString(record.description) ? { description: asString(record.description) } : {}),
      ...(asString(record.argumentHint) ? { argumentHint: asString(record.argumentHint) } : {}),
    });
  }
  return resources;
}

function buildThemes(source: unknown, diagnostics: ResourceDiagnosticSummary[]): ResourceSummary[] {
  const result = asRecord(source);
  diagnostics.push(...diagnosticsOf(result));
  const resources: ResourceSummary[] = [];
  for (const value of asArray(result.themes)) {
    const record = asRecord(value);
    const provenance = provenanceFromSourceInfo(record);
    const rawPath = asString(record.sourcePath) ?? provenance.path;
    if (!rawPath) continue;
    const overridePath = toPosixPath(rawPath);
    resources.push({
      id: resourceIdOf("themes", overridePath),
      kind: "themes",
      name: asString(record.name) ?? basenameOf(overridePath),
      path: rawPath,
      overridePath,
      source: provenance.source,
      scope: provenance.scope,
      origin: provenance.origin,
      settingsKey: "themes",
      enabled: true,
    });
  }
  return resources;
}

/**
 * The disabled resources a settings scope still names.
 *
 * Pi's override syntax is `!glob`, `-exact` (force-exclude) and `+exact`
 * (force-include). Only exact entries can become a re-enableable row; globs are
 * reported verbatim in `overrides` and a `+` entry that did not load is reported
 * as a diagnostic instead of a phantom resource.
 */
function buildOverrides(
  kind: ResourceKind,
  settings: { global: Record<string, unknown>; project: Record<string, unknown> },
  loaded: ReadonlySet<string>,
  diagnostics: ResourceDiagnosticSummary[],
): {
  resources: ResourceSummary[];
  overrides: ResourceOverride[];
} {
  const resources: ResourceSummary[] = [];
  const overrides: ResourceOverride[] = [];
  const scopes: Array<[SettingsScope, Record<string, unknown>]> = [
    ["global", settings.global],
    ["project", settings.project],
  ];
  const seen = new Set<string>();

  for (const [scope, document] of scopes) {
    for (const entry of asArray(document[kind])) {
      if (typeof entry !== "string" || !isOverrideEntry(entry)) continue;
      const token = normalizeOverrideToken(entry);
      if (token.length === 0) continue;
      if (hasGlobChars(token)) {
        overrides.push({ kind, scope, entry });
        continue;
      }
      if (loaded.has(`${kind}:${token}`) || seen.has(`${kind}:${token}`)) continue;
      if (!isDisabledOverride(entry)) {
        diagnostics.push({
          type: "warning",
          message: `${entry} was force-included but Pi did not load it`,
          path: token,
        });
        continue;
      }
      seen.add(`${kind}:${token}`);
      resources.push({
        id: resourceIdOf(kind, token),
        kind,
        name: basenameOf(token),
        path: token,
        overridePath: token,
        source: entry,
        scope: scope === "project" ? "project" : "user",
        origin: "top-level",
        settingsKey: kind,
        enabled: false,
        override: entry,
      });
    }
  }

  return { resources, overrides };
}

/** Turns Pi's loader objects into the hub snapshot. Pure and deterministic. */
export function buildResourcesSnapshot(input: ResourceInspectionInput): ResourcesSnapshot {
  const now = input.now ?? (() => Date.now());
  const diagnostics: ResourceDiagnosticSummary[] = [];

  const extensions = buildExtensions(input.source.extensions, diagnostics);
  const loaded: ResourceSummary[] = [
    ...extensions.resources,
    ...buildSkills(input.source.skills, diagnostics),
    ...buildPrompts(input.source.prompts, diagnostics),
    ...buildThemes(input.source.themes, diagnostics),
  ];
  const loadedIds = new Set(loaded.map((resource) => resource.id));

  const disabled: ResourceSummary[] = [];
  const overrides: ResourceOverride[] = [];
  for (const kind of ["extensions", "skills", "prompts", "themes"] as const) {
    const derived = buildOverrides(kind, input.settings, loadedIds, diagnostics);
    disabled.push(...derived.resources);
    overrides.push(...derived.overrides);
  }

  const runtimeErrors = asArray(input.runtimeErrors)
    .map(runtimeErrorOf)
    .filter((entry): entry is ExtensionRuntimeErrorSummary => entry !== null);

  return {
    cwd: input.cwd,
    scope: input.scope,
    resources: sortResources([...loaded, ...disabled]),
    overrides,
    diagnostics,
    runtimeErrors,
    loadedAt: now(),
  };
}

export interface ResourceHandlerOptions {
  /**
   * Builds the snapshot for the requested project, or null when this host cannot
   * inspect resources (then `resources.list` answers `not_implemented`).
   */
  inspect(
    cwd: string | null,
    options: { refresh: boolean },
  ): Promise<ResourcesSnapshot> | ResourcesSnapshot;
}

/**
 * A control host's loader source (plan step 13). The session core does not need
 * this port — it already holds a live `ResourceLoader` — but a control host must
 * build one on demand (and can rebuild it for an explicit refresh).
 */
export interface ResourceInspector {
  load(cwd: string | null, options?: { refresh?: boolean }): Promise<ResourceLoaderSource>;
}

export function createResourceHandlers(options: ResourceHandlerOptions): {
  handlers(): Partial<Record<HostMethod, HostHandler>>;
} {
  return {
    handlers: () => ({
      "resources.list": async (params) => {
        const raw = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
        const requested =
          typeof raw.cwd === "string" && raw.cwd.trim().length > 0 ? raw.cwd.trim() : null;
        return options.inspect(requested, { refresh: raw.refresh === true });
      },
    }),
  };
}
