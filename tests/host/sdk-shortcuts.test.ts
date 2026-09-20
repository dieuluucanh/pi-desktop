import { describe, expect, it, vi } from "vitest";

import { createSdkShortcutRunner, type SdkExtensionRunner } from "../../src/host/sdk/shortcuts";

function runner(overrides: Partial<SdkExtensionRunner> = {}): SdkExtensionRunner {
  return {
    getShortcuts: () => new Map(),
    getShortcutDiagnostics: () => [],
    createContext: () => ({}),
    ...overrides,
  };
}

describe("createSdkShortcutRunner", () => {
  it("lists shortcuts keyed by chord with owner and description", () => {
    const adapter = createSdkShortcutRunner(
      runner({
        getShortcuts: () =>
          new Map([
            [
              "ctrl+g",
              {
                shortcut: "ctrl+g",
                description: "open",
                handler: async () => undefined,
                extensionPath: "C:\\x\\ext",
              },
            ],
          ]),
      }),
    );
    expect([...adapter.getShortcuts({}).entries()]).toEqual([
      ["ctrl+g", { key: "ctrl+g", description: "open", extensionPath: "C:\\x\\ext" }],
    ]);
  });

  it("passes the app's effective bindings through for resolution", () => {
    const getShortcuts = vi.fn(() => new Map());
    const adapter = createSdkShortcutRunner(runner({ getShortcuts }));
    const resolved = { "app.exit": ["ctrl+q"] };
    adapter.getShortcuts(resolved);
    expect(getShortcuts).toHaveBeenCalledWith(resolved);
  });

  it("invokes the matching handler with the runner's context", async () => {
    const handler = vi.fn(async () => undefined);
    const context = { session: true };
    const adapter = createSdkShortcutRunner(
      runner({
        getShortcuts: () =>
          new Map([["ctrl+g", { shortcut: "ctrl+g", handler, extensionPath: "C:\\x\\ext" }]]),
        createContext: () => context,
      }),
    );
    await adapter.invokeShortcut("ctrl+g", adapter.createContext());
    expect(handler).toHaveBeenCalledWith(context);
    await expect(adapter.invokeShortcut("ctrl+z", {})).rejects.toThrow(/no extension shortcut/);
  });

  it("forwards loader diagnostics", () => {
    const adapter = createSdkShortcutRunner(
      runner({ getShortcutDiagnostics: () => [{ type: "collision", message: "clash" }] }),
    );
    expect(adapter.getShortcutDiagnostics()).toEqual([{ type: "collision", message: "clash" }]);
  });
});
