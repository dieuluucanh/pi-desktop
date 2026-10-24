/**
 * The `CommandRunner` over a live session's `ExtensionRunner`.
 *
 * Only the three members the host calls are adapted. Keeping this here means
 * `src/host/commands.ts` never imports the SDK (AGENTS.md rule 4) and the
 * handler module can be tested with a fictitious runner.
 */

import type {
  CommandArgumentItems,
  CommandContext,
  CommandHandlerResult,
  CommandRunner,
  RunnerCommand,
} from "../commands";

/** The narrow runner surface the adapter drives (mirrors the SDK's runner). */
export interface SdkCommandRunner {
  getCommand(name: string):
    | {
        getArgumentCompletions?: (prefix: string) => CommandArgumentItems;
        handler(args: string, context: never): CommandHandlerResult;
      }
    | undefined;
  createCommandContext(): CommandContext;
  emitError(error: { extensionPath: string; event: string; error: string }): void;
}

export function createSdkCommandRunner(runner: SdkCommandRunner): CommandRunner {
  return {
    getCommand: (name): RunnerCommand | undefined => {
      const command = runner.getCommand(name);
      if (!command) return undefined;
      return {
        ...(typeof command.getArgumentCompletions === "function"
          ? { getArgumentCompletions: (prefix: string) => command.getArgumentCompletions!(prefix) }
          : {}),
        handler: (args, context) => command.handler(args, context as never),
      };
    },
    createCommandContext: () => runner.createCommandContext(),
    emitError: (error) => runner.emitError(error),
  };
}
