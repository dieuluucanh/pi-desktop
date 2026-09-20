/**
 * `/` completion (plan step 7): the app's reserved commands plus everything the
 * host reports from `commands.list` — extension commands, prompt templates and
 * skills, in the same order Pi's RPC `get_commands` builds them.
 *
 * A name collision is **kept as two entries** rather than de-duplicated: the
 * list shows the source of each, so `/model` from an extension is visible next
 * to the app's own, and the palette can pick either. Silent shadowing is the
 * failure mode this exists to prevent.
 */

import { APP_COMMANDS } from "./app-commands";
import { fuzzyFilter } from "./fuzzy";
import { tokenAtCursor } from "./token";
import {
  applyCompletionInPlace,
  type CompletionItem,
  type CompletionProvider,
  type CompletionSource,
  type CompletionSuggestions,
} from "./types";

/** One entry of the host's `commands.list`, in Pi's own shape. */
export interface HostCommandEntry {
  name: string;
  description?: string;
  argumentHint?: string;
  source?: string;
  sourceInfo?: unknown;
}

export const DEFAULT_COMMAND_LIMIT = 50;

const KNOWN_SOURCES: readonly CompletionSource[] = ["app", "extension", "prompt", "skill"];

/** Narrows a host-supplied source string to our union. */
export function toCompletionSource(value: string | undefined): CompletionSource | undefined {
  if (value === undefined) return undefined;
  return KNOWN_SOURCES.find((source) => source === value);
}

/**
 * App commands first, then the host's entries in the order received. Nothing is
 * dropped, so two entries may share a name — deliberately.
 */
export function buildCommandItems(hostCommands: readonly HostCommandEntry[]): CompletionItem[] {
  const items: CompletionItem[] = APP_COMMANDS.map((command) => ({
    value: `/${command.name}`,
    label: `/${command.name}`,
    description: command.description,
    ...(command.argumentHint ? { detail: command.argumentHint } : {}),
    source: "app",
  }));

  for (const command of hostCommands) {
    if (typeof command.name !== "string" || command.name.length === 0) continue;
    const source = toCompletionSource(command.source) ?? "extension";
    items.push({
      value: `/${command.name}`,
      label: `/${command.name}`,
      ...(command.description ? { description: command.description } : {}),
      ...(command.argumentHint ? { detail: command.argumentHint } : {}),
      source,
    });
  }
  return items;
}

export interface CommandProviderOptions {
  loadCommands(options: { signal: AbortSignal }): Promise<readonly HostCommandEntry[]>;
  limit?: number;
}

export function createCommandProvider(options: CommandProviderOptions): CompletionProvider {
  const limit = options.limit ?? DEFAULT_COMMAND_LIMIT;
  return {
    id: "app-commands",
    triggerCharacters: ["/"],
    async getSuggestions(lines, cursorLine, cursorCol, completionOptions) {
      const trigger = commandTrigger(lines, cursorLine, cursorCol);
      if (!trigger) return null;

      const hostCommands = await options.loadCommands({ signal: completionOptions.signal });
      if (completionOptions.signal.aborted) return null;

      const ranked = fuzzyFilter(buildCommandItems(hostCommands), trigger.query, (item) =>
        item.label.replace(/^\//, ""),
      );
      if (ranked.length === 0) return null;
      return { items: ranked.slice(0, limit), prefix: trigger.prefix };
    },
    applyCompletion: applyCompletionInPlace,
  };
}

/**
 * A `/` command is only recognised on the first line, before any space: after a
 * space the user is typing arguments, and the SDK owns those.
 */
function commandTrigger(
  lines: readonly string[],
  cursorLine: number,
  cursorCol: number,
): { prefix: string; query: string } | null {
  if (cursorLine !== 0) return null;
  const line = lines[0] ?? "";
  const before = line.slice(0, Math.max(0, Math.min(cursorCol, line.length)));
  if (!before.startsWith("/")) return null;
  if (/\s/.test(before)) return null;
  const token = tokenAtCursor(lines, cursorLine, cursorCol);
  return { prefix: token.query, query: before.slice(1) };
}

/** The command name and argument of a submitted buffer, or null when it is not one. */
export function parseCommandInput(text: string): { name: string; argument: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1);
  if (body.length === 0) return null;
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(body);
  if (!match) return null;
  const name = match[1] ?? "";
  if (name.length === 0) return null;
  return { name, argument: (match[2] ?? "").trim() };
}

/** True when the buffer looks like a command invocation. */
export function looksLikeCommand(text: string): boolean {
  return parseCommandInput(text) !== null;
}

export function suggestionsOf(
  items: readonly CompletionItem[],
  prefix: string,
): CompletionSuggestions {
  return { items: [...items], prefix };
}
