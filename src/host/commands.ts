/**
 * Extension command execution and argument completion (2026-10-24 parity plan).
 *
 * Pi's terminal editor resolves `/name arg` against the live `ExtensionRunner`:
 * it calls `getCommand(name)` and either runs the handler or asks the command's
 * `getArgumentCompletions(prefix)` for suggestions. Pi Desktop runs the same
 * functions here, in the host, because a function cannot cross the frame
 * boundary. This module is SDK-free: the composition root supplies a narrow
 * `CommandRunner` from `src/host/sdk/commands.ts`.
 *
 * `commands.run` deliberately executes the handler directly (not through
 * `prompt`): terminal Pi does the same, and it means an extension command works
 * while the agent is streaming instead of being rejected for a missing
 * `streamingBehavior`.
 */

import type { HostMethod } from "../shared/host-protocol";
import {
  COMMAND_ARGUMENT_LIMIT,
  sanitizeCommandArgumentItems,
  type CommandArgumentItem,
  type CommandCompleteResult,
  type CommandRunResult,
} from "../shared/commands";
import type { HostHandler } from "./service";

export class CommandError extends Error {
  readonly code: string;

  constructor(message: string, code = "bad_request") {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}

/** The methods this module answers (session hosts only). */
export const COMMAND_METHODS = [
  "commands.run",
  "commands.complete",
] as const satisfies readonly HostMethod[];

/** What an extension's argument hook may return (validated by the shared sanitizer). */
export type CommandArgumentItems = readonly unknown[] | null;

/** A command handler's result; the host ignores it after awaiting it. */
export type CommandHandlerResult = Promise<void> | void;

/** The extension command context, forwarded opaquely. */
export interface CommandContext {
  readonly [key: string]: unknown;
}

/** One live extension command, with only the members the host calls. */
export interface RunnerCommand {
  getArgumentCompletions?(prefix: string): CommandArgumentItems | Promise<CommandArgumentItems>;
  handler(args: string, context: CommandContext): CommandHandlerResult;
}

/** The narrow `ExtensionRunner` surface the handlers drive. */
export interface CommandRunner {
  getCommand(name: string): RunnerCommand | undefined;
  createCommandContext(): CommandContext;
  emitError?(error: { extensionPath: string; event: string; error: string }): void;
}

/** One error report, shaped like the SDK's `ExtensionError`. */
export interface CommandRunError {
  extensionPath: string;
  event: "command";
  error: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requireName(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CommandError("command name is required");
  }
  return value;
}

/**
 * Runs one command's argument hook. A missing hook, a non-array result, an
 * empty result or a throwing hook all mean "no menu" — a keystroke must never
 * produce an error toast.
 */
export async function completeCommand(
  runner: CommandRunner,
  name: string,
  prefix: string,
): Promise<CommandArgumentItem[]> {
  const command = runner.getCommand(name);
  const hook = command?.getArgumentCompletions;
  if (!command || typeof hook !== "function") return [];
  try {
    const result = await hook.call(command, prefix);
    return sanitizeCommandArgumentItems(result).slice(0, COMMAND_ARGUMENT_LIMIT);
  } catch {
    return [];
  }
}

/**
 * Executes one command handler exactly as `AgentSession._tryExecuteExtensionCommand`
 * does: a handler error is reported to the runner's error listeners and to the
 * host's event channel, then the invocation still counts as handled. Returning
 * `ran: false` is reserved for "no such live command".
 */
export async function runCommand(
  runner: CommandRunner,
  name: string,
  args: string,
  onError?: (error: CommandRunError) => void,
): Promise<CommandRunResult> {
  const command = runner.getCommand(name);
  if (!command) return { ran: false };
  try {
    await command.handler(args, runner.createCommandContext());
    return { ran: true };
  } catch (error) {
    const report = toCommandError(name, error);
    reportCommandError(runner, report, onError);
    return { ran: true, error: report.error };
  }
}

function toCommandError(name: string, error: unknown): CommandRunError {
  return {
    extensionPath: `command:${name}`,
    event: "command",
    error: error instanceof Error ? error.message : String(error),
  };
}

function reportCommandError(
  runner: CommandRunner,
  report: CommandRunError,
  onError?: (error: CommandRunError) => void,
): void {
  try {
    runner.emitError?.(report);
  } catch {
    // A broken error listener must not turn a handled command into a rejection.
  }
  try {
    onError?.(report);
  } catch {
    // Same: the command already ran, so reporting must stay best-effort.
  }
}

export interface CommandHandlerOptions {
  /** The live runner, or null when no session exists yet (control hosts, startup). */
  resolveRunner(): CommandRunner | null;
  /** The core's event sink, used to surface a handler error in the transcript. */
  emit(event: string, payload?: unknown): void;
  /**
   * Called before an acked (`ack: "started"`) handler can inject its user
   * message, so the host can remember the command origin.
   */
  onRun?(name: string, args: string): void;
}

export function createCommandHandlers(options: CommandHandlerOptions): {
  handlers(): Partial<Record<HostMethod, HostHandler>>;
} {
  const runnerOrThrow = (): CommandRunner => {
    const runner = options.resolveRunner();
    if (!runner) {
      throw new CommandError(
        "extension commands are not available in this host: open a session first",
        "not_implemented",
      );
    }
    return runner;
  };

  return {
    handlers: () => ({
      "commands.complete": async (params): Promise<CommandCompleteResult> => {
        const runner = runnerOrThrow();
        const record = asRecord(params);
        const name = requireName(record.name);
        if (record.prefix !== undefined && typeof record.prefix !== "string") {
          throw new CommandError("commands.complete requires a string prefix");
        }
        const prefix = typeof record.prefix === "string" ? record.prefix : "";
        const items = await completeCommand(runner, name, prefix);
        return { items: items.length > 0 ? items : null };
      },
      "commands.run": async (params): Promise<CommandRunResult> => {
        const runner = runnerOrThrow();
        const record = asRecord(params);
        const name = requireName(record.name);
        if (record.args !== undefined && typeof record.args !== "string") {
          throw new CommandError("commands.run requires a string args value");
        }
        if (record.ack !== undefined && record.ack !== "started") {
          throw new CommandError('ack must be "started" when provided');
        }
        const args = typeof record.args === "string" ? record.args : "";
        const onError = (error: CommandRunError): void => {
          options.emit("extension_error", error);
        };
        if (record.ack === "started") {
          // The renderer's composer must clear as soon as the command exists; a
          // command such as `/commit` keeps the handler alive for the whole
          // injected turn, so awaiting it here would block the request (and the
          // 30 s host timeout). Errors still reach the transcript through the
          // existing `extension_error` channel.
          const command = runner.getCommand(name);
          if (!command) return { ran: false };
          try {
            options.onRun?.(name, args);
          } catch {
            // Tracker bookkeeping must never block a command the renderer can
            // run; the transcript label is cosmetic.
          }
          void Promise.resolve()
            .then(() => command.handler(args, runner.createCommandContext()))
            .catch((error: unknown) => {
              reportCommandError(runner, toCommandError(name, error), onError);
            });
          return { ran: true };
        }
        return runCommand(runner, name, args, onError);
      },
    }),
  };
}
