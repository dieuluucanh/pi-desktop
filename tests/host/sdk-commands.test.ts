import { describe, expect, it, vi } from "vitest";

import { createSdkCommandRunner, type SdkCommandRunner } from "../../src/host/sdk/commands";
import type { CommandContext } from "../../src/host/commands";

/** The `ExtensionRunner` adapter for `commands.complete`/`commands.run`. */

function fakeRunner(overrides: Partial<SdkCommandRunner> = {}): SdkCommandRunner {
  return {
    getCommand: () => undefined,
    createCommandContext: () => ({ kind: "context" }) as CommandContext,
    emitError: vi.fn(),
    ...overrides,
  };
}

describe("createSdkCommandRunner", () => {
  it("maps a registered command's hook and handler", async () => {
    const handler = vi.fn(async () => undefined);
    const hook = vi.fn(() => [{ value: "use ", label: "use" }]);
    const runner = createSdkCommandRunner(
      fakeRunner({
        getCommand: (name) =>
          name === "profile" ? { handler, getArgumentCompletions: hook } : undefined,
      }),
    );

    const command = runner.getCommand("profile");
    expect(command).toBeDefined();
    expect(command!.getArgumentCompletions?.("u")).toEqual([{ value: "use ", label: "use" }]);
    await command!.handler("use x", runner.createCommandContext());
    expect(hook).toHaveBeenCalledWith("u");
    expect(handler).toHaveBeenCalledWith("use x", { kind: "context" });
  });

  it("omits the hook when the command has none", () => {
    const runner = createSdkCommandRunner(
      fakeRunner({ getCommand: () => ({ handler: async () => undefined }) }),
    );
    expect(runner.getCommand("plain")?.getArgumentCompletions).toBeUndefined();
  });

  it("forwards the runner's context and error reports", () => {
    const emitError = vi.fn();
    const context = { kind: "live-context" } as CommandContext;
    const runner = createSdkCommandRunner(
      fakeRunner({ createCommandContext: () => context, emitError }),
    );

    expect(runner.createCommandContext()).toBe(context);
    runner.emitError?.({
      extensionPath: "command:deploy",
      event: "command",
      error: "boom",
    });
    expect(emitError).toHaveBeenCalledWith({
      extensionPath: "command:deploy",
      event: "command",
      error: "boom",
    });
  });
});
