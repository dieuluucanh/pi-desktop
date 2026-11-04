/**
 * Model-catalog and usage helpers for the model/thinking/usage UX (plan step 8).
 *
 * The host forwards Pi's own objects (the runtime's model snapshot, the session's
 * `contextUsage`), so everything here normalises an `unknown` defensively rather
 * than trusting a shape — the same stance the transcript takes on state.
 *
 * A detail worth stating once: Pi's `contextUsage.percent` is **0–100**
 * (`agent-session.js` computes `(tokens / contextWindow) * 100`), not a fraction.
 */

import { fuzzyFilter } from "../completion/fuzzy";

/** The stable catalog key for a model (`provider/id`), also the scope key. */
function modelKey(provider: string, id: string): string {
  return `${provider}/${id}`;
}

/** One selectable model, with the raw object kept for `model.set`. */
export interface ModelCatalogEntry {
  /** Stable identity: `provider/id`. */
  key: string;
  id: string;
  provider: string;
  label: string;
  /** Per-model thinking level from `enabledModels`, when the user scoped one. */
  thinkingLevel?: string;
  /** Levels this model accepts, from the host's capability preview. */
  supportedThinkingLevels?: string[];
  /** The model object exactly as Pi reported it, sent back unchanged. */
  raw: unknown;
}

export interface ProviderAuthBadge {
  configured: boolean;
  /** Pi's own source: `stored`, `runtime`, `environment`, `fallback`, … */
  source?: string;
  label?: string;
}

export interface ProviderGroup {
  provider: string;
  auth: ProviderAuthBadge;
  models: ModelCatalogEntry[];
}

export interface ContextUsageView {
  /** Pi's percentage (0–100), or null while the token count is unknown. */
  percent: number | null;
  tokens: number | null;
  contextWindow: number | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Normalises one catalog entry. Accepts both a bare model and the scoped wrapper
 * `{ model, thinkingLevel? }` that `enabledModels` produces.
 */
export function toCatalogEntry(value: unknown): ModelCatalogEntry | null {
  const record = asRecord(value);
  const wrapped = record.model && typeof record.model === "object";
  const inner = wrapped ? asRecord(record.model) : record;
  const id = stringOf(inner.id) ?? stringOf(inner.modelId);
  const provider = stringOf(inner.provider) ?? stringOf(inner.providerId);
  if (!id || !provider) return null;

  const label = stringOf(inner.name) ?? stringOf(inner.label) ?? id;
  const thinkingLevel = stringOf(record.thinkingLevel);
  return {
    key: modelKey(provider, id),
    id,
    provider,
    label,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    raw: wrapped ? record.model : value,
  };
}

/** Normalises a whole catalog, dropping malformed entries and duplicates. */
export function toCatalog(
  models: readonly unknown[],
  thinkingByModel?: Readonly<Record<string, readonly string[]>>,
): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const entry = toCatalogEntry(model);
    if (!entry || seen.has(entry.key)) continue;
    seen.add(entry.key);
    const supported = thinkingByModel?.[entry.key];
    if (supported && supported.length > 0) entry.supportedThinkingLevels = [...supported];
    entries.push(entry);
  }
  return entries;
}

/** Coerces a host `thinkingByModel` map into `provider/id → string[]`. */
export function sanitizeThinkingByModel(value: unknown): Record<string, string[]> {
  const record = asRecord(value);
  const result: Record<string, string[]> = {};
  for (const [key, levels] of Object.entries(record)) {
    if (!Array.isArray(levels)) continue;
    const list = levels.filter((level): level is string => typeof level === "string");
    if (list.length > 0) result[key] = list;
  }
  return result;
}

/** The `provider/id` key of a model object as Pi reports it, when both parts exist. */
export function modelKeyOf(model: unknown): string | null {
  const record = asRecord(model);
  const id = stringOf(record.id) ?? stringOf(record.modelId);
  const provider = stringOf(record.provider) ?? stringOf(record.providerId);
  if (!id || !provider) return null;
  return modelKey(provider, id);
}

/**
 * Finds the model a `/model <ref>` argument names. Mirrors the host's
 * `applyModel`: an exact `provider/id` always wins, and a bare id is accepted
 * only when it is unambiguous.
 */
