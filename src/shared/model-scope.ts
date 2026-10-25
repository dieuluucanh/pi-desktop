/**
 * Model scope (Pi's `enabledModels`) — the pure half.
 *
 * Pi calls this list "scoped models": the patterns are matched against the
 * available catalogue (`provider/model`, globs, bare ids and an optional
 * `:thinkingLevel` suffix) and resolved at session start into
 * `ctx.scopedModels`. The same set drives Ctrl+Alt model cycling, the extension
 * model pickers (`/profile`, `/role`) and the star in the app's model dialog.
 *
 * Everything here is pure and SDK-free: the host resolves patterns with the SDK
 * (`src/host/sdk/model-scope.ts`), the renderer renders keys, and both sides
 * share the same bounds and parsing. In particular the **toggle rewrite** is
 * here so it can be tested without a session: it materialises the live scope
 * (what the user actually sees) plus the patterns the resolver could not match,
 * so editing the star never silently drops a model.
 */

/** Bounds shared with Pi's settings guards (`enabledModels` is a string list). */
export const SCOPE_PATTERN_MAX_LENGTH = 300;
/** Upper bound on one scope list; the catalogue is capped at 200 models. */
export const SCOPE_PATTERN_LIMIT = 500;

/**
 * The thinking suffixes Pi's model-pattern parser understands. Kept as a local
 * copy (rather than importing `@earendil-works/pi-agent-core`) so this module
 * stays dependency-free; it mirrors `ThinkingLevel`.
 */
export const SCOPE_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ScopeThinkingLevel = (typeof SCOPE_THINKING_LEVELS)[number];

export function isScopeThinkingLevel(value: string): value is ScopeThinkingLevel {
  return (SCOPE_THINKING_LEVELS as readonly string[]).includes(value);
}

/** One exact model ref, optionally with the thinking level the scope pinned. */
export interface ScopeRef {
  /** `provider/id` — the catalog key the renderer star uses. */
  ref: string;
  /** The pattern as it should be written back (`ref` or `ref:level`). */
  pattern: string;
  thinkingLevel?: ScopeThinkingLevel;
}

