import { describe, expect, it, vi, type Mock } from "vitest";
import type { HostMethod } from "../../src/shared/host-protocol";
import { createSessionCore } from "../../src/host/session-core";

/**
 * The step-4 protocol surface (session side), driven through the real core with
 * fake SDK adapters. Every handler added in step 4 is covered here, including the
 * documented `not_implemented` ones — a method that is deliberately unwired must
 * say so instead of hanging or answering `{}`.
 */

interface TestSession {
  prompt: Mock<(text: string, options?: unknown) => Promise<void>>;
  cycleModel: Mock<(direction?: string, options?: unknown) => Promise<unknown>>;
  cycleThinkingLevel: Mock<(options?: unknown) => unknown>;
  setAutoCompactionEnabled: Mock<(enabled: boolean) => void>;
  setAutoRetryEnabled: Mock<(enabled: boolean) => void>;
  abortRetry: Mock<() => void>;
  setSteeringMode: Mock<(mode: string) => void>;
  setFollowUpMode: Mock<(mode: string) => void>;
  navigateTree: Mock<(targetId: string, options?: unknown) => Promise<unknown>>;
  exportToHtml: Mock<(outputPath?: string) => Promise<string>>;
}

function fakeSession(overrides: Record<string, unknown> = {}): TestSession {
  const session = {
    sessionId: "s1",
    sessionFile: "/profile/sessions/s1.jsonl",
    sessionName: null,
    model: { id: "test-model", provider: "test" },
    thinkingLevel: "medium",
    isStreaming: false,
    isIdle: true,
    messages: [] as unknown[],
    pendingMessageCount: 0,
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    subscribe: () => () => undefined,
    prompt: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    clearQueue: () => ({ steering: [], followUp: [] }),
    getAllTools: () => [],
    getActiveToolNames: () => ["read"],
    getAvailableThinkingLevels: () => ["off", "medium", "high"],
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    // Pi reports context usage as 0-100 (`(tokens / contextWindow) * 100`).
    getContextUsage: () => ({ tokens: 1200, contextWindow: 200_000, percent: 60 }),
    getSessionStats: () => ({
      tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1, total: 126 },
      cost: 0.03,
    }),
    getSteeringMode: () => "one-at-a-time",
    getFollowUpMode: () => "all",
    setSteeringMode: vi.fn(),
    setFollowUpMode: vi.fn(),
    setAutoCompactionEnabled: vi.fn(),
    setAutoRetryEnabled: vi.fn(),
    abortRetry: vi.fn(),
    cycleModel: vi.fn(async () => undefined),
    cycleThinkingLevel: vi.fn(() => "high"),
    setModel: vi.fn(async () => undefined),
    setThinkingLevel: vi.fn(),
    setActiveToolsByName: vi.fn(),
    compact: vi.fn(async () => ({ summary: "compacted" })),
    reload: vi.fn(async () => undefined),
    navigateTree: vi.fn(async () => ({ cancelled: false, editorText: "resumed text" })),
    exportToHtml: vi.fn(async (outputPath?: string) => outputPath ?? "/profile/sessions/s1.html"),
    getLastAssistantText: () => "the last answer",
    extensionRunner: {
      getRegisteredCommands: () => [
        { invocationName: "plan", description: "Plan mode", sourceInfo: { path: "/ext.ts" } },
      ],
    },
    promptTemplates: [
      {
        name: "review",
        description: "Review",
        argumentHint: "<file>",
        sourceInfo: { path: "/r.md" },
      },
    ],
    resourceLoader: {
      getSkills: () => ({
        skills: [{ name: "brave-search", description: "Search", sourceInfo: { path: "/S.md" } }],
      }),
    },
    ...overrides,
  };
  return session as unknown as TestSession;
}