export function findExactModelEntry(
  entries: readonly ModelCatalogEntry[],
  reference: string,
): ModelCatalogEntry | null {
  const wanted = reference.trim().toLowerCase();
  if (wanted.length === 0) return null;
  const exact = entries.find((entry) => entry.key.toLowerCase() === wanted);
  if (exact) return exact;
  const bare = entries.filter((entry) => entry.id.toLowerCase() === wanted);
  return bare.length === 1 ? (bare[0] ?? null) : null;
}

/** Coerces Pi's auth status into a badge; an unknown value means "not configured". */
export function toAuthBadge(value: unknown): ProviderAuthBadge {
  const record = asRecord(value);
  const source = stringOf(record.source);
  const label = stringOf(record.label);
  return {
    configured: record.configured === true,
    ...(source ? { source } : {}),
    ...(label ? { label } : {}),
  };
}

export function authFor(
  auth: Readonly<Record<string, unknown>>,
  provider: string,
): ProviderAuthBadge {
  return toAuthBadge(auth[provider]);
}

/**
 * `provider / Label` — the unambiguous name a scoped row shows and the star's
 * accessible name uses. Two providers can expose the same model name, so the
 * bare label is not enough outside a provider group (which has its own heading).
 */
export function qualifiedModelLabel(entry: ModelCatalogEntry): string {
  return `${entry.provider} / ${entry.label}`;
}

/** Groups by provider, alphabetically, each with its own auth badge. */
export function groupByProvider(
  entries: readonly ModelCatalogEntry[],
  auth: Readonly<Record<string, unknown>> = {},
): ProviderGroup[] {
  const groups = new Map<string, ModelCatalogEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.provider);
    if (list) list.push(entry);
    else groups.set(entry.provider, [entry]);
  }
  return [...groups.entries()]
    .map(([provider, models]) => ({
      provider,
      auth: authFor(auth, provider),
      models: [...models].sort((left, right) => left.label.localeCompare(right.label)),
    }))
    .sort((left, right) => left.provider.localeCompare(right.provider));
}

/** Fuzzy search over label and id, so "sonnet" and "anthropic/claude" both work. */
export function filterModels(
  entries: readonly ModelCatalogEntry[],
  query: string,
): ModelCatalogEntry[] {
  return fuzzyFilter(entries, query, (entry) => `${entry.label} ${entry.key}`);
}

/** Scoped models first, in the user's scope order, then everything else. */
export function withScopedFirst(
  entries: readonly ModelCatalogEntry[],
  scoped: readonly string[],
): { scoped: ModelCatalogEntry[]; others: ModelCatalogEntry[] } {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const scopedEntries = scoped
    .map((key) => byKey.get(key))
    .filter((entry): entry is ModelCatalogEntry => entry !== undefined);
  const scopedKeys = new Set(scopedEntries.map((entry) => entry.key));
  return {
    scoped: scopedEntries,
    others: entries.filter((entry) => !scopedKeys.has(entry.key)),
  };
}

/** Context usage as the ring needs it: tokens, window and Pi's 0–100 percent. */
export function contextUsageOf(state: unknown): ContextUsageView | null {
  const usage = asRecord(state).contextUsage;
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  const contextWindow = typeof record.contextWindow === "number" ? record.contextWindow : null;
  const tokens = typeof record.tokens === "number" ? record.tokens : null;
  const percent = typeof record.percent === "number" ? record.percent : null;
  if (contextWindow === null && tokens === null && percent === null) return null;
  return { percent, tokens, contextWindow };
}

/** The ring's sweep, clamped to [0, 1]; null when there is nothing to draw. */
export function ringFraction(usage: ContextUsageView | null): number | null {
  if (!usage || usage.percent === null) return null;
  return Math.min(1, Math.max(0, usage.percent / 100));
}

/** Thinking levels the current model accepts, as the host reports them. */
export function thinkingLevelsOf(state: unknown): string[] {
  const levels = asRecord(state).thinkingLevels;
  if (!Array.isArray(levels)) return [];
  return levels.filter((level): level is string => typeof level === "string");
}

/** "12.3k" / "947" — compact token counts for the ring's tooltip. */
export function formatTokens(value: number | null): string {
  if (value === null) return "unknown";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}
