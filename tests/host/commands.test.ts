import { describe, expect, it, vi, type Mock } from "vitest";

import {
  type CommandArgumentItems,
  type CommandError,
  completeCommand,
  createCommandHandlers,
  runCommand,
  type CommandContext,
  type CommandRunner,
  type RunnerCommand,
} from "../../src/host/commands";
import type { HostHandler } from "../../src/host/service";
import type { HostMethod } from "../../src/shared/host-protocol";

/** The SDK-free command port (2026-10-24 command parity plan). */

interface FakeCommand {
  getArgumentCompletions?: (prefix: string) => CommandArgumentItems | Promise<CommandArgumentItems>;
  handler?: (args: string, context: CommandContext) => Promise<void> | void;
}

type ErrorFn = (error: { extensionPath: string; event: string; error: string }) => void;

interface FakeRunner extends CommandRunner {
  emitError: Mock<ErrorFn>;
  context: CommandContext;
}

function fakeRunner(commands: Record<string, FakeCommand> = {}): FakeRunner {
  const context: CommandContext = { source: "fake-context" };
  return {
    getCommand: (name): RunnerCommand | undefined => {
      const command = commands[name];
      if (!command) return undefined;
      return {
        ...(command.getArgumentCompletions
          ? { getArgumentCompletions: command.getArgumentCompletions }
          : {}),
        handler: (args, runContext) =>
          command.handler ? command.handler(args, runContext) : undefined,
      };
    },
    createCommandContext: () => context,
    emitError: vi.fn<ErrorFn>(),
    context,
  };
}

describe("completeCommand", () => {
  it("returns sanitized items and preserves a trailing space", async () => {
    const runner = fakeRunner({
      profile: {
        getArgumentCompletions: (prefix) =>
          prefix === "u"
            ? [
                { value: "use ", label: "use", description: "activate a profile" },
                { value: 3, label: "bad" },
              ]
            : null,
      },
    });

    await expect(completeCommand(runner, "profile", "u")).resolves.toEqual([
      { value: "use ", label: "use", description: "activate a profile" },
    ]);
  });

  it("awaits an async hook and caps the list", async () => {
    const many = Array.from({ length: 70 }, (_, index) => ({
      value: `value-${index}`,
      label: `label-${index}`,
    }));
    const runner = fakeRunner({
      deploy: { getArgumentCompletions: async () => many },
    });
    await expect(completeCommand(runner, "deploy", "")).resolves.toHaveLength(50);
  });

  it("returns no menu for an unknown command, a missing hook, or a throwing hook", async () => {
    const runner = fakeRunner({
      plain: {},
      broken: {
        getArgumentCompletions: () => {
          throw new Error("boom");
        },
      },
    });
    await expect(completeCommand(runner, "missing", "")).resolves.toEqual([]);
    await expect(completeCommand(runner, "plain", "")).resolves.toEqual([]);
    await expect(completeCommand(runner, "broken", "")).resolves.toEqual([]);
  });
});

describe("runCommand", () => {
  it("passes the exact args and the runner's command context", async () => {
    const handler = vi.fn(async () => undefined);
    const runner = fakeRunner({ deploy: { handler } });

    await expect(runCommand(runner, "deploy", "now --force")).resolves.toEqual({ ran: true });
    expect(handler).toHaveBeenCalledWith("now --force", runner.context);
  });

  it("reports an unknown command without calling anything", async () => {
    const runner = fakeRunner();
    await expect(runCommand(runner, "missing", "")).resolves.toEqual({ ran: false });
    expect(runner.emitError).not.toHaveBeenCalled();
  });

  it("emits a handler error to the runner and the host, and still counts as handled", async () => {
    const runner = fakeRunner({
      broken: {
        handler: () => {
          throw new Error("handler exploded");
        },
      },
    });
    const onError = vi.fn();

    await expect(runCommand(runner, "broken", "", onError)).resolves.toEqual({
      ran: true,
      error: "handler exploded",
    });
    expect(runner.emitError).toHaveBeenCalledWith({
      extensionPath: "command:broken",
      event: "command",
      error: "handler exploded",
    });
    expect(onError).toHaveBeenCalledWith({
      extensionPath: "command:broken",
      event: "command",
      error: "handler exploded",
    });
  });

  it("does not turn a broken error listener into a rejection", async () => {
    const runner = fakeRunner({
      broken: {
        handler: () => {
          throw new Error("handler exploded");
        },
      },
    });
    runner.emitError.mockImplementation(() => {
      throw new Error("listener exploded");
    });
    const onError = vi.fn(() => {
      throw new Error("emit exploded");
    });

    await expect(runCommand(runner, "broken", "", onError)).resolves.toMatchObject({
      ran: true,
    });
  });
});