function fakeManager() {
  const entries = [
    { type: "message", id: "e1", message: { role: "user", content: "first" } },
    {
      type: "message",
      id: "e2",
      message: { role: "assistant", content: [{ type: "text", text: "reply" }] },
    },
    {
      type: "message",
      id: "e3",
      message: { role: "user", content: [{ type: "text", text: "second" }] },
    },
    { type: "model_change", id: "e4" },
  ];
  const labels: Array<{ targetId: string; label: string | undefined }> = [];
  return {
    labels,
    appendSessionInfo: (name: string) => `/profile/sessions/${name}.jsonl`,
    getSessionFile: () => "/profile/sessions/s1.jsonl",
    getEntries: () => entries,
    getBranch: () => entries,
    getTree: () => [{ entry: { id: "e1" }, children: [] }],
    getLeafId: () => "e4",
    appendLabelChange: (targetId: string, label: string | undefined) => {
      labels.push({ targetId, label });
      return `label-${labels.length}`;
    },
  };
}

function harness(overrides: Record<string, unknown> = {}) {
  // `keybindingPort` and `wrapShortcutRunner` are host deps, not session
  // fields: pull them out before building the fake session (2026-10-20
  // startup-tab-cycle plan).
  const { keybindingPort, wrapShortcutRunner, ...sessionOverrides } = overrides;
  const session = fakeSession(sessionOverrides);
  const manager = fakeManager();
  const emitted: Array<{ event: string; payload?: unknown }> = [];
  const runtime = {
    get session() {
      return session;
    },
    services: {
      settingsManager: {
        getGlobalSettings: () => ({ theme: "dark" }),
        getProjectSettings: () => ({ defaultTools: ["read"] }),
        flush: vi.fn(async () => undefined),
        drainErrors: () => [],
      },
    },
    newSession: vi.fn(async () => ({ cancelled: false })),
    switchSession: vi.fn(async () => ({ cancelled: false })),
    clone: vi.fn(async () => ({ cancelled: false })),
    fork: vi.fn(async () => ({ cancelled: false, selectedText: "first" })),
    dispose: vi.fn(async () => undefined),
  };

  const core = createSessionCore({
    cwd: "/work/app",
    agentDir: "/profile",
    emit: (event, payload) =>
      emitted.push({ event, ...(payload === undefined ? {} : { payload }) }),
    createRuntime: async () => ({ runtime, session }) as never,
    newSessionManager: () => manager as never,
    openSessionManager: () => manager as never,
    ...(keybindingPort == null ? {} : { keybindingPort: keybindingPort as never }),
    ...(wrapShortcutRunner == null ? {} : { wrapShortcutRunner: wrapShortcutRunner as never }),
  });

  const handlers = core.handlers();
  const call = async (method: HostMethod, params?: unknown): Promise<unknown> => {
    const handler = handlers[method];
    if (!handler) throw new Error(`no handler for ${method}`);
    return handler(params, {} as never);
  };

  return { core, call, runtime, session, manager, emitted };
}

/** Every test starts from a created session, the way the app does. */
async function started(overrides: Record<string, unknown> = {}) {
  const context = harness(overrides);
  await context.call("session.create", { cwd: "/work/app" });
  return context;
}

describe("stats.get", () => {
  it("reports context usage, token totals and queue modes", async () => {
    const { call } = await started();
    const stats = (await call("stats.get")) as Record<string, unknown>;
    expect(stats.contextUsage).toEqual({
      tokens: 1200,
      contextWindow: 200_000,
      percent: 60,
    });
    expect(stats.tokens).toMatchObject({
      input: 100,
      output: 20,
      cacheRead: 5,
      total: 126,
      cost: 0.03,
    });
    expect(stats.steeringMode).toBe("one-at-a-time");
    expect(stats.followUpMode).toBe("all");
    expect(stats.autoRetry).toBe(true);
    expect(stats.stats).toMatchObject({ cost: 0.03 });
  });

  it("survives a session that cannot report usage", async () => {
    const { call } = await started({
      getContextUsage: undefined,
      getSessionStats: undefined,
    });
    const stats = (await call("stats.get")) as Record<string, unknown>;
    expect(stats.contextUsage).toBeNull();
    expect(stats.tokens).toBeNull();
  });
});

