/**
 * Settings-editor helpers (plan step 12).
 *
 * Pure functions that turn the raw schema + the two Pi scopes into what a UI
 * needs: which scope a value comes from, how to render it in a text field, how
 * to parse the text back, and what differs from the defaults. They live in
 * `src/shared` so the node test project can exercise them without a DOM.
 */

import {
  getSettingsValue,
  parseSettingsJson,
  settingsChangesFromDefaults,
  settingsDefaultsDocument,
  validateSettingsValue,
  type SettingsDiffEntry,
  type SettingsField,
  type SettingsScope,
  type SettingsValidation,
  type SettingsValue,
} from "./settings-schema";
import type { SettingsScopes } from "./settings";

/** Where an effective settings value comes from, most specific first. */
export type SettingsValueSource = "project" | "global" | "default" | "unset";

export interface SettingsValueProvenance {
  source: SettingsValueSource;
  /** The value the agent would actually use. */
  effective: SettingsValue | undefined;
  global: SettingsValue | undefined;
  project: SettingsValue | undefined;
}

/**
 * Resolves a key across the two scopes and the documented defaults. The project
 * value wins, then the global value, then the default — the same precedence Pi
 * applies (nested-merge semantics; see `mergeSettingsScopes`).
 */
export function settingsValueProvenance(
  field: SettingsField,
  scopes: SettingsScopes,
  defaults: Record<string, unknown> = settingsDefaultsDocument(),
): SettingsValueProvenance {
  const project = getSettingsValue(scopes.project, field.key);
  const global = getSettingsValue(scopes.global, field.key);
  const fallback = getSettingsValue(defaults, field.key);
  if (project !== undefined) return { source: "project", effective: project, global, project };
  if (global !== undefined) return { source: "global", effective: global, global, project };
  if (fallback !== undefined) {
    return { source: "default", effective: fallback, global, project };
  }
  return { source: "unset", effective: undefined, global, project };
}

/** The editable text for a field's current value; `""` means “unset”. */
export function formatSettingsDraft(field: SettingsField, value: unknown): string {
  if (value === undefined || value === null) return "";
  switch (field.type) {
    case "boolean":
      return value === true ? "true" : "false";
    case "string-list":
      return Array.isArray(value) ? value.map((entry) => String(entry)).join("\n") : "";
    case "json":
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return "";
      }
    default:
      return String(value);
  }
}

/**
 * Parses an editor's text into a validated value. List fields accept one entry
 * per line; JSON fields are parsed first; everything else is validated as-is.
 * An empty draft means “unset”, which callers turn into a key deletion.
 */
export function parseSettingsDraft(field: SettingsField, draft: string): SettingsValidation {
  const trimmed = draft.trim();
  if (trimmed.length === 0) return { ok: true, value: undefined };
  if (field.type === "string-list") {
    const entries = draft
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return validateSettingsValue(field, entries);
  }
  if (field.type === "json") {
    const parsed = parseSettingsJson(draft);
    if (!parsed.ok) return parsed;
    return validateSettingsValue(field, parsed.value);
  }
  return validateSettingsValue(field, draft);
}

/** Fields of a group split into the always-visible and the advanced ones. */
export function splitAdvancedFields(fields: readonly SettingsField[]): {
  basic: SettingsField[];
  advanced: SettingsField[];
} {
  return {
    basic: fields.filter((field) => field.advanced !== true),
    advanced: fields.filter((field) => field.advanced === true),
  };
}

/**
 * Keys in one scope whose value differs from the documented default. `undefined`
 * on either side counts as absent, so an unset key with no default is not noise.
 */
export function settingsDiffForScope(
  scopes: SettingsScopes,
  scope: SettingsScope,
): SettingsDiffEntry[] {
  return settingsChangesFromDefaults(scopes[scope]);
}

/** A one-line summary of a value for the diff list. */
export function describeSettingsValue(value: unknown): string {
  if (value === undefined) return "(unset)";
  if (typeof value === "string") return value.length > 60 ? `${value.slice(0, 57)}…` : value;
  try {
    const text = JSON.stringify(value);
    return text !== undefined && text.length > 60
      ? `${text.slice(0, 57)}…`
      : (text ?? String(value));
  } catch {
    return String(value);
  }
}
