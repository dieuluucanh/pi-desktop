import { describe, expect, it, vi } from "vitest";
import type { HostMethod } from "../../src/shared/host-protocol";
import {
  createSessionCore,
  type ModelScopePort,
  type ModelScopeToggleInput,
  type SessionCoreDeps,
} from "../../src/host/session-core";
import { createFakeSettings } from "./fake-settings";
import { SettingsError } from "../../src/host/settings";

/**
 * The live model-scope methods (`model.scope.apply` / `model.scope.toggle`).
 *
 * The SDK adapter is faked here; its own tests pin the pattern rewrite. These
 * tests pin the host contract: the effective `enabledModels` is read from the
 * session's settings, the right document is written, the live session is only
 * touched after a successful write, and both methods report the resulting scope.
 */

interface ScopeSession {
  sessionId: string;
  sessionFile: string | null;
  model: { provider: string; id: string };
  thinkingLevel: string;
  isStreaming: boolean;
  isIdle: boolean;
  messages: unknown[];
  scopedModels: unknown[];
  modelRuntime: { getAvailableSnapshot: () => unknown[] };
  setScopedModels: ReturnType<typeof vi.fn>;
  subscribe: () => () => void;
}

const AVAILABLE = [
  { provider: "fake", id: "fake-1" },
  { provider: "fake", id: "fake-2" },
];

function fakeSession(overrides: Record<string, unknown> = {}): ScopeSession {
  const session = {
    sessionId: "s1",
    sessionFile: null,
    model: { provider: "fake", id: "fake-1" },
    thinkingLevel: "medium",
    isStreaming: false,
    isIdle: true,
    messages: [],
    scopedModels: [] as unknown[],
    modelRuntime: { getAvailableSnapshot: () => AVAILABLE },
    subscribe: () => () => undefined,
    ...overrides,
  } as unknown as ScopeSession;
  if (!Object.prototype.hasOwnProperty.call(overrides, "setScopedModels")) {
    session.setScopedModels = vi.fn((next: readonly unknown[]) => {
      session.scopedModels = [...next];
    });
  }
  return session;
}

function fakeModelScope(result?: {
  patterns?: string[] | undefined;
  scopedModels?: unknown[];
  diagnostics?: Array<{ type: "warning"; message: string }>;
}) {
  const toggle = vi.fn(async (_input: ModelScopeToggleInput) => ({
    patterns: result && "patterns" in result ? result.patterns : ["fake/fake-2"],
    scopedModels: result?.scopedModels ?? [{ model: { provider: "fake", id: "fake-2" } }],
    diagnostics: result?.diagnostics ?? [],
  }));
  const resolve = vi.fn(async () => ({
    scopedModels: result?.scopedModels ?? [{ model: { provider: "fake", id: "fake-2" } }],
    diagnostics: result?.diagnostics ?? [],
  }));
  return { toggle, resolve } as unknown as ModelScopePort & {
    toggle: typeof toggle;
    resolve: typeof resolve;
  };
}

function harness(
  options: {
    session?: Record<string, unknown>;
    global?: Record<string, unknown>;
    project?: Record<string, unknown>;
    modelScope?: ModelScopePort;
    settings?: ReturnType<typeof createFakeSettings>;
    noSettingsPort?: boolean;
    noScopePort?: boolean;
    bindSession?: SessionCoreDeps["bindSession"];
  } = {},
) {
  const session = fakeSession(options.session);
  const settings =
    options.settings ??
    createFakeSettings({
      global: options.global ?? { enabledModels: ["fake/fake-2"] },
      project: options.project ?? {},
    });
  const scopes = settings.scopes;
  const settingsManager = {
    getGlobalSettings: () => scopes.global,
    getProjectSettings: () => scopes.project,
    getEnabledModels: () =>
      Array.isArray(scopes.project.enabledModels)
        ? (scopes.project.enabledModels as string[])
        : Array.isArray(scopes.global.enabledModels)
          ? (scopes.global.enabledModels as string[])
          : undefined,
    flush: vi.fn(async () => undefined),
    drainErrors: () => [],
  };
  const emitted: Array<{ event: string; payload?: unknown }> = [];
  const portCalls: Array<{ manager: unknown; cwd: string }> = [];
  const runtime = {
    get session() {
      return session;
    },
    services: { settingsManager, cwd: "/work/app" },
  };
  const core = createSessionCore({
    cwd: "/work/app",
    agentDir: "/profile",
    emit: (event, payload) =>
      emitted.push({ event, ...(payload === undefined ? {} : { payload }) }),
    createRuntime: async () => ({ runtime, session }) as never,
    newSessionManager: () => ({}) as never,
    openSessionManager: () => ({}) as never,
    ...(options.noSettingsPort
      ? {}
      : {
          createSettingsPort: (manager: unknown, sessionCwd: string) => {
            portCalls.push({ manager, cwd: sessionCwd });
            return settings;
          },
        }),
    ...(options.noScopePort || !options.modelScope ? {} : { modelScope: options.modelScope }),
    ...(options.bindSession ? { bindSession: options.bindSession } : {}),
  });
  const handlers = core.handlers();
  const call = async (method: HostMethod, params?: unknown): Promise<unknown> => {
    const handler = handlers[method];
    if (!handler) throw new Error(`no handler for ${method}`);
    return handler(params, {} as never);
  };
  return { core, call, session, settings, emitted, settingsManager, portCalls };
}