describe("entries.get / tree.get", () => {
  it("returns entries with the leaf id", async () => {
    const { call } = await started();
    const result = (await call("entries.get")) as { entries: unknown[]; leafId: string };
    expect(result.entries).toHaveLength(4);
    expect(result.leafId).toBe("e4");
  });

  it("honours the `since` cursor and rejects an unknown one", async () => {
    const { call } = await started();
    const result = (await call("entries.get", { since: "e2" })) as {
      entries: Array<{ id: string }>;
    };
    expect(result.entries.map((entry) => entry.id)).toEqual(["e3", "e4"]);
    await expect(call("entries.get", { since: "nope" })).rejects.toThrow(/no session entry/i);
  });

  it("returns the session tree", async () => {
    const { call } = await started();
    const result = (await call("tree.get")) as { tree: unknown[]; leafId: string };
    expect(result.tree).toHaveLength(1);
    expect(result.leafId).toBe("e4");
  });
});

describe("commands.list", () => {
  it("merges extension commands, prompt templates and skills like Pi's RPC", async () => {
    const { call } = await started();
    const { commands } = (await call("commands.list")) as {
      commands: Array<{ name: string; source: string; argumentHint?: string }>;
    };
    expect(commands.map((command) => [command.name, command.source])).toEqual([
      ["plan", "extension"],
      ["review", "prompt"],
      ["skill:brave-search", "skill"],
    ]);
    expect(commands[1]?.argumentHint).toBe("<file>");
  });
});

describe("shortcuts.list", () => {
  it("resolves shortcuts against Pi's effective keybindings, not the raw user document", async () => {
    // Parity with terminal Pi (2026-10-20 startup-tab-cycle plan): a user
    // override replaces the default entirely, and every other id keeps its
    // documented default. Here the user unbinds `tui.input.tab`, so the
    // runner must see `[]` for it and Pi's default for everything else.
    const seen: unknown[] = [];
    const context = await started({
      keybindingPort: {
        path: () => "/profile/keybindings.json",
        read: () => JSON.stringify({ "tui.input.tab": [] }),
        write: async () => undefined,
        remove: async () => undefined,
      },
      wrapShortcutRunner: (runner: unknown) => {
        const inner = runner as {
          getShortcuts: (resolved: unknown) => Map<string, unknown>;
          getShortcutDiagnostics: () => [];
          createContext: () => object;
          invokeShortcut: (key: string, ctx: object) => Promise<unknown>;
        };
        return {
          getShortcuts: (resolved: unknown) => {
            seen.push(resolved);
            return inner.getShortcuts(resolved);
          },
          getShortcutDiagnostics: () => inner.getShortcutDiagnostics(),
          createContext: () => inner.createContext(),
          invokeShortcut: (key: string, ctx: object) => inner.invokeShortcut(key, ctx),
        };
      },
      extensionRunner: {
        getShortcuts: () => new Map(),
        getShortcutDiagnostics: () => [],
        createContext: () => ({}),
        invokeShortcut: async () => undefined,
      },
    });
    await context.call("shortcuts.list");
    const resolved = seen[0] as Record<string, string[]>;
    expect(resolved["tui.input.tab"]).toEqual([]);
    expect(resolved["tui.input.submit"]).toEqual(["enter"]);
  });
});

