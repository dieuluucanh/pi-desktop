/**
 * `/` completion (plan step 7): the app's reserved commands plus everything the
 * host reports from `commands.list` — extension commands, prompt templates and
 * skills, in the same order Pi's RPC `get_commands` builds them.
 *
 * A name collision is **kept as two entries** rather than de-duplicated: the
 * list shows the source of each, so `/model` from an extension is visible next
 * to the app's own, and the palette can pick either. Silent shadowing is the
 * failure mode this exists to prevent.
 *
 * After the first space the buffer is an **argument** (2026-10-24 command
 * parity plan). App-reserved commands use the renderer's own completers; every
 * other command sends its full argument prefix to the host, which evaluates the
 * extension's `getArgumentCompletions` and returns plain items. The prefix is
 * passed through verbatim — trailing spaces are meaningful to the extension's
 * own `joinArgumentValue` contract.
 */

import type { CommandArgumentItem } from "../../../shared/commands";
import { APP_COMMANDS, findAppCommand } from "./app-commands";
import { fuzzyFilter } from "./fuzzy";
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

/** What the command provider sends to the host or the app completer. */
export interface CommandArgumentRequest {
  name: string;
  /** The entire argument text before the caret (Pi passes the same string). */
  prefix: string;
  signal: AbortSignal;
}

export interface CommandProviderOptions {
  loadCommands(options: { signal: AbortSignal }): Promise<readonly HostCommandEntry[]>;
  /** Host-run `commands.complete`; absent in pure tests and before a session. */
  completeCommand?(request: CommandArgumentRequest): Promise<readonly CommandArgumentItem[] | null>;
  /** App-owned completers for `/model`, `/thinking`, `/login`. */
  completeAppArgument?(request: CommandArgumentRequest): Promise<readonly CompletionItem[] | null>;
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

      if (trigger.kind === "name") {
        const hostCommands = await options.loadCommands({ signal: completionOptions.signal });
        if (completionOptions.signal.aborted) return null;

        const ranked = fuzzyFilter(buildCommandItems(hostCommands), trigger.query, (item) =>
          item.label.replace(/^\//, ""),
        );
        if (ranked.length === 0) return null;
        return { items: ranked.slice(0, limit), prefix: trigger.prefix };
      }

      // The app reserves its own names: its completers only, never a same-named
      // extension's. A colliding extension is still reachable by picking its
      // name-level entry (plan decision D7).
      if (findAppCommand(trigger.name)) {
        if (!options.completeAppArgument) return null;
        try {
          const items = await options.completeAppArgument({
            name: trigger.name,
            prefix: trigger.prefix,
            signal: completionOptions.signal,
          });
          if (completionOptions.signal.aborted) return null;
          if (!items || items.length === 0) return null;
          return {
            items: items.slice(0, limit).map((item) => ({
              ...item,
              source: "app",
              appendSpace: false,
              remote: false,
            })),
            prefix: trigger.prefix,
          };
        } catch {
          return null;
        }
      }

      const hostCommands = await options.loadCommands({ signal: completionOptions.signal });
      if (completionOptions.signal.aborted) return null;
      const command = hostCommands.find((entry) => entry.name === trigger.name);
      if (!command || !options.completeCommand) return null;

      try {
        const items = await options.completeCommand({
          name: trigger.name,
          prefix: trigger.prefix,
          signal: completionOptions.signal,
        });
        if (completionOptions.signal.aborted) return null;
        if (!items || items.length === 0) return null;
        const source = toCompletionSource(command.source) ?? "extension";
        return {
          items: items.slice(0, limit).map((item) => ({
            value: item.value,
            label: item.label,
            ...(item.description ? { description: item.description } : {}),
            source,
            appendSpace: false,
          })),
          prefix: trigger.prefix,
        };
      } catch {
        return null;
      }
    },
    applyCompletion: applyCompletionInPlace,
  };
}

type CommandTrigger =
  | { kind: "name"; prefix: string; query: string }
  | { kind: "argument"; name: string; prefix: string; query: string };

/**
 * A `/` command is recognised on the first line only. Before the first
 * whitespace the user is naming a command; after it, the entire suffix before
 * the caret is the argument prefix the extension expects.
 */
function commandTrigger(
  lines: readonly string[],
  cursorLine: number,
  cursorCol: number,
): CommandTrigger | null {
  if (cursorLine !== 0) return null;
  const line = lines[0] ?? "";
  if (!line.startsWith("/")) return null;
  const col = Math.max(0, Math.min(cursorCol, line.length));
  const spaceIndex = line.search(/[ \t]/);

  if (spaceIndex === -1 || col <= spaceIndex) {
    const before = line.slice(0, col);
    return { kind: "name", prefix: before, query: before.slice(1) };
  }

  const name = line.slice(1, spaceIndex);
  if (name.length === 0) return null;
  const prefix = line.slice(spaceIndex + 1, col);
  return { kind: "argument", name, prefix, query: prefix };
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
