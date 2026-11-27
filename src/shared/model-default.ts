/**
 * "Which model does a new session start on?" (2026-11-06 plan, step 12).
 *
 * Pi's rule is: for a brand-new session, the **first scoped model** wins, then
 * `settings.defaultProvider`/`defaultModel` (only if the catalogue resolves it),
 * then the first available model. So a saved default that names an id the
 * catalogue does not contain is not an error Pi reports — it is a silent
 * fallback to whatever happens to be first. In this profile that was a Kimi
 * model the user had never picked.
 *
 * This module makes that condition computable so the app can say it out loud and
 * offer the one fix that always works: pick a model (which persists it).
 *
 * Pure and SDK-free.
 */

/** The two settings documents, read structurally (a missing scope is fine). */
export interface SettingsDocuments {
  global?: unknown;
  project?: unknown;
}

export interface ModelRef {
  provider: string;
  id: string;
}

export interface DefaultModelProblem extends ModelRef {
  /** Ready to render: names the id, the consequence and the fix. */
  message: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The effective saved default. The project document wins over the global one,
 * matching how Pi merges the two files.
 */
export function readDefaultModelRef(
  settings: SettingsDocuments | null | undefined,
): ModelRef | null {
  for (const scope of [settings?.project, settings?.global]) {
    const record = asRecord(scope);
    const provider = record.defaultProvider;
    const id = record.defaultModel;
    if (
      typeof provider === "string" &&
      provider.length > 0 &&
      typeof id === "string" &&
      id.length > 0
    ) {
      return { provider, id };
    }
  }
  return null;
}

/** True when the catalogue (raw, catalog rows or `{ model }` wrappers) has it. */
export function catalogueHasModel(catalogue: readonly unknown[], ref: ModelRef): boolean {
  for (const entry of catalogue) {
    const record = asRecord(entry);
    const model = asRecord(record.model ?? entry);
    if (model.provider === ref.provider && model.id === ref.id) return true;
  }
  return false;
}

/**
 * The visible problem, or null. An empty catalogue means "not loaded yet", not
 * "missing": a warning before the first `model.available` would be noise.
 */
export function defaultModelProblem(
  settings: SettingsDocuments | null | undefined,
  catalogue: readonly unknown[],
): DefaultModelProblem | null {
  const ref = readDefaultModelRef(settings);
  if (!ref) return null;
  if (catalogue.length === 0) return null;
  if (catalogueHasModel(catalogue, ref)) return null;
  return {
    ...ref,
    message:
      `Saved default model ${ref.provider}/${ref.id} is not in the catalogue, so a new ` +
      "session starts on another model. Pick a model to replace the default.",
  };
}
