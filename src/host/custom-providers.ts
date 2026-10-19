/**
 * Custom model gateways in `models.json` (plan step 9, slice 5).
 *
 * Pi has no writer for `models.json`, so this module owns the file format at the
 * level the app edits: validate an entry, merge it into the file's `providers`
 * map, and read back a **redacted** summary. The file itself is written through
 * an injected `ModelsFileIo` whose node implementation replaces the file
 * atomically.
 *
 * No credential ever crosses to the renderer: `apiKey` goes in and the summary
 * only says whether one is stored.
 */

import type { HostMethod } from "../shared/host-protocol";
import {
  isCustomProviderAction,
  modelIdError,
  providerIdError,
  type CustomProviderInput,
  type CustomProviderSummary,
} from "../shared/custom-providers";
import { MAX_API_KEY_LENGTH, ProviderError } from "./providers";
import type { HostHandler } from "./service";

/** The methods this module answers (plan step 9). */
export const CUSTOM_PROVIDER_METHODS = [
  "providers.custom",
] as const satisfies readonly HostMethod[];

/** Atomic read/replace of `models.json`, injected so tests need no real file. */
export interface ModelsFileIo {
  read(path: string): Promise<string | null>;
  /** Replaces the file atomically (temp file + rename); creates it if absent. */
  write(path: string, text: string): Promise<void>;
  /** Removes the file (used to revert a first-ever write). */
  delete(path: string): Promise<void>;
}

/** The file-level operations `providers.custom` performs. */
export interface CustomProviderStore {
  list(): Promise<CustomProviderSummary[]>;
  set(input: CustomProviderInput): Promise<CustomProviderSummary>;
  remove(providerId: string): Promise<void>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The id rules live in `src/shared/custom-providers.ts` (plan step 29) so the
 * dialog and this handler can never disagree; here they become exceptions.
 * The message is the shared one verbatim — the renderer shows the same string.
 */
function requireProviderId(value: unknown): string {
  const message = providerIdError(value);
  if (message) throw new ProviderError(message);
  return (value as string).trim();
}

function requireModelId(value: unknown): string {
  const message = modelIdError(value);
  if (message) throw new ProviderError(message);
  return (value as string).trim();
}

function requireBaseUrl(value: unknown): string {
  const raw = optionalString(value);
  if (!raw) throw new ProviderError("a base URL is required");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError("the base URL is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderError("the base URL must use http or https");
  }
  return raw.replace(/\/+$/, "");
}

function stringHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderError("headers must be an object of string values");
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value as Record<string, unknown>)) {
    if (name.trim().length === 0) throw new ProviderError("a header name cannot be empty");
    if (typeof headerValue !== "string") {
      throw new ProviderError(`header ${name} must be a string`);
    }
    headers[name] = headerValue;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/** Compatibility flags are passed through as-is; Pi validates them on load. */
function compatFlags(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderError("compat must be an object");
  }
  return Object.keys(value as Record<string, unknown>).length > 0
    ? { ...(value as Record<string, unknown>) }
    : undefined;
}

/** The shape stored under `providers.<id>` — the subset the editor manages. */
export interface ModelsJsonProviderEntry {
  name?: string;
  baseUrl: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }>;
}

/**
 * A `providers.<id>` object as the file actually holds it: everything the
 * editor validates, plus the hand-written keys the app preserves but never
 * interprets (`oauth`, `authHeader`, `modelOverrides`, per-model `cost`/…).
 * Parsed JSON is untrusted, so the extra keys are `unknown` by construction.
 */
export interface StoredCustomProviderEntry extends ModelsJsonProviderEntry {
  [key: string]: unknown;
}

