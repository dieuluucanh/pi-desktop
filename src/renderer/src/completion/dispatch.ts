/**
 * The command dispatch table (plan step 7).
 *
 * A submitted buffer that starts with `/` is resolved here, never sent blind:
 *
 *   app command            → the app runs it (host method, view, or an honest hint)
 *   extension/prompt/skill → sent through `prompt`, where the SDK expands it
 *                            (this is how `/skill:<name>` injects content)
 *   unknown                → a hint, and **nothing is sent** — a typo must not
 *                            become a literal prompt the model has to parse
 *
 * Collisions are visible, not silent. Dispatch prefers the app's reserved
 * command, but when the user picked a specific line from the completion list the
 * picked source wins — that is how the palette disambiguates two entries that
 * share a name.
 */

import { APP_COMMANDS, findAppCommand, type AppCommand } from "./app-commands";
import { parseCommandInput, toCompletionSource, type HostCommandEntry } from "./command-source";
import type { CompletionSource } from "./types";

export interface CommandContext {
  hostCommands: readonly HostCommandEntry[];
  /** The source of the entry the user explicitly chose, when there was a choice. */
  preferredSource?: CompletionSource | undefined;
}

export type CommandResolution =
  | { kind: "not-a-command" }
  | { kind: "app"; name: string; argument: string; command: AppCommand }
  | { kind: "host"; name: string; argument: string; command: HostCommandEntry }
  | { kind: "unknown"; name: string; argument: string };

export function resolveCommandInput(text: string, context: CommandContext): CommandResolution {
  const parsed = parseCommandInput(text);
  if (!parsed) return { kind: "not-a-command" };

  const { name, argument } = parsed;
  const hostCommand = context.hostCommands.find((command) => command.name === name);

  // An explicit pick from the completion list beats the reserved app command:
  // that is the disambiguation the collision rule promises.
  const preferred = context.preferredSource;
  if (
    hostCommand &&
    preferred !== undefined &&
    preferred !== "app" &&
    (preferred === "extension" || preferred === "prompt" || preferred === "skill")
  ) {
    return { kind: "host", name, argument, command: hostCommand };
  }

  const appCommand = findAppCommand(name);
  if (appCommand) return { kind: "app", name, argument, command: appCommand };
  if (hostCommand) return { kind: "host", name, argument, command: hostCommand };
  return { kind: "unknown", name, argument };
}

/**
 * Names claimed by both the app and the host. The completion list shows both
 * entries; this is for tests and for any UI that wants to warn about a shadowed
 * extension command.
 */
export function findCommandCollisions(
  hostCommands: readonly HostCommandEntry[],
): Array<{ name: string; app: AppCommand; host: HostCommandEntry }> {
  const collisions: Array<{ name: string; app: AppCommand; host: HostCommandEntry }> = [];
  for (const hostCommand of hostCommands) {
    const app = findAppCommand(hostCommand.name);
    if (app && hostCommand.source !== "app")
      collisions.push({ name: app.name, app, host: hostCommand });
  }
  return collisions;
}

/** Every app command name, for the `/help` listing. */
export function appCommandNames(): string[] {
  return APP_COMMANDS.map((command) => `/${command.name}`);
}

/** True when the host says this name is a real (extension/template/skill) command. */
export function isKnownHostCommand(
  name: string,
  hostCommands: readonly HostCommandEntry[],
): boolean {
  return hostCommands.some((command) => command.name === name);
}

export { toCompletionSource };
