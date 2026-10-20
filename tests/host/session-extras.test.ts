import { describe, expect, it, vi } from "vitest";

import {
  createSessionCore,
  type HostSession,
  type SessionCoreDeps,
} from "../../src/host/session-core";
import type { HostMethod } from "../../src/shared/host-protocol";
import type { HostRequestContext } from "../../src/host/service";

/**
 * Session-host skills surface (plan step 15): themes from the session's own
 * manager and loader, profile keybindings, and extension shortcuts through the
 * live runner — all against injected fakes, no SDK process.
 */

const CWD = "C:/work";
const AGENT_DIR = "C:/profile";

function fakeSession(runner: Record<string, unknown> = {}): HostSession {
  return {
    sessionId: "session-1",
    sessionFile: "C:/profile/sessions/session-1.jsonl",
    sessionName: "Budget work",
    messages: [],
    isStreaming: false,
    isIdle: true,
    extensionRunner: {
      getRegisteredCommands: () => [],
      ...runner,
    },
    resourceLoader: {
      getSkills: () => ({ skills: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
    },
  } as unknown as HostSession;
}

function harness(deps: Partial<SessionCoreDeps> = {}) {
  const session = fakeSession({
    getShortcuts: () =>
      new Map([["ctrl+g", { key: "ctrl+g", description: "open", extensionPath: "C:\\x\\ext" }]]),
    getShortcutDiagnostics: () => [],
    createContext: () => ({ live: true }),
  });
  const core = createSessionCore({
    cwd: CWD,
    agentDir: AGENT_DIR,
    createRuntime: async () => ({
      runtime: { session, services: { cwd: CWD } },
      session,
    }),
    newSessionManager: () => ({ id: "new" }),
    emit: () => undefined,
    ...deps,
  });
  const call = async (method: HostMethod, params?: unknown): Promise<unknown> => {
    const handler = core.handlers()[method];
    if (!handler) throw new Error(`no handler for ${method}`);
    return handler(params, { method } as HostRequestContext);
  };
  return { core, call };
}

describe("session themes and keybindings", () => {
  it("answers themes.list from the session port and keybindings from the profile port", async () => {
    const { call } = harness({
      createThemePort: () => ({
        listLoaded: async () => [],
        getActive: async () => "dark",
        readFile: async () => null,
        importFile: async (filename: string) => `/t/${filename}`,
      }),
      keybindingPort: {
        path: () => "/profile/keybindings.json",
        read: async () => null,
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    const themes = (await call("themes.list")) as { active: string; themes: unknown[] };
    expect(themes.active).toBe("dark");
    expect(themes.themes).toHaveLength(2);
    const bindings = (await call("keybindings.get")) as { exists: boolean };
    expect(bindings.exists).toBe(false);
  });

  it("answers not_implemented without the ports", async () => {
    const { call } = harness();
    await expect(call("themes.list")).rejects.toMatchObject({ code: "not_implemented" });
    await expect(call("keybindings.get")).rejects.toMatchObject({ code: "not_implemented" });
  });
});

describe("session shortcuts", () => {
  it("lists shortcuts before any session exists as not_implemented, then live", async () => {
    const invoked: unknown[] = [];
    const { call } = harness({
      wrapShortcutRunner: () => ({
        getShortcuts: () =>
          new Map([
            ["ctrl+g", { key: "ctrl+g", description: "open", extensionPath: "C:\\x\\ext" }],
          ]),
        getShortcutDiagnostics: () => [],
        createContext: () => ({ live: true }),
        invokeShortcut: async (key, context) => {
          invoked.push([key, context]);
        },
      }),
    });
    await expect(call("shortcuts.list")).rejects.toMatchObject({ code: "not_implemented" });
    await call("session.create", {});
    const listed = (await call("shortcuts.list")) as {
      shortcuts: Array<{ key: string; source: string }>;
    };
    expect(listed.shortcuts).toEqual([
      { key: "ctrl+g", description: "open", extensionPath: "C:\\x\\ext", source: "ext" },
    ]);
    expect(await call("shortcuts.invoke", { key: "ctrl+g" })).toEqual({ invoked: "ctrl+g" });
    expect(invoked).toEqual([["ctrl+g", { live: true }]]);
  });

  it("resolves shortcuts through the user's bindings", async () => {
    const seen: unknown[] = [];
    const { call } = harness({
      keybindingPort: {
        path: () => "/profile/keybindings.json",
        read: async () => JSON.stringify({ "app.exit": ["ctrl+q"] }),
        write: async () => undefined,
        remove: async () => undefined,
      },
      wrapShortcutRunner: () => ({
        getShortcuts: (resolved) => {
          seen.push(resolved);
          return new Map();
        },
        getShortcutDiagnostics: () => [],
        createContext: () => ({}),
        invokeShortcut: async () => undefined,
      }),
    });
    await call("session.create", {});
    await call("shortcuts.list");
    // Effective config, like terminal Pi (2026-10-20 startup-tab-cycle plan):
    // the user override replaces the default, and every other id keeps its
    // documented default.
    const resolved = seen[0] as Record<string, string[]>;
    expect(resolved["app.exit"]).toEqual(["ctrl+q"]);
    expect(resolved["tui.input.submit"]).toEqual(["enter"]);
  });

  it("falls back without an SDK adapter (lists, but cannot invoke)", async () => {
    const { call } = harness();
    await call("session.create", {});
    const listed = (await call("shortcuts.list")) as { shortcuts: unknown[] };
    expect(listed.shortcuts).toEqual([]);
    await expect(call("shortcuts.invoke", { key: "ctrl+g" })).rejects.toThrow(/SDK adapter/);
  });
});

describe("session keybinding writes", () => {
  it("round-trips set through the profile port", async () => {
    let stored: string | null = null;
    const { call } = harness({
      keybindingPort: {
        path: () => "/profile/keybindings.json",
        read: async () => stored,
        write: vi.fn(async (content: string) => {
          stored = content;
        }),
        remove: async () => {
          stored = null;
        },
      },
    });
    const after = (await call("keybindings.set", {
      bindings: { "app.exit": ["ctrl+q"] },
    })) as { user: Record<string, string[]> };
    expect(after.user["app.exit"]).toEqual(["ctrl+q"]);
    expect(stored).toMatch(/ctrl\+q/);
  });
});