describe("model & thinking", () => {
  it("cycles the model in both directions", async () => {
    const { call, session } = await started();
    await call("model.cycle");
    await call("model.cycle", { direction: "backward", persist: true });
    expect(session.cycleModel).toHaveBeenNthCalledWith(1, "forward", { persist: false });
    expect(session.cycleModel).toHaveBeenNthCalledWith(2, "backward", { persist: true });
  });

  it("lists the session's scoped models and current model", async () => {
    const scoped = [{ model: { id: "a" } }, { model: { id: "b" } }];
    const { call } = await started({ scopedModels: scoped });
    const result = (await call("model.list")) as { scoped: unknown[]; current: unknown };
    expect(result.scoped).toHaveLength(2);
    expect(result.current).toMatchObject({ id: "test-model" });
  });

  it("cycles the thinking level and reloads the snapshot", async () => {
    const { call, session } = await started();
    await call("thinking.cycle", { persist: true });
    expect(session.cycleThinkingLevel).toHaveBeenCalledWith({ persist: true });
  });

  it("lists available models from the scoped set", async () => {
    const { call } = await started({ scopedModels: [{ model: { id: "a" } }] });
    const result = (await call("model.available")) as { models: unknown[]; current: unknown };
    expect(result.models).toHaveLength(1);
    expect(result.current).toMatchObject({ id: "test-model" });
  });

  it("reports the runtime catalog with per-provider auth for the picker", async () => {
    const { call } = await started({
      modelRuntime: {
        getAvailableSnapshot: () => [
          { id: "claude-sonnet-4-5", provider: "anthropic" },
          { id: "gpt-5", provider: "openai" },
        ],
        getProviderAuthStatus: (provider: string) =>
          provider === "anthropic" ? { configured: true, source: "stored" } : { configured: false },
      },
    });

    const result = (await call("model.available")) as {
      models: Array<{ id: string }>;
      auth: Record<string, { configured: boolean; source?: string }>;
      thinkingLevels: string[];
    };
    expect(result.models.map((model) => model.id)).toEqual(["claude-sonnet-4-5", "gpt-5"]);
    expect(result.auth["anthropic"]).toMatchObject({ configured: true, source: "stored" });
    // The unconfigured provider is reported as such, which is what "Sign in" reads.
    expect(result.auth["openai"]?.configured).toBe(false);
    expect(Array.isArray(result.thinkingLevels)).toBe(true);
  });

  it("prefers the runtime catalog and falls back to the scoped set", async () => {
    const { call } = await started({
      scopedModels: [{ model: { id: "only-scoped" } }],
      modelRuntime: { getAvailableSnapshot: () => [] },
    });
    const result = (await call("model.available")) as {
      models: Array<{ model?: { id?: string } }>;
      auth: Record<string, unknown>;
    };
    expect(result.models).toHaveLength(1);
    expect(result.auth).toEqual({});
  });
});

describe("session lifecycle", () => {
  it("starts a new session and reports it", async () => {
    const { call, runtime } = await started();
    const result = (await call("session.new")) as { cancelled: boolean; sessionId: string };
    expect(runtime.newSession).toHaveBeenCalledTimes(1);
    expect(result.cancelled).toBe(false);
    expect(result.sessionId).toBe("s1");
  });

  it("switches to a session file and rejects a missing one", async () => {
    const { call, runtime } = await started();
    await call("session.switch", { sessionFile: "/profile/s2.jsonl" });
    expect(runtime.switchSession).toHaveBeenCalledWith("/profile/s2.jsonl");
    await expect(call("session.switch", {})).rejects.toThrow(/sessionFile/);
  });

  it("clones the active branch", async () => {
    const { call, runtime } = await started();
    await call("session.clone");
    expect(runtime.clone).toHaveBeenCalledTimes(1);
  });

  it("lists fork candidates with their entry ids", async () => {
    const { call } = await started();
    const { messages } = (await call("session.forkMessages")) as {
      messages: Array<{ entryId: string; text: string }>;
    };
    expect(messages).toEqual([
      { entryId: "e1", text: "first" },
      { entryId: "e3", text: "second" },
    ]);
  });

  it("returns the last assistant text", async () => {
    const { call } = await started();
    const result = (await call("session.lastAssistantText")) as { text: string };
    expect(result.text).toBe("the last answer");
  });
});

