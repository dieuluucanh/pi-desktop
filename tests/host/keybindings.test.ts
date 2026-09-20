import { describe, expect, it, vi } from "vitest";

import {
  createKeybindingHandlers,
  KeybindingError,
  parseKeybindingsDocument,
  readKeybindings,
  validatedKeybindingsContent,
  type KeybindingPort,
} from "../../src/host/keybindings";
import { detectKeybindingConflicts, resolveKeybindings } from "../../src/shared/keybindings";

function port(overrides: Partial<KeybindingPort> = {}): KeybindingPort {
  return {
    path: () => "C:\\profile\\keybindings.json",
    read: async () => null,
    write: async () => undefined,
    remove: async () => undefined,
    ...overrides,
  };
}

describe("parseKeybindingsDocument", () => {
  it("treats a missing file as empty and rejects malformed JSON", () => {
    expect(parseKeybindingsDocument(null)).toEqual({});
    expect(() => parseKeybindingsDocument("{oops")).toThrow(KeybindingError);
    expect(() => parseKeybindingsDocument("[]")).toThrow(/object/);
  });
});

describe("readKeybindings", () => {
  it("resolves defaults when no file exists", async () => {
    const snapshot = await readKeybindings(port());
    expect(snapshot.exists).toBe(false);
    expect(snapshot.user).toEqual({});
    expect(snapshot.effective["app.exit"]).toEqual(["ctrl+d"]);
    expect(snapshot.definitions.length).toBeGreaterThan(0);
    // No file means exactly Pi's default overlaps (modal contexts share chords
    // by design) — nothing the user introduced.
    expect(snapshot.conflicts).toEqual(detectKeybindingConflicts(resolveKeybindings({})));
  });

  it("applies overrides and reports unknown ids, issues and conflicts", async () => {
    const snapshot = await readKeybindings(
      port({
        read: async () =>
          JSON.stringify({
            "app.exit": ["ctrl+q"],
            "app.typo": ["ctrl+q"],
            "app.tools.expand": ["ctrl+q"],
          }),
      }),
    );
    expect(snapshot.exists).toBe(true);
    expect(snapshot.effective["app.exit"]).toEqual(["ctrl+q"]);
    expect(snapshot.unknownIds).toEqual(["app.typo"]);
    expect(snapshot.conflicts.map((entry) => entry.key)).toContain("ctrl+q");
  });
});

describe("validatedKeybindingsContent", () => {
  it("refuses unknown ids and bad keys before anything is written", () => {
    expect(() => validatedKeybindingsContent({ "app.nope": ["a"] })).toThrow(/unknown/);
    expect(() => validatedKeybindingsContent({ "app.exit": ["control+q"] })).toThrow(/modifier/);
    expect(validatedKeybindingsContent({ "app.exit": ["ctrl+q"] })).toMatch(/ctrl\+q/);
  });
});

describe("createKeybindingHandlers", () => {
  it("writes validated content and resets by removing the file", async () => {
    let stored: string | null = null;
    const write = vi.fn(async (content: string) => {
      stored = content;
    });
    const remove = vi.fn(async () => {
      stored = null;
    });
    const handlers = createKeybindingHandlers({
      resolvePort: () => port({ read: async () => stored, write, remove }),
    }).handlers();
    const after = (await handlers["keybindings.set"]?.(
      {
        bindings: { "app.exit": ["ctrl+q"] },
      },
      {} as never,
    )) as { user: Record<string, string[]> };
    expect(write).toHaveBeenCalledOnce();
    expect(after.user["app.exit"]).toEqual(["ctrl+q"]);
    await expect(
      handlers["keybindings.set"]?.({ bindings: { "app.exit": ["control+q"] } }, {} as never),
    ).rejects.toThrow(KeybindingError);
    await handlers["keybindings.reset"]?.({}, {} as never);
    expect(remove).toHaveBeenCalledOnce();
  });

  it("answers not_implemented without a port", async () => {
    const handlers = createKeybindingHandlers({ resolvePort: () => null }).handlers();
    await expect(handlers["keybindings.get"]?.({}, {} as never)).rejects.toMatchObject({
      code: "not_implemented",
    });
  });
});
