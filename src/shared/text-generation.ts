/**
 * The session-less text-generation contract (2026-11-25 plan, step 13).
 *
 * The commit-message generator is the first model call in the app that is not
 * bound to a session: it runs on the control host through
 * `ModelRuntime.completeSimple`, with no `AgentSession`, no JSONL and no
 * extension. This module is the wire contract shared by the renderer, main and
 * the host — the model catalogue, the request/result shapes and the bounds that
 * keep a 700 KB staged patch from becoming a 175 k-token request.
 *
 * Pure and SDK-free (the SDK contact stays in `src/host/sdk/**`).
 *
 * The default model is deliberately *not* re-resolved here: `readDefaultModelRef`
 * in `./model-default` is the app's one definition of "the effective saved
 * default", so the catalogue reports it instead of growing a second resolver.
 */

import { readDefaultModelRef, type ModelRef } from "./model-default";

export type { ModelRef };

/** One selectable model, already resolved to what the picker renders. */
export interface ModelChoice {
  provider: string;
  id: string;
  name: string;
}

/**
 * What `text.models` answers. `defaultModel` is the saved default even when the
 * catalogue cannot resolve it (`defaultAvailable: false`), so the picker can say
 * so instead of quietly showing another model as selected.
 */
export interface TextGenerationModelCatalog {
  models: ModelChoice[];
  defaultModel: ModelChoice | null;
  defaultAvailable: boolean;
}

export interface TextGenerationRequest {
  /** `/^[A-Za-z0-9_-]{1,64}$/` — correlating one generate/cancel pair. */
  requestId: string;
  /** The project the request is scoped to; `null` means the control host's cwd. */
  cwd?: string | null;
  /** `null` = Default (resolve from the settings default, then the catalogue). */
  model?: ModelRef | null;
  /** System prompt, trimmed and non-empty. */
  system: string;
  /** User prompt, trimmed and non-empty. */
  prompt: string;
  /** Materialised by the sanitiser; always ≤ `MAX_OUTPUT_TOKENS`. */
  maxTokens?: number;
}

export interface TextGenerationResult {
  requestId: string;
  text: string;
  model: ModelChoice;
  usage?: { input: number; output: number };
}

/** An over-long system prompt is a bug, not a truncation point. */
export const MAX_SYSTEM_CHARS = 4_000;
/** One bounded patch summary plus patch; larger input is cut before the call. */
export const MAX_PROMPT_CHARS = 120_000;
/** Hard ceiling for one commit-message completion. */
export const MAX_OUTPUT_TOKENS = 2_048;
/** The cap used when a request does not name one. */
export const DEFAULT_OUTPUT_TOKENS = 1_024;
export const MAX_REQUEST_ID_LENGTH = 64;
/** Applies to both halves of a model ref (`provider` and `id`). */
export const MAX_MODEL_ID_LENGTH = 200;

/** The wire pattern for `requestId`; pinned so main, host and renderer agree. */
export const TEXT_GENERATION_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Trim, then require a non-empty string no longer than `max` characters. */
function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

/** A bounded `{ provider, id }` pair, or null when the value is not one. */
function sanitizeModelRef(value: unknown): ModelRef | null {
  const record = asRecord(value);
  if (!record) return null;
  const provider = boundedText(record.provider, MAX_MODEL_ID_LENGTH);
  const id = boundedText(record.id, MAX_MODEL_ID_LENGTH);
  if (!provider || !id) return null;
  return { provider, id };
}

function sanitizeMaxTokens(value: unknown): number | null {
  if (value === undefined || value === null) return DEFAULT_OUTPUT_TOKENS;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const whole = Math.floor(value);
  if (whole < 1) return null;
  return Math.min(whole, MAX_OUTPUT_TOKENS);
}

/**
 * Validates one `text.generate` request; returns `null` for anything invalid.
 * Never throws, so a malformed frame becomes a typed refusal instead of a crash.
 *
 * The result is fully materialised: `cwd` and `model` are always present
 * (`null` meaning "unset") and `maxTokens` always carries a number, so the host
 * cannot accidentally call the provider without an output cap.
 */
export function sanitizeTextGenerationRequest(input: unknown): TextGenerationRequest | null {
  const record = asRecord(input);
  if (!record) return null;

  const requestId = record.requestId;
  if (typeof requestId !== "string" || !TEXT_GENERATION_REQUEST_ID_PATTERN.test(requestId)) {
    return null;
  }

  const system = boundedText(record.system, MAX_SYSTEM_CHARS);
  if (system === null) return null;

  const prompt = boundedText(record.prompt, MAX_PROMPT_CHARS);
  if (prompt === null) return null;

  const maxTokens = sanitizeMaxTokens(record.maxTokens);
  if (maxTokens === null) return null;

  let cwd: string | null = null;
  if (record.cwd !== undefined && record.cwd !== null) {
    if (typeof record.cwd !== "string") return null;
    const trimmed = record.cwd.trim();
    cwd = trimmed.length > 0 ? trimmed : null;
  }

  let model: ModelRef | null = null;
  if (record.model !== undefined && record.model !== null) {
    model = sanitizeModelRef(record.model);
    if (model === null) return null;
  }

  return { requestId, cwd, model, system, prompt, maxTokens };
}

/** `"provider/id"` — the one spelling used in logs, errors and toasts. */
export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}/${ref.id}`;
}

/** True only when both refs exist and name the same provider and id. */
export function sameModelRef(
  a: ModelRef | null | undefined,
  b: ModelRef | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.provider === b.provider && a.id === b.id;
}

/**
 * The saved default, resolved against the catalogue (plan decision D12).
 *
 * Precedence is `readDefaultModelRef`'s: the project document wins over the
 * global one. A default that the catalogue does not contain is still reported —
 * with `name: id` and `defaultAvailable: false` — because that is exactly the
 * case the picker has to explain.
 */
export function resolveCatalogueDefault(
  scopes: { global?: unknown; project?: unknown } | null | undefined,
  models: readonly ModelChoice[],
): { defaultModel: ModelChoice | null; defaultAvailable: boolean } {
  const ref = readDefaultModelRef(scopes);
  if (!ref) return { defaultModel: null, defaultAvailable: false };
  const match = models.find((model) => sameModelRef(model, ref));
  if (match) return { defaultModel: { ...match }, defaultAvailable: true };
  return {
    defaultModel: { provider: ref.provider, id: ref.id, name: ref.id },
    defaultAvailable: false,
  };
}
