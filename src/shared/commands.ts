/**
 * The command-argument wire contract (2026-10-24 command parity plan).
 *
 * `commands.complete` evaluates a live extension command's
 * `getArgumentCompletions(prefix)` in the host (the function cannot cross the
 * frame boundary) and returns plain items. `commands.run` executes the command's
 * handler directly, so it works while the agent streams.
 *
 * Everything here is pure and SDK-free so both the host and the renderer can
 * validate the same shape. Values are **not trimmed**: a completing extension
 * uses a trailing space to mean "accept this token and keep typing" (for
 * example `/profile use `), and stripping it would turn the next keystroke into
 * a submission.
 */

/** Upper bound on one completion response; a broken extension cannot flood the frame. */
export const COMMAND_ARGUMENT_LIMIT = 50;

/** Bounds on the individual strings, chosen to keep one frame small. */
export const COMMAND_ARGUMENT_VALUE_MAX = 4096;
export const COMMAND_ARGUMENT_LABEL_MAX = 512;
export const COMMAND_ARGUMENT_DESCRIPTION_MAX = 512;

/** One argument suggestion, in the shape both sides exchange. */
export interface CommandArgumentItem {
  /** The complete replacement for the typed argument prefix. Trailing space is significant. */
  value: string;
  label: string;
  description?: string;
}

/** Response of `commands.complete`. `items: null` means "no menu". */
export interface CommandCompleteResult {
  items: CommandArgumentItem[] | null;
}

/** Response of `commands.run`. `ran: false` means the command was not live. */
export interface CommandRunResult {
  ran: boolean;
  error?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function cap(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Sanitizes one completion payload. Invalid entries are dropped rather than
 * throwing: a completion hook is third-party code and a malformed item must
 * close the menu, not break the keystroke.
 */
export function sanitizeCommandArgumentItems(value: unknown): CommandArgumentItem[] {
  if (!Array.isArray(value)) return [];
  const items: CommandArgumentItem[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const rawValue = asString(record.value);
    if (!rawValue) continue;
    const value = cap(rawValue, COMMAND_ARGUMENT_VALUE_MAX);
    const label = cap(asString(record.label) ?? value, COMMAND_ARGUMENT_LABEL_MAX);
    const description = asString(record.description);
    items.push({
      value,
      label,
      ...(description ? { description: cap(description, COMMAND_ARGUMENT_DESCRIPTION_MAX) } : {}),
    });
    if (items.length >= COMMAND_ARGUMENT_LIMIT) break;
  }
  return items;
}

/** Reads the `{ items }` response the host sends. Empty or malformed → null. */
export function parseCommandCompleteResult(value: unknown): CommandArgumentItem[] | null {
  const items = sanitizeCommandArgumentItems(asRecord(value).items);
  return items.length > 0 ? items : null;
}

/** Reads the `{ ran, error? }` response the host sends. Malformed → not run. */
export function parseCommandRunResult(value: unknown): CommandRunResult {
  const record = asRecord(value);
  if (record.ran !== true) return { ran: false };
  const error = asString(record.error);
  return { ran: true, ...(error ? { error } : {}) };
}
