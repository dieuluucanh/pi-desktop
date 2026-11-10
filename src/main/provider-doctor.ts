/**
 * Command Code provider sanity check for the doctor.
 *
 * A hand-written `models.json` entry can declare one API family for the whole
 * provider. Command Code's catalog is per-model: Claude models answer on
 * `/messages`, models that advertise `/responses` answer there, and the rest
 * use `/chat/completions`. The maintained `pi-commandcode-provider` package
 * routes each model and normalizes Command Code's reasoning deltas.
 *
 * This module only reads and reports; it never edits `models.json`.
 */

/** One provider entry that should be migrated or paired with the package. */
export interface CommandCodeProviderWarning {
  providerId: string;
  baseUrl: string;
  api: string | null;
  modelIds: string[];
  message: string;
  hint: string;
}

const COMMAND_CODE_HOST = "api.commandcode.ai";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function providerHost(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function modelIds(entry: Record<string, unknown>): string[] {
  const models = entry.models;
  if (!Array.isArray(models)) return [];
  const ids: string[] = [];
  for (const model of models) {
    if (!isRecord(model)) continue;
    const id = stringValue(model.id);
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * Inspect the parsed `models.json` text. Returns the warning for a
 * Command-Code provider that pins every model to a non-Responses family, or
 * `null` for a healthy/missing/malformed file. Malformed JSON is deliberately
 * silent: the doctor already reports Pi's own load error, and a second warning
 * built from a failed parse would be noise.
 */
export function commandCodeProviderWarning(
  modelsText: string | undefined,
): CommandCodeProviderWarning | null {
  if (!modelsText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(modelsText);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.providers)) return null;

  for (const [providerId, rawEntry] of Object.entries(parsed.providers)) {
    if (!isRecord(rawEntry)) continue;
    const baseUrl = stringValue(rawEntry.baseUrl);
    if (!baseUrl) continue;
    const host = providerHost(baseUrl);
    if (host !== COMMAND_CODE_HOST) continue;
    const api = stringValue(rawEntry.api) ?? null;
    // The maintained package uses a custom api id and routes per model; a static
    // entry that already selects Responses is not the failure mode this warns
    // about (Claude-only entries are a different, narrower issue).
    if (api === "openai-responses") continue;
    const ids = modelIds(rawEntry);
    if (ids.length === 0) continue;
    return {
      providerId,
      baseUrl,
      api,
      modelIds: ids,
      message:
        `provider "${providerId}" points every Command Code model at ${api ?? "the default wire"}; ` +
        "the catalog advertises /responses for models such as deepseek/deepseek-v4.1-flash.",
      hint:
        "Install the maintained provider (Terminal: `pi install npm:pi-commandcode-provider`; " +
        "Desktop: Settings → Extensions → Install pi-commandcode-provider), then retarget " +
        "profiles/roles from `command-code` to `commandcode` before removing the static entry.",
    };
  }
  return null;
}

/** One doctor line (or an empty string when the profile is healthy). */
export function commandCodeProviderDoctorLine(modelsText: string | undefined): string {
  const warning = commandCodeProviderWarning(modelsText);
  if (!warning) return "";
  return [`provider check  ${warning.message}`, `  hint           ${warning.hint}`].join("\n");
}
