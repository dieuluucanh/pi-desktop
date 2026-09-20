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

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const MAX_ID_LENGTH = 64;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function requireId(value: unknown, label: string): string {
  const id = optionalString(value);
  if (!id) throw new ProviderError(`${label} is required`);
  if (id.length > MAX_ID_LENGTH || !ID_PATTERN.test(id)) {
    throw new ProviderError(
      `${label} must start with a letter or digit and contain only letters, digits, ".", "_" or "-"`,
    );
  }
  return id;
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

/** Validates and normalises one gateway for storage. Throws `ProviderError`. */
export function validateCustomProvider(input: CustomProviderInput): ModelsJsonProviderEntry {
  requireId(input?.id, "a provider id");
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
    const modelId = requireId((model as { id?: unknown })?.id, "a model id");
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

/** Returns `text` with `entry` stored under `providers.<id>` (unknown keys kept). */
export function upsertCustomProvider(
  text: string | null,
  id: string,
  entry: ModelsJsonProviderEntry,
  path: string,
): string {
  const root = parseModelsJson(text, path);
  const providers = { ...record(root.providers) };
  providers[id] = entry;
  return `${JSON.stringify({ ...root, providers }, null, 2)}\n`;
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
          const providerId = requireId(providerInput.id, "a provider id");
          return {
            provider: await store().set({ ...providerInput, ...entry, id: providerId }),
          };
        }
        const providerId = requireId(input.providerId ?? input.id, "a provider id");
        await store().remove(providerId);
        return { removed: true, providerId };
      },
    }),
  };
}
