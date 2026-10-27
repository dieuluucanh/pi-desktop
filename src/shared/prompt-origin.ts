/**
 * Command-prompt origins (2026-10-26 composer/command-prompt plan).
 *
 * A command such as `/commit`, `/template …` or `/skill:*` reaches the model as
 * a normal user message whose text is the **expanded** instruction, not what the
 * user typed. The desktop keeps the raw command for display by tagging the live
 * host event; to keep that display after the app restarts, the renderer records
 * a bounded `hash(message text) -> raw command` map in `app-state.json`.
 *
 * Only the command is stored. The expanded body never leaves the session, and
 * the hash makes the record independent of Pi's message/entry ids (which the SDK
 * regenerates on resume).
 */

/** These are App preferences, not Pi settings: bounded and display-only. */
export const MAX_PROMPT_ORIGINS = 300;
export const MAX_PROMPT_ORIGIN_LENGTH = 400;

const HASH_PATTERN = /^[0-9a-f]{16}$/;
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

/**
 * A stable 64-bit FNV-1a hash of the exact message text, as 16 lowercase hex
 * chars. It runs over UTF-16 code units, so it is identical in the renderer,
 * node tests and main; a collision only mislabels one row cosmetically.
 */
export function hashPromptText(text: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * FNV_PRIME) & UINT64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

function sanitizePromptOriginValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const command = value.trim();
  if (command.length === 0 || command.length > MAX_PROMPT_ORIGIN_LENGTH) return null;
  return command;
}

/**
 * Keeps the map small and command-only. Invalid keys/values are dropped and the
 * most recent `MAX_PROMPT_ORIGINS` entries survive (JSON object insertion order
 * is the recency order).
 */
export function sanitizePromptOrigins(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!HASH_PATTERN.test(key)) continue;
    const command = sanitizePromptOriginValue(value);
    if (command !== null) entries.push([key, command]);
  }
  return Object.fromEntries(entries.slice(-MAX_PROMPT_ORIGINS));
}

/**
 * Records one command against a message text, returning a new map. Re-recording
 * an existing text moves it to the end (the most recent position) before the
 * bound is applied.
 */
export function rememberPromptOrigin(
  origin: Readonly<Record<string, string>>,
  text: string,
  command: string,
): Record<string, string> {
  const trimmed = sanitizePromptOriginValue(command);
  if (trimmed === null) return sanitizePromptOrigins(origin);
  const next: Record<string, string> = { ...origin };
  const key = hashPromptText(text);
  delete next[key];
  next[key] = trimmed;
  return sanitizePromptOrigins(next);
}

/** Looks up the raw command for a message text, or `undefined`. */
export function promptOriginForText(
  origin: Readonly<Record<string, string>>,
  text: string,
): string | undefined {
  return origin[hashPromptText(text)];
}
