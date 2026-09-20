import { describe, expect, it, vi } from "vitest";

import {
  createShortcutHandlers,
  listShortcuts,
  ShortcutError,
  type ShortcutRunner,
} from "../../src/host/shortcuts";

function runner(overrides: Partial<ShortcutRunner> = {}): ShortcutRunner {
  return {
    getShortcuts: () => new Map(),
    getShortcutDiagnostics: () => [],
    createContext: () => ({}),
    invokeShortcut: async () => undefined,
    ...overrides,
  };
}

describe("listShortcuts", () => {
  it("answers not_implemented without a runner (control hosts)", () => {
    expect(() => listShortcuts(null, {})).toThrowError(ShortcutError);
    try {
      listShortcuts(null, {});
    } catch (error) {
      expect((error as ShortcutError).code).toBe("not_implemented");
    }
  });

  it("lists shortcuts sorted with diagnostics", () => {
    const snapshot = listShortcuts(
      runner({
        getShortcuts: () =>
          new Map([
            ["ctrl+g", { key: "ctrl+g", description: "open", extensionPath: "C:\\x\\b-ext" }],
            ["ctrl+a", { key: "ctrl+a", extensionPath: "C:\\x\\a-ext" }],
          ]),
        getShortcutDiagnostics: () => [{ type: "collision", message: "clash", path: "C:\\x" }],
      }),
      {},
      () => 7,
    );
    expect(snapshot.shortcuts.map((entry) => entry.key)).toEqual(["ctrl+a", "ctrl+g"]);
    expect(snapshot.shortcuts[0]?.source).toBe("a-ext");
    expect(snapshot.diagnostics).toEqual([{ type: "collision", message: "clash", path: "C:\\x" }]);
    expect(snapshot.loadedAt).toBe(7);
  });
});

describe("createShortcutHandlers", () => {
  it("invokes through the runner with its own context", async () => {
    const invokeShortcut = vi.fn(async () => undefined);
    const context = { session: true };
    const handlers = createShortcutHandlers({
      resolveRunner: () => runner({ invokeShortcut, createContext: () => context }),
      resolveKeybindings: () => ({}),
    }).handlers();
    const result = await handlers["shortcuts.invoke"]?.({ key: "ctrl+g" }, {} as never);
    expect(result).toEqual({ invoked: "ctrl+g" });
    expect(invokeShortcut).toHaveBeenCalledWith("ctrl+g", context);
  });

  it("requires a key and a runner", async () => {
    const handlers = createShortcutHandlers({
      resolveRunner: () => runner(),
      resolveKeybindings: () => ({}),
    }).handlers();
    await expect(handlers["shortcuts.invoke"]?.({}, {} as never)).rejects.toThrow(ShortcutError);
    const control = createShortcutHandlers({
      resolveRunner: () => null,
      resolveKeybindings: () => ({}),
    }).handlers();
    await expect(control["shortcuts.list"]?.({}, {} as never)).rejects.toThrowError(
      expect.objectContaining({ code: "not_implemented" }),
    );
  });
});
