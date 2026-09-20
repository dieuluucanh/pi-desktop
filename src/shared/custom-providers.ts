/**
 * Custom model gateways (`models.json`) — the wire shapes (plan step 9, slice 5).
 *
 * Pi reads `models.json` from the profile and merges it over the built-in
 * providers. The app edits it through `providers.custom`; because the file can
 * hold an `apiKey`, everything crossing to the renderer is **redacted**: the
 * summary says whether a key is stored, never the key itself.
 */

/** One model entry the gateway advertises. */
export interface CustomProviderModelInput {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

/** What the editor submits. `apiKey` is write-only. */
export interface CustomProviderInput {
  id: string;
  name?: string;
  /** Gateway base URL, e.g. `https://gateway.example.com/v1`. */
  baseUrl: string;
  /** Provider API family, e.g. `openai-completions`. */
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Per-API compatibility flags; Pi validates them when it loads the file. */
  compat?: Record<string, unknown>;
  models: CustomProviderModelInput[];
}

/** A gateway as the renderer may see it. Never carries a credential value. */
export interface CustomProviderSummary {
  id: string;
  name: string;
  baseUrl: string | null;
  api: string | null;
  modelIds: string[];
  hasApiKey: boolean;
  headerNames: string[];
}

/** Actions `providers.custom` accepts. */
export type CustomProviderAction = "list" | "set" | "remove";

/** True for a value that looks like a `providers.custom` action. */
export function isCustomProviderAction(value: unknown): value is CustomProviderAction {
  return value === "list" || value === "set" || value === "remove";
}
