/**
 * Per-model thinking capability (2026-10-31 UI plan, step 5).
 *
 * Pi's `getSupportedThinkingLevels` is the authority: it reads `model.reasoning`
 * and `model.thinkingLevelMap` (including the `xhigh`/`max` opt-in rules). The
 * host calls it once per model in `model.available` so the renderer can preview
 * what a model will offer before the user selects it.
 *
 * This is an SDK adapter: the only file that knows the pi-ai function. The
 * session core receives it as an injected port (`describeModelThinking`) so the
 * core itself stays SDK-free.
 */

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A catalog row may be a bare model or the scoped `{ model, thinkingLevel }` wrapper. */
function modelOf(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  return record.model && typeof record.model === "object" ? asRecord(record.model) : record;
}

function keyOf(value: unknown): string | null {
  const model = modelOf(value);
  const provider = stringOf(model.provider) ?? stringOf(model.providerId);
  const id = stringOf(model.id) ?? stringOf(model.modelId);
  return provider && id ? `${provider}/${id}` : null;
}

/**
 * The levels the model accepts, in Pi's canonical order. A malformed or
 * incomplete model yields `[]` rather than throwing into the RPC response.
 */
export function supportedThinkingLevels(model: unknown): string[] {
  if (!model || typeof model !== "object") return [];
  try {
    return [...getSupportedThinkingLevels(model as never)];
  } catch {
    return [];
  }
}

/** `provider/id → supported levels` for every model the host can resolve. */
export function thinkingByModel(models: readonly unknown[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const model of models) {
    const key = keyOf(model);
    if (!key) continue;
    result[key] = supportedThinkingLevels(modelOf(model));
  }
  return result;
}