async function started(options: Parameters<typeof harness>[0] = {}) {
  const context = harness(options);
  await context.call("session.create", { cwd: "/work/app" });
  return context;
}

describe("model.scope.apply", () => {
  it("reconciles after bindSession, so an extension's new model is scoped", async () => {
    let resolved = [{ model: { provider: "fake", id: "fake-1" } }];
    const modelScope: ModelScopePort = {
      resolve: vi.fn(async () => ({ scopedModels: resolved, diagnostics: [] })),
      toggle: vi.fn(async () => ({ patterns: [], scopedModels: [], diagnostics: [] })),
    };
    const bindSession = vi.fn(async () => {
      resolved = [{ model: { provider: "fake", id: "fake-2" } }];
    });
    const context = harness({
      modelScope,
      bindSession,
      global: { enabledModels: ["fake/fake-2"] },
    });

    await context.call("session.create", { cwd: "/work/app" });

    expect(bindSession).toHaveBeenCalledTimes(1);
    expect(context.session.setScopedModels).toHaveBeenLastCalledWith([
      { model: { provider: "fake", id: "fake-2" } },
    ]);
    expect(context.emitted.map((entry) => entry.event)).toContain("model_scope_changed");
  });

  it("reloads settings and reports the persisted scope on model.available", async () => {
    const modelScope = fakeModelScope();
    const context = await started({
      modelScope,
      global: { enabledModels: ["fake/fake-1"] },
    });

    context.settings.scopes.global.enabledModels = ["fake/fake-2"];
    const result = (await context.call("model.available")) as {
      enabledModels?: string[];
      source?: string;
      scoped?: unknown[];
      diagnostics?: unknown[];
    };

    expect(result.enabledModels).toEqual(["fake/fake-2"]);
    expect(result.source).toBe("global");
    expect(modelScope.resolve).toHaveBeenLastCalledWith(
      ["fake/fake-2"],
      context.session.modelRuntime,
    );
    expect(result.diagnostics).toEqual([]);
  });
  it("binds the settings port to the session cwd and reuses it", async () => {
    const modelScope = fakeModelScope();
    const context = await started({ modelScope });

    await context.call("model.scope.apply");
    await context.call("model.scope.apply");

    expect(context.portCalls).toEqual([{ manager: context.settingsManager, cwd: "/work/app" }]);
  });

  it("recreates the settings port when the session moves to another cwd", async () => {
    const modelScope = fakeModelScope();
    const context = await started({ modelScope });
    await context.call("model.scope.apply");

    await context.call("session.open", {
      sessionFile: "/profile/sessions/other.jsonl",
      cwd: "/work/other",
    });
    await context.call("model.scope.apply");

    expect(context.portCalls.map((entry) => entry.cwd)).toEqual(["/work/app", "/work/other"]);
  });
  it("reloads settings and applies the resolved scope to the live session", async () => {
    const modelScope = fakeModelScope();
    const context = await started({
      modelScope,
      global: { enabledModels: ["fake/fake-2"] },
    });
    context.emitted.length = 0;

    const result = (await context.call("model.scope.apply")) as Record<string, unknown>;

    expect(context.settings.reload).toHaveBeenCalledWith("/work/app");
    expect(modelScope.resolve).toHaveBeenCalledWith(["fake/fake-2"], context.session.modelRuntime);
    expect(context.session.setScopedModels).toHaveBeenCalledWith([
      { model: { provider: "fake", id: "fake-2" } },
    ]);
    expect(result).toEqual({
      enabledModels: ["fake/fake-2"],
      scoped: [{ model: { provider: "fake", id: "fake-2" } }],
      source: "global",
      diagnostics: [],
    });
    expect(context.emitted.map((entry) => entry.event)).toContain("state");
  });

  it("prefers a project list over the global one", async () => {
    const modelScope = fakeModelScope();
    const context = await started({
      modelScope,
      global: { enabledModels: ["fake/fake-1"] },
      project: { enabledModels: ["fake/fake-2"] },
    });

    await context.call("model.scope.apply");
    expect(modelScope.resolve).toHaveBeenCalledWith(["fake/fake-2"], context.session.modelRuntime);
  });

  it("falls back to the settings documents when the manager has no getter", async () => {
    const modelScope = fakeModelScope();
    const context = await started({ modelScope, global: { enabledModels: ["fake/fake-2"] } });
    // A narrow SDK/fake manager may not expose `getEnabledModels`.
    delete (context.settingsManager as { getEnabledModels?: unknown }).getEnabledModels;

    await context.call("model.scope.apply");
    expect(modelScope.resolve).toHaveBeenCalledWith(["fake/fake-2"], context.session.modelRuntime);
  });

  it("needs a session", async () => {
    const context = harness({ modelScope: fakeModelScope() });
    await expect(context.call("model.scope.apply")).rejects.toThrow(/no session is open/);
  });

  it("is unsupported without the scope port", async () => {
    const context = await started({ noScopePort: true });
    await expect(context.call("model.scope.apply")).rejects.toThrow(/not supported/);
  });

  it("is unsupported when the session cannot replace its scope", async () => {
    const context = harness({
      modelScope: fakeModelScope(),
      session: { setScopedModels: undefined },
    });
    await context.call("session.create", { cwd: "/work/app" });
    await expect(context.call("model.scope.apply")).rejects.toThrow(/not supported/);
  });
});

