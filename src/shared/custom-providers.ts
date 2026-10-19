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

/**
 * The id rules for a custom gateway (plan step 29).
 *
 * Pi's schema accepts **any** non-empty string as a provider id or a model id
 * (`ModelDefinitionSchema.id = Type.String({ minLength: 1 })`; provider ids are
 * plain JSON keys), and real catalogs ship ids containing `/`, `:`, `~` and `@`
 * — `~anthropic/claude-opus-latest`, `@cf/meta/llama-3.1-8b-instruct`. The app
 * used to validate both with a package-name charset, which made a HuggingFace
 * id such as `hf:deepseek-ai/DeepSeek-V4.1-Flash` impossible to enter.
 *
 * These predicates are the single source of truth: the host throws their
 * messages and the renderer pre-checks with them, so the dialog and
 * `providers.custom` can never disagree.
 *
 * Four app-level restrictions stay, each for one concrete reason:
 *
 *  - a provider id is a `models.json` **object key** (`providers[id] = entry`),
 *    so the JSON-key hazards (`__proto__`, …) and `.`/`..` are refused;
 *  - a provider id is the left half of Pi's `provider/model` reference and of
 *    the app's `provider/id` favourite key, and Pi splits that at the **first**
 *    `/` — a `/` there would make the provider's own models unreferencable;
 *  - model ids are **comma-separated** in the editor field, so a comma inside
 *    one would be silently split into two models on the next save;
 *  - both are bounded in length (Pi caps nothing) so one entry cannot bloat the
 *    shared profile.
 *
 * Model ids deliberately get no reserved-name or `.`/`..` guard: they are never
 * object keys here (dedupe uses a `Set`) and Pi accepts them, so refusing them
 * would contradict the point of this fix.
 */

/** Longest provider id accepted: a user-typed namespace that is also a JSON key. */
export const MAX_PROVIDER_ID_LENGTH = 64;
/** Longest model id accepted; Pi imposes no cap, so this is a sanity bound only. */
export const MAX_MODEL_ID_LENGTH = 200;

/** Writing `providers["__proto__"] = …` through a plain object poisons a prototype. */
const RESERVED_PROVIDER_IDS = new Set(["__proto__", "prototype", "constructor"]);

/** Whitespace in any unicode form (a bare `\s` character class). */
const WHITESPACE = /\s/u;

/**
 * True for a character that must never appear inside an id: any whitespace (a
 * stray space or tab in a copied id) or a C0/C1 control character (a pasted
 * newline, an escape byte). Written as a code-point walk rather than a regex
 * because a control-character range in a pattern trips `no-control-regex`.
 */
function isIllegalIdChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || WHITESPACE.test(char);
}

/** True when any character of `id` is illegal. */
function hasIllegalIdChar(id: string): boolean {
  for (const char of id) {
    if (isIllegalIdChar(char)) return true;
  }
  return false;
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The reason `value` is not a usable **provider** id, or `null` when it is.
 * The message is what the dialog and the host both show.
 */
export function providerIdError(value: unknown): string | null {
  const id = trimmed(value);
  if (id.length === 0) return "a provider id is required";
  if (id.length > MAX_PROVIDER_ID_LENGTH) {
    return `a provider id may be at most ${MAX_PROVIDER_ID_LENGTH} characters`;
  }
  if (hasIllegalIdChar(id)) {
    return "a provider id cannot contain spaces or control characters";
  }
  if (id === "." || id === "..") return `"${id}" is not a usable provider id`;
  if (RESERVED_PROVIDER_IDS.has(id))
    return `"${id}" is a reserved name and cannot be a provider id`;
  if (id.includes("/")) {
    return 'a provider id cannot contain "/" — Pi splits provider/model at the first slash';
  }
  return null;
}

/**
 * The reason `value` is not a usable **model** id, or `null` when it is. `/`,
 * `:`, `~`, `@` and other punctuation are all fine; whitespace, control
 * characters, a comma and the length cap are not.
 */
export function modelIdError(value: unknown): string | null {
  const id = trimmed(value);
  if (id.length === 0) return "a model id is required";
  if (id.length > MAX_MODEL_ID_LENGTH) {
    return `a model id may be at most ${MAX_MODEL_ID_LENGTH} characters`;
  }
  if (hasIllegalIdChar(id)) {
    return "a model id cannot contain spaces or control characters";
  }
  if (id.includes(",")) {
    return "a model id cannot contain a comma — model ids here are comma-separated (add it to models.json by hand instead)";
  }
  return null;
}

/** True when `value` is a provider id this app will store. */
export function isValidProviderId(value: unknown): boolean {
  return providerIdError(value) === null;
}

/** True when `value` is a model id this app will store. */
export function isValidModelId(value: unknown): boolean {
  return modelIdError(value) === null;
}

/** True for a value that looks like a `providers.custom` action. */
export function isCustomProviderAction(value: unknown): value is CustomProviderAction {
  return value === "list" || value === "set" || value === "remove";
}
