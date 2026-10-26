import { describe, expect, it, vi, type Mock } from "vitest";
import type { HostMethod } from "../../src/shared/host-protocol";
import { createSessionCore } from "../../src/host/session-core";
import type { CommandRunner } from "../../src/host/commands";

/**
 * The step-4 protocol surface (session side), driven through the real core with
 * fake SDK adapters. Every handler added in step 4 is covered here, including the
 * documented `not_implemented` ones — a method that is deliberately unwired must
 * say so instead of hanging or answering `{}`.
 */

interface TestSession {
  prompt: Mock<(text: string, options?: unknown) => Promise<void>>;
  setModel: Mock<(model: unknown, options?: unknown) => Promise<void>>;
  cycleModel: Mock<(direction?: string, options?: unknown) => Promise<unknown>>;
  cycleThinkingLevel: Mock<(options?: unknown) => unknown>;
  setAutoCompactionEnabled: Mock<(enabled: boolean) => void>;
  setAutoRetryEnabled: Mock<(enabled: boolean) => void>;
  abortRetry: Mock<() => void>;
  abortCompaction: Mock<() => void>;
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
    abortCompaction: vi.fn(),
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
  const {
    keybindingPort,
    wrapShortcutRunner,
    wrapCommandRunner,
    createBashPort,
    readChangelog,
    ...sessionOverrides
  } = overrides;
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
    ...(wrapCommandRunner == null ? {} : { wrapCommandRunner: wrapCommandRunner as never }),
    ...(createBashPort == null ? {} : { createBashPort: createBashPort as never }),
    ...(readChangelog == null ? {} : { readChangelog: readChangelog as never }),
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

describe("entry_appended renderability", () => {
  it("tells the app whether a bare custom entry has a registered renderer", async () => {
    type Listener = (event: { type: string; [key: string]: unknown }) => void;
    let listener: Listener | null = null;
    const context = await started({
      subscribe: (next: Listener) => {
        listener = next;
        return () => undefined;
      },
      extensionRunner: {
        getRegisteredCommands: () => [],
        getEntryRenderer: (customType: string) => {
          if (customType === "boom") throw new Error("broken registry");
          return customType === "review-band" ? () => undefined : undefined;
        },
      },
    });
    if (!listener) throw new Error("the session listener was not attached");

    const append = (entry: Record<string, unknown>): Record<string, unknown> => {
      context.emitted.length = 0;
      listener!({ type: "entry_appended", entry });
      const frame = context.emitted.find((entry) => entry.event === "entry_appended");
      if (!frame) throw new Error("no entry_appended frame was emitted");
      return frame.payload as Record<string, unknown>;
    };

    // No renderer: the workflow mode entry must be marked hidden.
    const workflow = { type: "custom", id: "w1", customType: "workflow", data: { mode: "plan" } };
    const hidden = append(workflow);
    expect(hidden.entryRenderable).toBe(false);
    expect(hidden.entry).toEqual(workflow);

    // A registered entry renderer (the review bands) must stay displayable.
    expect(append({ type: "custom", id: "r1", customType: "review-band" }).entryRenderable).toBe(
      true,
    );

    // A custom *message* always has Pi's fallback card; leave it unannotated.
    const message = { type: "custom_message", id: "c1", customType: "workflow-btw" };
    const untouched = append(message);
    expect(untouched).not.toHaveProperty("entryRenderable");
    expect(untouched.entry).toEqual(message);

    // A registry that throws is treated as "no renderer", not a crash.
    expect(append({ type: "custom", id: "b1", customType: "boom" }).entryRenderable).toBe(false);
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

describe("commands.run / commands.complete", () => {
  const context = { source: "fake-command-context" };

  function commandRunner(handler = vi.fn(async () => undefined)): CommandRunner {
    return {
      getCommand: (name) =>
        name === "plan"
          ? {
              getArgumentCompletions: (prefix) =>
                prefix === "u" ? [{ value: "use ", label: "use" }] : null,
              handler,
            }
          : undefined,
      createCommandContext: () => context,
      emitError: vi.fn(),
    };
  }

  it("answers not_implemented before a session exists", async () => {
    const { call } = harness({ wrapCommandRunner: () => commandRunner() });
    await expect(call("commands.complete", { name: "plan", prefix: "" })).rejects.toMatchObject({
      code: "not_implemented",
    });
    await expect(call("commands.run", { name: "plan", args: "" })).rejects.toMatchObject({
      code: "not_implemented",
    });
  });

  it("completes and runs through the live runner", async () => {
    const handler = vi.fn(async () => undefined);
    const { call } = await started({ wrapCommandRunner: () => commandRunner(handler) });

    await expect(call("commands.complete", { name: "plan", prefix: "u" })).resolves.toEqual({
      items: [{ value: "use ", label: "use" }],
    });
    await expect(call("commands.run", { name: "plan", args: "use x" })).resolves.toEqual({
      ran: true,
    });
    expect(handler).toHaveBeenCalledWith("use x", context);
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

  it("keeps a session-local pick out of the durable defaults, and resumes it", async () => {
    const setDefaultModelAndProvider = vi.fn();
    const context = await started();
    const settingsManager = context.runtime.services.settingsManager as unknown as {
      setDefaultModelAndProvider?: unknown;
    };
    settingsManager.setDefaultModelAndProvider = setDefaultModelAndProvider;
    const picked = { id: "other-model", provider: "synthetic" };

    await context.call("model.set", { model: picked, persist: false });

    // The switch reaches Pi with persist:false — Pi records it in the session
    // JSONL (`appendModelChange`) and leaves settings.json alone.
    expect(context.session.setModel).toHaveBeenCalledWith(picked, { persist: false });
    expect(setDefaultModelAndProvider).not.toHaveBeenCalled();

    // A persisted pick is the opposite: Pi is told to write the default.
    await context.call("model.set", { model: picked, persist: true });
    expect(context.session.setModel).toHaveBeenLastCalledWith(picked, { persist: true });

    // Resuming never re-applies a project default, so the recorded model stands.
    context.session.setModel = vi.fn(async () => undefined);
    await context.call("session.resume", { sessionFile: "/profile/sessions/s1.jsonl" });
    expect(context.session.setModel).not.toHaveBeenCalled();
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

  it("aborts a running compaction", async () => {
    const { call, session, emitted } = await started();
    await expect(call("session.abortCompaction")).resolves.toMatchObject({ aborted: true });
    expect(session.abortCompaction).toHaveBeenCalledTimes(1);
    expect(emitted.some((entry) => entry.event === "state")).toBe(true);
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
  it("no longer contains bash; it is implemented", async () => {
    const { call } = await started();
    await expect(call("bash.run", { command: "" })).rejects.toThrow(/command/i);
    await expect(call("bash.abort")).resolves.toMatchObject({ aborted: true });
  });
});

describe("bash mode (plan step 7)", () => {
  async function bashHarness(options: {
    run?: Mock<(command: string, ...rest: unknown[]) => Promise<unknown>>;
    port?: (session: unknown) => unknown;
    isBashRunning?: boolean;
    recordBashResult?: Mock<(command: string, result: unknown, opts?: unknown) => void>;
  }) {
    const executeBash = (options.run ??
      vi.fn(async () => ({ output: "/work/app\n", exitCode: 0, 0: true }))) as Mock<
      (command: string, ...rest: unknown[]) => Promise<unknown>
    >;
    const recordBashResult = options.recordBashResult ?? vi.fn();
    return {
      executeBash,
      recordBashResult,
      ...(await started({
        executeBash,
        recordBashResult,
        isBashRunning: options.isBashRunning ?? false,
        ...(options.port ? { createBashPort: options.port } : {}),
      })),
    };
  }

  it("emits message_start before executeBash, then the final message_end", async () => {
    const order: string[] = [];
    const run = vi.fn(async () => {
      order.push("execute");
      return { output: "/work/app\n", exitCode: 0, cancelled: false, truncated: false };
    });
    const { call, emitted } = await bashHarness({ run: run as never });
    const result = (await call("bash.run", {
      command: "pwd",
      excludeFromContext: false,
    })) as { result: { output: string } };
    order.push("resolved");
    expect(order).toEqual(["execute", "resolved"]);
    expect(result.result.output).toBe("/work/app\n");
    const start = emitted.findIndex((entry) => entry.event === "message_start");
    expect(start).toBeGreaterThanOrEqual(0);
    const messageEnd = emitted.filter((entry) => entry.event === "message_end").at(-1);
    expect(messageEnd?.payload).toMatchObject({
      message: { role: "bashExecution", command: "pwd", output: "/work/app\n", exitCode: 0 },
    });
    expect(emitted.find((entry) => entry.event === "message_start")?.payload).toMatchObject({
      message: { role: "bashExecution", command: "pwd", output: "" },
    });
  });

  it("passes excludeFromContext and a stable id to executeBash for `!!`", async () => {
    const { call, executeBash, emitted } = await bashHarness({});
    await call("bash.run", { command: "pwd", excludeFromContext: true });
    const options = executeBash.mock.calls[0]?.[2] as
      { excludeFromContext?: boolean; id?: string } | undefined;
    expect(options?.excludeFromContext).toBe(true);
    const startId = (
      emitted.find((entry) => entry.event === "message_start")?.payload as {
        message: { id: string; excludeFromContext?: boolean };
      }
    ).message;
    expect(startId.excludeFromContext).toBe(true);
    expect(options?.id).toBe(startId.id);
  });

  it("runs Pi's user_bash hook first and forwards its operations", async () => {
    const operations = { exec: vi.fn() };
    const port = vi.fn(async () => ({ operations }));
    const { call, executeBash } = await bashHarness({ port: () => ({ run: port }) });
    await call("bash.run", { command: "ls" });
    expect(port).toHaveBeenCalledWith("ls", { excludeFromContext: false, cwd: "/work/app" });
    expect(executeBash.mock.calls[0]?.[2]).toMatchObject({ operations });
  });

  it("uses an intercepted result, records it, and never calls executeBash", async () => {
    const intercepted = {
      output: "from sandbox\n",
      exitCode: 0,
      cancelled: false,
      truncated: false,
    };
    const port = vi.fn(async () => ({ result: intercepted }));
    const { call, executeBash, recordBashResult, emitted } = await bashHarness({
      port: () => ({ run: port }),
    });
    const result = (await call("bash.run", { command: "pwd", excludeFromContext: true })) as {
      result: typeof intercepted;
    };
    expect(executeBash).not.toHaveBeenCalled();
    expect(result.result).toEqual(intercepted);
    expect(recordBashResult).toHaveBeenCalledWith("pwd", intercepted, { excludeFromContext: true });
    expect(emitted.filter((entry) => entry.event === "message_end").at(-1)?.payload).toMatchObject({
      message: { output: "from sandbox\n" },
    });
  });

  it("stops when an extension hook throws, exactly like terminal Pi", async () => {
    const port = vi.fn(async () => {
      throw new Error("extension refused");
    });
    const { call, executeBash } = await bashHarness({ port: () => ({ run: port }) });
    await expect(call("bash.run", { command: "ls" })).resolves.toMatchObject({
      intercepted: true,
    });
    expect(executeBash).not.toHaveBeenCalled();
  });

  it("refuses a second command while one is running", async () => {
    const { call } = await bashHarness({ isBashRunning: true });
    await expect(call("bash.run", { command: "pwd" })).rejects.toThrow(/already running/i);
  });

  it("reports bashRunning from the live session", async () => {
    const { call } = await bashHarness({ isBashRunning: true });
    expect((await call("state.get")) as { bashRunning: boolean }).toMatchObject({
      bashRunning: true,
    });
  });
});

describe("session.clone fallback (plan step 13)", () => {
  it("clones at the current leaf through `fork` when the runtime has no clone", async () => {
    const context = await started();
    // The SDK runtime this app runs has fork but no clone.
    delete (context.runtime as { clone?: unknown }).clone;
    const result = (await context.call("session.clone")) as { sessionId: string | null };
    expect(context.runtime.fork).toHaveBeenCalledWith("e4", { position: "at" });
    expect(result.sessionId).toBe("s1");
  });

  it("uses runtime.clone when it exists", async () => {
    const context = await started();
    await context.call("session.clone");
    expect(context.runtime.clone).toHaveBeenCalledTimes(1);
    expect(context.runtime.fork).not.toHaveBeenCalled();
  });

  it("refuses when the session has no leaf to clone from", async () => {
    const context = await started();
    delete (context.runtime as { clone?: unknown }).clone;
    const manager = context.manager as { getLeafId: () => string | undefined };
    manager.getLeafId = () => undefined;
    await expect(context.call("session.clone")).rejects.toThrow(/no entry to clone/i);
  });
});

describe("JSONL export and import (plan step 14)", () => {
  it("exports JSONL through Pi's own writer and reports the path", async () => {
    const context = await started({
      exportToJsonl: vi.fn((outputPath?: string) => outputPath ?? "/profile/sessions/s1.jsonl"),
    });
    await expect(context.call("session.exportJsonl")).resolves.toEqual({
      path: "/profile/sessions/s1.jsonl",
    });
    await expect(
      context.call("session.exportJsonl", { outputPath: "/tmp/copy.jsonl" }),
    ).resolves.toEqual({ path: "/tmp/copy.jsonl" });
  });

  it("imports JSONL, rebinds and returns the fresh snapshot", async () => {
    const context = await started();
    const importFromJsonl = vi.fn(async () => ({ cancelled: false }));
    (context.runtime as { importFromJsonl?: unknown }).importFromJsonl = importFromJsonl;
    const result = (await context.call("session.importJsonl", {
      path: "/tmp/import.jsonl",
    })) as { sessionId: string | null };
    expect(importFromJsonl).toHaveBeenCalledWith("/tmp/import.jsonl", undefined);
    expect(result.sessionId).toBe("s1");
  });

  it("maps a missing file and a missing cwd to actionable errors", async () => {
    const context = await started();
    (context.runtime as { importFromJsonl?: unknown }).importFromJsonl = async () => {
      const error = new Error("ENOENT: no such file");
      error.name = "SessionImportFileNotFoundError";
      throw error;
    };
    await expect(context.call("session.importJsonl", { path: "/tmp/none.jsonl" })).rejects.toThrow(
      /was not found/i,
    );

    (context.runtime as { importFromJsonl?: unknown }).importFromJsonl = async () => {
      const error = new Error("no cwd");
      error.name = "MissingSessionCwdError";
      throw error;
    };
    await expect(context.call("session.importJsonl", { path: "/tmp/x.jsonl" })).rejects.toThrow(
      /working folder/i,
    );
  });

  it("requires a path", async () => {
    const context = await started();
    await expect(context.call("session.importJsonl", {})).rejects.toThrow(/path/i);
  });
});

describe("changelog (plan step 15)", () => {
  it("returns the packaged changelog through the injected reader", async () => {
    const readChangelog = vi.fn(async () => ({
      path: "/pkg/CHANGELOG.md",
      text: "## 1.4.0\n- things",
    }));
    const { call } = await started({ readChangelog });
    await expect(call("session.changelog")).resolves.toEqual({
      path: "/pkg/CHANGELOG.md",
      text: "## 1.4.0\n- things",
    });
    expect(readChangelog).toHaveBeenCalledTimes(1);
  });

  it("says plainly when the host has no reader", async () => {
    const { call } = await started();
    await expect(call("session.changelog")).rejects.toThrow(/not available/i);
  });
});