/** The two settings documents, as the host and the renderer read them. */
export interface ScopeScopes {
  global?: unknown;
  project?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** The stable catalog key for a model ref (the same `provider/id` form). */
export function scopeKeyOf(provider: string, id: string): string {
  return `${provider}/${id}`;
}

/**
 * Coerces an untrusted list into scope patterns: strings only, trimmed, bounded
 * length/count, de-duplicated in first-seen order.
 */
export function normalizeScopePatterns(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const patterns: string[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    if (typeof entry !== "string") continue;
    const pattern = entry.trim();
    if (pattern.length === 0 || pattern.length > SCOPE_PATTERN_MAX_LENGTH) continue;
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    patterns.push(pattern);
    if (patterns.length >= SCOPE_PATTERN_LIMIT) break;
  }
  return patterns;
}

/**
 * The patterns that actually apply: a project `enabledModels` array overrides
 * the global one (Pi deep-merges project settings over global). A malformed
 * project value is ignored rather than masking a valid global list.
 */
export function effectiveScopePatterns(scopes: ScopeScopes): string[] {
  const global = asRecord(scopes.global);
  const project = asRecord(scopes.project);
  if (Array.isArray(project.enabledModels)) {
    return normalizeScopePatterns(project.enabledModels);
  }
  return normalizeScopePatterns(global.enabledModels);
}

/**
 * Which document a scope edit must write. Pi's own `/scoped-models` writes
 * global, but the app exposes a project scope in Settings; when a project has
 * the key, writing global would be silently masked by the project document, so
 * the edit follows the effective value instead.
 */
export function scopeWriteTarget(scopes: ScopeScopes): "global" | "project" {
  return hasOwn(asRecord(scopes.project), "enabledModels") ? "project" : "global";
}

/** `provider/id` keys of the live `scopedModels` entries (wrapped or bare). */
export function scopeKeys(scoped: readonly unknown[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(scoped) ? scoped : []) {
    const record = asRecord(entry);
    const model = asRecord(record.model ?? entry);
    const provider = typeof model.provider === "string" ? model.provider : model.providerId;
    const id = typeof model.id === "string" ? model.id : model.modelId;
    if (typeof provider !== "string" || typeof id !== "string") continue;
    if (provider.length === 0 || id.length === 0) continue;
    const key = scopeKeyOf(provider, id);
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/**
 * Materialises the live scope into explicit patterns, keeping the thinking
 * level a pattern pinned. The live scope is the user-visible truth: it also
 * contains models Pi appended through `setModel`, which a rewrite must not
 * silently drop.
 */
export function materialiseScopePatterns(scoped: readonly unknown[]): ScopeRef[] {
  const refs: ScopeRef[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(scoped) ? scoped : []) {
    const record = asRecord(entry);
    const model = asRecord(record.model ?? entry);
    const provider = typeof model.provider === "string" ? model.provider : model.providerId;
    const id = typeof model.id === "string" ? model.id : model.modelId;
    if (typeof provider !== "string" || typeof id !== "string") continue;
    if (provider.length === 0 || id.length === 0) continue;
    const ref = scopeKeyOf(provider, id);
    if (seen.has(ref)) continue;
    seen.add(ref);
    const thinking = record.thinkingLevel;
    if (typeof thinking === "string" && isScopeThinkingLevel(thinking)) {
      refs.push({ ref, pattern: `${ref}:${thinking}`, thinkingLevel: thinking });
    } else {
      refs.push({ ref, pattern: ref });
    }
  }
  return refs;
}

/**
 * Splits a persisted pattern into its exact ref and optional thinking suffix.
 * Globs and bare model ids have no single ref (`ref: null`) — the resolver is
 * what decides whether they match anything.
 */
export function parseScopePattern(pattern: string): {
  ref: string | null;
  thinkingLevel?: ScopeThinkingLevel;
} {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return { ref: null };
  if (trimmed.includes("*") || trimmed.includes("?") || trimmed.includes("[")) {
    return { ref: null };
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return { ref: null };
  const colon = trimmed.lastIndexOf(":");
  if (colon > slash) {
    const suffix = trimmed.slice(colon + 1);
    if (isScopeThinkingLevel(suffix)) {
      return { ref: trimmed.slice(0, colon), thinkingLevel: suffix };
    }
  }
  return { ref: trimmed };
}

/** Adds/removes one key, preserving the existing order and de-duplicating. */
export function toggleScopeKey(keys: readonly string[], key: string, enabled: boolean): string[] {
  const next: string[] = [];
  for (const entry of keys) {
    if (entry === key || next.includes(entry)) continue;
    next.push(entry);
  }
  return enabled ? [...next, key] : next;
}

export interface NextScopeInput {
  /** The live session scope (`session.scopedModels`). */
  liveScoped: readonly unknown[];
  /** Persisted patterns the resolver matched to nothing; kept verbatim. */
  preserved: readonly string[];
  provider: string;
  id: string;
  enabled: boolean;
}

/**
 * The toggle rewrite: live scope + one key change + the patterns that currently
 * match nothing.
 *
 * - Resolved patterns (exact refs and matching globs) are materialised into
 *   explicit `provider/id[:level]` entries, so un-starring a model a glob used
 *   to cover really removes it.
 * - Patterns that matched no available model are preserved, so a temporarily
 *   offline provider or a typo is not destroyed by an unrelated star click.
 * - An empty result means "no scope" (`undefined` → the caller deletes
 *   `enabledModels`); starring every model stays an explicit list.
 */
export function nextScopePatterns(input: NextScopeInput): string[] | undefined {
  const ref = scopeKeyOf(input.provider, input.id);
  const liveKeys = scopeKeys(input.liveScoped);
  const nextKeys = toggleScopeKey(liveKeys, ref, input.enabled);
  const materialised = new Map(
    materialiseScopePatterns(input.liveScoped).map((entry) => [entry.ref, entry.pattern]),
  );

  const patterns: string[] = [];
  const seen = new Set<string>();
  for (const key of nextKeys) {
    const pattern = materialised.get(key) ?? key;
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    patterns.push(pattern);
  }
  for (const pattern of normalizeScopePatterns(input.preserved)) {
    if (pattern === ref || seen.has(pattern)) continue;
    seen.add(pattern);
    patterns.push(pattern);
  }
  return patterns.length === 0 ? undefined : patterns;
}