describe("createCommandHandlers", () => {
  const call = async (
    handlers: Partial<Record<HostMethod, HostHandler>>,
    method: HostMethod,
    params: unknown,
  ): Promise<unknown> => {
    const handler = handlers[method];
    if (!handler) throw new Error(`no handler for ${method}`);
    return handler(params, {} as never);
  };

  it("answers not_implemented without a live runner", async () => {
    const { handlers } = createCommandHandlers({
      resolveRunner: () => null,
      emit: () => undefined,
    });
    const map = handlers();

    for (const method of ["commands.complete", "commands.run"] as const) {
      await expect(call(map, method, { name: "x" })).rejects.toMatchObject({
        code: "not_implemented",
      } satisfies Partial<CommandError>);
    }
  });

  it("validates the command name and string parameters", async () => {
    const { handlers } = createCommandHandlers({
      resolveRunner: () => fakeRunner(),
      emit: () => undefined,
    });
    const map = handlers();

    await expect(call(map, "commands.complete", {})).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(call(map, "commands.run", { name: "x", args: 3 })).rejects.toMatchObject({
      code: "bad_request",
    });
  });

  it("returns null items when the command has no menu", async () => {
    const { handlers } = createCommandHandlers({
      resolveRunner: () => fakeRunner({ deploy: {} }),
      emit: () => undefined,
    });
    const result = await call(handlers(), "commands.complete", { name: "deploy", prefix: "" });
    expect(result).toEqual({ items: null });
  });

  it("runs the handler and surfaces its error as an extension_error event", async () => {
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const runner = fakeRunner({
      broken: {
        handler: () => {
          throw new Error("nope");
        },
      },
    });
    const { handlers } = createCommandHandlers({
      resolveRunner: () => runner,
      emit: (event, payload) => emitted.push({ event, payload }),
    });

    await expect(call(handlers(), "commands.run", { name: "broken", args: "a" })).resolves.toEqual({
      ran: true,
      error: "nope",
    });
    expect(emitted).toEqual([
      {
        event: "extension_error",
        payload: { extensionPath: "command:broken", event: "command", error: "nope" },
      },
    ]);
  });

  it("acks an opted-in command at start and reports a later handler error", async () => {
    let release!: () => void;
    const run = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = vi.fn(async () => {
      await run;
      throw new Error("late failure");
    });
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const { handlers } = createCommandHandlers({
      resolveRunner: () => fakeRunner({ slow: { handler } }),
      emit: (event, payload) => emitted.push({ event, payload }),
    });

    await expect(
      call(handlers(), "commands.run", { name: "slow", args: "-a", ack: "started" }),
    ).resolves.toEqual({ ran: true });
    expect(handler).toHaveBeenCalledWith("-a", expect.anything());
    expect(emitted).toEqual([]);

    release();
    await vi.waitFor(() => {
      expect(emitted).toEqual([
        {
          event: "extension_error",
          payload: { extensionPath: "command:slow", event: "command", error: "late failure" },
        },
      ]);
    });
  });

  it("registers onRun before the handler", async () => {
    const order: string[] = [];
    const { handlers } = createCommandHandlers({
      resolveRunner: () =>
        fakeRunner({ commit: { handler: async () => void order.push("handler") } }),
      emit: () => undefined,
      onRun: (name, args) => {
        order.push(`onRun:${name}:${args}`);
      },
    });

    await call(handlers(), "commands.run", { name: "commit", args: "-a", ack: "started" });
    expect(order[0]).toBe("onRun:commit:-a");
    await vi.waitFor(() => {
      expect(order).toEqual(["onRun:commit:-a", "handler"]);
    });
  });

  it("keeps the non-ack path awaited and validates the ack value", async () => {
    const handler = vi.fn(async () => undefined);
    const { handlers } = createCommandHandlers({
      resolveRunner: () => fakeRunner({ deploy: { handler } }),
      emit: () => undefined,
    });

    await expect(
      call(handlers(), "commands.run", { name: "deploy", ack: "later" }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      call(handlers(), "commands.run", { name: "missing", ack: "started" }),
    ).resolves.toEqual({ ran: false });
    expect(handler).not.toHaveBeenCalled();
  });
});