/** Validates and normalises one gateway for storage. Throws `ProviderError`. */
export function validateCustomProvider(input: CustomProviderInput): ModelsJsonProviderEntry {
  requireProviderId(input?.id);
  const baseUrl = requireBaseUrl(input?.baseUrl);
  const api = optionalString(input?.api);
  const name = optionalString(input?.name);
  const headers = stringHeaders(input?.headers);
  const compat = compatFlags(input?.compat);

  let apiKey: string | undefined;
  if (input?.apiKey !== undefined && input.apiKey !== null && input.apiKey !== "") {
    apiKey = String(input.apiKey);
    if (apiKey.length > MAX_API_KEY_LENGTH) {
      throw new ProviderError(`an API key may be at most ${MAX_API_KEY_LENGTH} characters`);
    }
  }

  if (!Array.isArray(input?.models) || input.models.length === 0) {
    throw new ProviderError("at least one model id is required");
  }
  const seen = new Set<string>();
  const models: ModelsJsonProviderEntry["models"] = [];
  for (const model of input.models) {
    const modelId = requireModelId((model as { id?: unknown })?.id);
    if (seen.has(modelId)) continue;
    seen.add(modelId);
    const entry: ModelsJsonProviderEntry["models"][number] = { id: modelId };
    const modelName = optionalString((model as { name?: unknown })?.name);
    if (modelName) entry.name = modelName;
    const contextWindow = (model as { contextWindow?: unknown })?.contextWindow;
    if (typeof contextWindow === "number" && contextWindow > 0) entry.contextWindow = contextWindow;
    const maxTokens = (model as { maxTokens?: unknown })?.maxTokens;
    if (typeof maxTokens === "number" && maxTokens > 0) entry.maxTokens = maxTokens;
    models.push(entry);
  }

  return {
    ...(name ? { name } : {}),
    baseUrl,
    ...(api ? { api } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(headers ? { headers } : {}),
    ...(compat ? { compat } : {}),
    models,
  };
}

/** Parses the file; a malformed file is surfaced, never silently replaced. */
export function parseModelsJson(text: string | null, path: string): Record<string, unknown> {
  if (text === null || text.trim().length === 0) return { providers: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderError(`${path} is not valid JSON; fix it by hand first`, "parse_failed");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProviderError(`${path} must contain a JSON object`, "parse_failed");
  }
  return parsed as Record<string, unknown>;
}

/** A redacted summary of one stored entry. */
export function summarizeCustomProvider(id: string, entry: unknown): CustomProviderSummary {
  const value = record(entry);
  const models = Array.isArray(value.models) ? value.models : [];
  const headers = record(value.headers);
  return {
    id,
    name: typeof value.name === "string" && value.name.length > 0 ? value.name : id,
    baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : null,
    api: typeof value.api === "string" ? value.api : null,
    modelIds: models
      .map((model) => record(model).id)
      .filter((modelId): modelId is string => typeof modelId === "string"),
    hasApiKey: typeof value.apiKey === "string" && value.apiKey.length > 0,
    headerNames: Object.keys(headers),
  };
}

/** Every `providers.<id>` entry, redacted and sorted by id. */
export function summarizeCustomProviders(
  text: string | null,
  path: string,
): CustomProviderSummary[] {
  const root = parseModelsJson(text, path);
  const providers = record(root.providers);
  return Object.keys(providers)
    .sort((left, right) => left.localeCompare(right))
    .map((id) => summarizeCustomProvider(id, providers[id]));
}

/**
 * Folds a validated entry over whatever is already stored (plan step 29).
 *
 * `upsertCustomProvider` used to assign the entry wholesale, which silently
 * deleted every key the editor does not render — a hand-written `oauth`,
 * `modelOverrides`, per-model `cost`/`reasoning`/`input`, and even the stored
 * `apiKey` (the dialog's placeholder promises "leave blank to keep"). The four
 * key classes have deliberately different rules:
 *
 *  - **rendered scalars** (`name`, `baseUrl`, `api`) are authoritative: the
 *    input wins, and an absent value **clears** the stored one, because the
 *    dialog is the thing that renders them (blank means blank);
 *  - **`apiKey`** is write-only: present overwrites, absent **keeps** the
 *    stored key (there is no UI affordance to clear it — a documented gap);
 *  - **`headers`/`compat`** are real input fields the dialog cannot render:
 *    present wins, absent **preserves** what is stored (clearing them is a
 *    hand-edit, exactly as today);
 *  - **everything else** (`oauth`, `authHeader`, `modelOverrides`, unknown
 *    keys) is preserved untouched — the app never writes those.
 *
 * `models` merge **by id**: a stored per-model object keeps its unrendered keys
 * and the input's rendered ones win, ids missing from the input are removed, and
 * the input order is the stored order.
 */
export function mergeCustomProviderEntry(
  stored: unknown,
  entry: ModelsJsonProviderEntry,
): StoredCustomProviderEntry {
  const previous = record(stored);
  const merged: Record<string, unknown> = { ...previous };

  merged.baseUrl = entry.baseUrl;
  if (entry.name === undefined) delete merged.name;
  else merged.name = entry.name;
  if (entry.api === undefined) delete merged.api;
  else merged.api = entry.api;

  if (entry.apiKey !== undefined) merged.apiKey = entry.apiKey;
  if (entry.headers !== undefined) merged.headers = entry.headers;
  if (entry.compat !== undefined) merged.compat = entry.compat;

  const storedModels = Array.isArray(previous.models) ? previous.models : [];
  const storedById = new Map<string, Record<string, unknown>>();
  for (const model of storedModels) {
    const value = record(model);
    if (typeof value.id === "string") storedById.set(value.id, value);
  }
  merged.models = entry.models.map((model) => ({
    ...(storedById.get(model.id) ?? {}),
    ...model,
  }));

  // SAFETY: every field the interface requires was just assigned above
  // (`baseUrl`, `models`) or came from the stored entry that Pi already loads;
  // the spread is what carries the unrendered keys the interface cannot name.
  return merged as StoredCustomProviderEntry;
}

/** Returns `text` with `entry` stored under `providers.<id>` (unknown keys kept). */
export function upsertCustomProvider(
  text: string | null,
  id: string,
  entry: ModelsJsonProviderEntry,
  path: string,
): string {
  const root = parseModelsJson(text, path);
  const providers = { ...record(root.providers) };
  providers[id] = mergeCustomProviderEntry(providers[id], entry);
  return `${JSON.stringify({ ...root, providers }, null, 2)}\n`;
}

/**
 * The raw `providers.<id>` object currently in `text`, or `undefined`. Used to
 * summarize what is **actually on disk** after an update instead of echoing the
 * input back (the merge means the two differ).
 */
export function storedCustomProviderEntry(
  text: string | null,
  path: string,
  providerId: string,
): StoredCustomProviderEntry | undefined {
  const entry = record(parseModelsJson(text, path).providers)[providerId];
  if (entry === undefined) return undefined;
  // SAFETY: `entry` is one value of the parsed `providers` map. It is untrusted
  // JSON, which is exactly what `StoredCustomProviderEntry` models — a known
  // core plus unknown extra keys — and callers only read it defensively.
  return entry as StoredCustomProviderEntry;
}

/** Returns `text` without `providers.<id>`. */
export function removeCustomProvider(text: string | null, id: string, path: string): string {
  const root = parseModelsJson(text, path);
  const providers = { ...record(root.providers) };
  delete providers[id];
  return `${JSON.stringify({ ...root, providers }, null, 2)}\n`;
}

export interface CustomProviderHandlerOptions {
  /** Resolves the file store, or null when the control host cannot edit it. */
  resolveStore(): CustomProviderStore | null;
}

/** The `providers.custom` handler. All input is validated before anything runs. */
export function createCustomProviderHandlers(options: CustomProviderHandlerOptions): {
  handlers(): Partial<Record<HostMethod, HostHandler>>;
} {
  const store = (): CustomProviderStore => {
    const resolved = options.resolveStore();
    if (!resolved) {
      throw new ProviderError("custom providers are not available in this host", "not_implemented");
    }
    return resolved;
  };

  return {
    handlers: () => ({
      "providers.custom": async (params) => {
        const input = record(params);
        const action = input.action ?? "list";
        if (!isCustomProviderAction(action)) {
          throw new ProviderError(`unknown providers.custom action: ${String(action)}`);
        }
        if (action === "list") {
          return { providers: await store().list() };
        }
        if (action === "set") {
          const providerInput = (input.provider ?? {}) as CustomProviderInput;
          const entry = validateCustomProvider(providerInput);
          const providerId = requireProviderId(providerInput.id);
          return {
            provider: await store().set({ ...providerInput, ...entry, id: providerId }),
          };
        }
        const providerId = requireProviderId(input.providerId ?? input.id);
        await store().remove(providerId);
        return { removed: true, providerId };
      },
    }),
  };
}