describe("model.scope.toggle", () => {
  it("persists the rewrite, then applies the resolved scope", async () => {
    const modelScope = fakeModelScope({
      patterns: ["fake/fake-2"],
      scopedModels: [{ model: { provider: "fake", id: "fake-2" } }],
    });
    const context = await started({
      modelScope,
      global: { enabledModels: ["fake/fake-1", "fake/fake-2"] },
      session: { scopedModels: [{ model: { provider: "fake", id: "fake-1" } }] },
    });
    context.emitted.length = 0;

    const result = (await context.call("model.scope.toggle", {
      provider: "fake",
      id: "fake-1",
      enabled: false,
    })) as Record<string, unknown>;

    expect(modelScope.toggle).toHaveBeenCalledWith({
      patterns: ["fake/fake-1", "fake/fake-2"],
      runtime: context.session.modelRuntime,
      provider: "fake",
      id: "fake-1",
      enabled: false,
    });
    expect(context.settings.compareAndWrite).toHaveBeenCalledWith(
      "/work/app",
      "enabledModels",
      ["fake/fake-1", "fake/fake-2"],
      ["fake/fake-2"],
      "global",
    );
    expect(context.session.setScopedModels).toHaveBeenCalledWith([
      { model: { provider: "fake", id: "fake-2" } },
    ]);
    expect(result).toEqual({
      enabledModels: ["fake/fake-2"],
      scoped: [{ model: { provider: "fake", id: "fake-2" } }],
      scope: "global",
      diagnostics: [],
    });
    expect(context.emitted.map((entry) => entry.event)).toContain("state");
  });

  it("writes the project document when the project defines the scope", async () => {
    const modelScope = fakeModelScope({ patterns: ["fake/fake-2"] });
    const context = await started({
      modelScope,
      global: { enabledModels: ["fake/fake-1"] },
      project: { enabledModels: ["fake/fake-1", "fake/fake-2"] },
    });

    await context.call("model.scope.toggle", {
      provider: "fake",
      id: "fake-1",
      enabled: false,
    });
    expect(context.settings.compareAndWrite).toHaveBeenCalledWith(
      "/work/app",
      "enabledModels",
      ["fake/fake-1", "fake/fake-2"],
      ["fake/fake-2"],
      "project",
    );
  });

  it("honours an explicit project target even when the project has no scope yet", async () => {
    const modelScope = fakeModelScope({ patterns: ["fake/fake-2"] });
    const context = await started({
      modelScope,
      global: { enabledModels: ["fake/fake-1"] },
      project: {},
    });

    const result = (await context.call("model.scope.toggle", {
      provider: "fake",
      id: "fake-2",
      enabled: true,
      scope: "project",
    })) as Record<string, unknown>;

    expect(context.settings.compareAndWrite).toHaveBeenCalledWith(
      "/work/app",
      "enabledModels",
      undefined,
      ["fake/fake-2"],
      "project",
    );
    expect(result.scope).toBe("project");
  });

  it("deletes the key (write undefined) when the scope becomes empty", async () => {
    const modelScope = fakeModelScope({ patterns: undefined });
    const context = await started({
      modelScope,
      global: { enabledModels: ["fake/fake-2"] },
    });

    const result = (await context.call("model.scope.toggle", {
      provider: "fake",
      id: "fake-2",
      enabled: false,
    })) as Record<string, unknown>;

    expect(context.settings.compareAndWrite).toHaveBeenCalledWith(
      "/work/app",
      "enabledModels",
      ["fake/fake-2"],
      undefined,
      "global",
    );
    expect(result.enabledModels).toEqual([]);
    expect(context.session.setScopedModels).toHaveBeenCalledWith([]);
  });

  it("does not touch the session when the write is refused", async () => {
    const modelScope = fakeModelScope();
    const context = await started({ modelScope });
    context.session.setScopedModels.mockClear();
    vi.mocked(context.settings.compareAndWrite).mockRejectedValueOnce(new Error("disk full"));

    await expect(
      context.call("model.scope.toggle", { provider: "fake", id: "fake-1", enabled: false }),
    ).rejects.toThrow("disk full");
    expect(context.session.setScopedModels).not.toHaveBeenCalled();
  });

  it("does not write when the adapter cannot resolve", async () => {
    const modelScope = fakeModelScope();
    modelScope.toggle.mockRejectedValueOnce(new Error("catalogue unavailable"));
    const context = await started({ modelScope });
    context.session.setScopedModels.mockClear();

    await expect(
      context.call("model.scope.toggle", { provider: "fake", id: "fake-1", enabled: false }),
    ).rejects.toThrow("catalogue unavailable");
    expect(context.settings.compareAndWrite).not.toHaveBeenCalled();
    expect(context.session.setScopedModels).not.toHaveBeenCalled();
  });

  it("retries once when the compare-and-write conflicts", async () => {
    const modelScope = fakeModelScope({ patterns: ["fake/fake-2"] });
    const context = await started({
      modelScope,
      global: { enabledModels: ["fake/fake-1"] },
    });
    vi.mocked(context.settings.compareAndWrite).mockRejectedValueOnce(
      new SettingsError("settings changed on disk; reload and retry", "conflict"),
    );

    const result = (await context.call("model.scope.toggle", {
      provider: "fake",
      id: "fake-2",
      enabled: true,
    })) as Record<string, unknown>;

    expect(modelScope.toggle).toHaveBeenCalledTimes(2);
    expect(context.settings.compareAndWrite).toHaveBeenCalledTimes(2);
    expect(result.scope).toBe("global");
  });

  it("leaves the live scope untouched after a second conflict", async () => {
    const modelScope = fakeModelScope({ patterns: ["fake/fake-2"] });
    const context = await started({
      modelScope,
      global: { enabledModels: ["fake/fake-1"] },
    });
    context.session.setScopedModels.mockClear();
    vi.mocked(context.settings.compareAndWrite).mockRejectedValue(
      new SettingsError("settings changed on disk; reload and retry", "conflict"),
    );

    await expect(
      context.call("model.scope.toggle", { provider: "fake", id: "fake-2", enabled: true }),
    ).rejects.toThrow(/changed on disk again/i);
    expect(context.session.setScopedModels).not.toHaveBeenCalled();
  });

  it("is unsupported without a settings port", async () => {
    const modelScope = fakeModelScope();
    const context = await started({ modelScope, noSettingsPort: true });
    await expect(
      context.call("model.scope.toggle", { provider: "fake", id: "fake-1", enabled: false }),
    ).rejects.toThrow(/settings are not available/);
  });

  it("rejects a malformed model ref before calling the adapter", async () => {
    const modelScope = fakeModelScope();
    const context = await started({ modelScope });

    await expect(
      context.call("model.scope.toggle", { provider: "fake/x", id: "fake-1", enabled: true }),
    ).rejects.toThrow(/exactly one model/);
    await expect(
      context.call("model.scope.toggle", { provider: "  ", id: "fake-1", enabled: true }),
    ).rejects.toThrow(/exactly one model/);
    await expect(
      context.call("model.scope.toggle", {
        provider: "fake",
        id: "x".repeat(400),
        enabled: true,
      }),
    ).rejects.toThrow(/too long/);
    expect(modelScope.toggle).not.toHaveBeenCalled();
  });

  it("needs a session", async () => {
    const context = harness({ modelScope: fakeModelScope() });
    await expect(
      context.call("model.scope.toggle", { provider: "fake", id: "fake-1", enabled: true }),
    ).rejects.toThrow(/no session is open/);
  });
});