describe("session tree, labels and export", () => {
  it("navigates to an entry and reports the editor text", async () => {
    const { call, session } = await started();
    const result = (await call("session.navigateTree", {
      targetId: "e1",
      summarize: true,
      label: "kept branch",
    })) as { cancelled: boolean; editorText: string | null };
    expect(session.navigateTree).toHaveBeenCalledWith("e1", {
      summarize: true,
      label: "kept branch",
    });
    expect(result.cancelled).toBe(false);
    expect(result.editorText).toBe("resumed text");
  });

  it("requires a target entry id", async () => {
    const { call } = await started();
    await expect(call("session.navigateTree", {})).rejects.toThrow(/targetId/);
  });

  it("sets and clears an entry label", async () => {
    const { call, manager } = await started();
    await expect(
      call("session.setLabel", { targetId: "e1", label: "  bookmark  " }),
    ).resolves.toEqual({ targetId: "e1", label: "bookmark" });
    await expect(call("session.setLabel", { targetId: "e1", label: null })).resolves.toEqual({
      targetId: "e1",
      label: null,
    });
    expect(manager.labels).toEqual([
      { targetId: "e1", label: "bookmark" },
      { targetId: "e1", label: undefined },
    ]);
  });

  it("exports to the path the session reports", async () => {
    const { call, session } = await started();
    const result = (await call("session.exportHtml", {
      outputPath: "/tmp/session.html",
    })) as { path: string };
    expect(session.exportToHtml).toHaveBeenCalledWith("/tmp/session.html");
    expect(result.path).toBe("/tmp/session.html");
  });

  it("uses the SDK's default export path when none is given", async () => {
    const { call, session } = await started();
    const result = (await call("session.exportHtml")) as { path: string };
    expect(session.exportToHtml).toHaveBeenCalledWith(undefined);
    expect(result.path).toBe("/profile/sessions/s1.html");
  });
});

describe("queue modes and retry", () => {
  it("sets the steering and follow-up modes", async () => {
    const { call, session } = await started();
    await call("session.queueMode", { mode: "all" });
    await call("session.queueMode", { mode: "one-at-a-time", kind: "followUp" });
    expect(session.setSteeringMode).toHaveBeenCalledWith("all");
    expect(session.setFollowUpMode).toHaveBeenCalledWith("one-at-a-time");
  });

  it("rejects an unknown mode", async () => {
    const { call } = await started();
    await expect(call("session.queueMode", { mode: "sometimes" })).rejects.toThrow(/mode must be/i);
  });

  it("toggles auto-compaction and auto-retry, and aborts a retry", async () => {
    const { call, session } = await started();
    await call("session.autoCompaction", { enabled: false });
    await call("session.autoRetry", { enabled: false });
    await call("session.abortRetry");
    expect(session.setAutoCompactionEnabled).toHaveBeenCalledWith(false);
    expect(session.setAutoRetryEnabled).toHaveBeenCalledWith(false);
    expect(session.abortRetry).toHaveBeenCalledTimes(1);
    await expect(call("session.autoRetry", { enabled: "yes" })).rejects.toThrow(/boolean/);
  });
});

describe("prompt semantics", () => {
  it("passes images and streamingBehavior through", async () => {
    const { call, session } = await started();
    const images = [{ type: "image", data: "abc", mimeType: "image/png" }];
    await call("prompt", { text: "look", images, streamingBehavior: "steer" });
    expect(session.prompt).toHaveBeenCalledWith("look", { images, streamingBehavior: "steer" });
  });

  it("refuses a plain prompt while streaming, exactly like Pi's RPC mode", async () => {
    const { call } = await started({ isStreaming: true });
    await expect(call("prompt", { text: "hi" })).rejects.toThrow(/already streaming/i);
  });

  it("rejects an unknown streamingBehavior", async () => {
    const { call } = await started();
    await expect(call("prompt", { text: "hi", streamingBehavior: "later" })).rejects.toThrow(
      /streamingBehavior must be/i,
    );
  });
});

describe("settings", () => {
  it("returns both scopes and flushes", async () => {
    const { call } = await started();
    const result = (await call("settings.get")) as {
      settings: { global: unknown; project: unknown };
    };
    expect(result.settings.global).toMatchObject({ theme: "dark" });
    expect(result.settings.project).toMatchObject({ defaultTools: ["read"] });
    await expect(call("settings.flush")).resolves.toMatchObject({ flushed: true });
  });

  it("says plainly when the host has no settings port", async () => {
    const { call } = await started();
    await expect(call("settings.set", { key: "theme", value: "light" })).rejects.toThrow(
      /settings are not available/i,
    );
  });
});

describe("methods that are deliberately unwired", () => {
  it("answers not_implemented with the owning step, never an empty object", async () => {
    const { call } = await started();
    const cases: Array<[HostMethod, RegExp]> = [
      ["bash.run", /step 6/],
      ["bash.abort", /step 6/],
    ];
    for (const [method, expected] of cases) {
      await expect(call(method), method).rejects.toThrow(expected);
    }
  });
});