describe("model and thinking persistence target", () => {
  it("writes the model defaults and scope to the project target", async () => {
    const setModel = vi.fn(async () => undefined);
    const context = await started({
      modelScope: fakeModelScope(),
      global: { enabledModels: ["fake/fake-1"] },
      project: {},
      session: { setModel },
    });

    await context.call("model.set", {
      model: { provider: "fake", id: "fake-2" },
      persist: true,
      scope: "project",
    });

    expect(setModel).toHaveBeenCalledWith({ provider: "fake", id: "fake-2" }, { persist: false });
    expect(context.settings.compareAndWrite).toHaveBeenCalledWith(
      "/work/app",
      "enabledModels",
      undefined,
      ["fake/fake-1", "fake/fake-2"],
      "project",
    );
    expect(context.settings.writeMany).toHaveBeenCalledWith("/work/app", "project", {
      defaultProvider: "fake",
      defaultModel: "fake-2",
    });
  });

  it("writes the model defaults to global when the scope is global", async () => {
    const setModel = vi.fn(async () => undefined);
    const context = await started({
      modelScope: fakeModelScope(),
      global: { enabledModels: ["fake/fake-1"] },
      project: {},
      session: { setModel },
    });

    await context.call("model.set", {
      model: { provider: "fake", id: "fake-3" },
      persist: true,
      scope: "global",
    });

    expect(context.settings.writeMany).toHaveBeenCalledWith("/work/app", "global", {
      defaultProvider: "fake",
      defaultModel: "fake-3",
    });
  });

  it("does not duplicate a model already covered by the scope", async () => {
    const setModel = vi.fn(async () => undefined);
    const context = await started({
      modelScope: fakeModelScope(),
      global: { enabledModels: ["fake/fake-2"] },
      session: { setModel },
    });

    await context.call("model.set", {
      model: { provider: "fake", id: "fake-2" },
      persist: true,
      scope: "global",
    });

    expect(context.settings.compareAndWrite).not.toHaveBeenCalled();
    expect(context.settings.writeMany).toHaveBeenCalledWith("/work/app", "global", {
      defaultProvider: "fake",
      defaultModel: "fake-2",
    });
  });

  it("does not persist when the request is session-local", async () => {
    const setModel = vi.fn(async () => undefined);
    const context = await started({
      modelScope: fakeModelScope(),
      global: { enabledModels: ["fake/fake-1"] },
      session: { setModel },
    });

    await context.call("model.set", {
      model: { provider: "fake", id: "fake-2" },
      persist: false,
      scope: "project",
    });

    expect(setModel).toHaveBeenCalledWith({ provider: "fake", id: "fake-2" }, { persist: false });
    expect(context.settings.compareAndWrite).not.toHaveBeenCalled();
    expect(context.settings.writeMany).not.toHaveBeenCalled();
  });

  it("keeps the old no-scope path for an older renderer", async () => {
    const setModel = vi.fn(async () => undefined);
    const context = await started({
      modelScope: fakeModelScope(),
      global: { enabledModels: ["fake/fake-1"] },
      session: { setModel },
    });

    await context.call("model.set", {
      model: { provider: "fake", id: "fake-2" },
      persist: true,
    });

    expect(setModel).toHaveBeenCalledWith({ provider: "fake", id: "fake-2" }, { persist: true });
    expect(context.settings.writeMany).not.toHaveBeenCalled();
  });

  it("writes the thinking default to the selected scope", async () => {
    const setThinkingLevel = vi.fn();
    const context = await started({
      modelScope: fakeModelScope(),
      global: { enabledModels: ["fake/fake-1"] },
      project: {},
      session: { setThinkingLevel },
    });

    await context.call("thinking.set", {
      level: "high",
      persist: true,
      scope: "project",
    });

    expect(setThinkingLevel).toHaveBeenCalledWith("high", { persist: false });
    expect(context.settings.writeMany).toHaveBeenCalledWith("/work/app", "project", {
      defaultThinkingLevel: "high",
    });
  });
});
