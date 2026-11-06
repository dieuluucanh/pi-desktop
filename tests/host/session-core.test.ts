import { describe, expect, it, vi } from "vitest";
import {
  createSessionCore,
  type HostSession,
  type RuntimeLike,
  type SessionCoreDeps,
  type SessionRuntimeRequest,
} from "../../src/host/session-core";
import type { HostMethod } from "../../src/shared/host-protocol";
import type { HostRequestContext } from "../../src/host/service";

/**
 * Session core tests against an injected fake runtime: the trust gate, the
 * protocol handlers, the event → frame bridge and rebinding after a fork.
 */

const CWD = "C:/work";
const AGENT_DIR = "C:/profile";

interface FakeSessionOptions {
  sessionId?: string;
  messages?: unknown[];
}

function fakeSession(options: FakeSessionOptions = {}) {
  const listeners: Array<(event: { type: string; [key: string]: unknown }) => void> = [];
  const prompts: string[] = [];
  const state = {
    sessionId: options.sessionId ?? "session-1",
    sessionFile: `C:/profile/sessions/${options.sessionId ?? "session-1"}.jsonl`,
    sessionName: "Budget work",
    messages: options.messages ?? [],
    streaming: false,
    model: { id: "claude-sonnet-4", provider: "anthropic", name: "Claude Sonnet 4" },
    thinkingLevel: "medium",
  };

  const session: HostSession = {
    get sessionId() {
      return state.sessionId;
    },
    get sessionFile() {
      return state.sessionFile;
    },
    get sessionName() {
      return state.sessionName;
    },
    get model() {
      return state.model;
    },
    get thinkingLevel() {
      return state.thinkingLevel;
    },
    get isStreaming() {
      return state.streaming;
    },
    get isIdle() {
      return !state.streaming;
    },
    get messages() {
      return state.messages;
    },
    get pendingMessageCount() {
      return 0;
    },
    getAvailableThinkingLevels: () => ["off", "low", "medium", "high"],
    getActiveToolNames: () => ["read"],
    getAllTools: () => [{}, {}],
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    async prompt(text) {
      prompts.push(text);
      emit({ type: "agent_start" });
      state.streaming = true;
      emit({ type: "message_update", text: "hello" });
      state.streaming = false;
      state.messages = [
        ...state.messages,
        { role: "user", text },
        { role: "assistant", text: "hi" },
      ];
      emit({ type: "agent_end", messages: state.messages });
    },
    async abort() {
      state.streaming = false;
    },
    clearQueue: () => ({ steering: ["a"], followUp: [] }),
    async setModel(model) {
      state.model = model as typeof state.model;
    },
    setThinkingLevel(level) {
      state.thinkingLevel = level;
    },
    setActiveToolsByName() {},
  };

  const emit = (event: { type: string; [key: string]: unknown }): void => {
    for (const listener of [...listeners]) listener(event);
  };

  return { session, prompts, emit, listeners, state };
}

function fakeRuntime(initial: HostSession, nextSession?: () => HostSession) {
  let current = initial;
  let rebind: (() => Promise<void>) | undefined;
  const forks: string[] = [];

  const runtime: RuntimeLike & { setCurrent(session: HostSession): void; rebind(): Promise<void> } =
    {
      get session() {
        return current;
      },
      get services() {
        return {
          cwd: CWD,
          settingsManager: {
            getGlobalSettings: () => ({ theme: "dark", npmCommand: ["node", "npm-cli.js"] }),
            getProjectSettings: () => ({ defaultTools: ["read"] }),
            drainErrors: () => [{ message: "one warning" }],
          },
        };
      },
      async fork(entryId) {
        forks.push(entryId);
        if (nextSession) current = nextSession();
        await rebind?.();
        return { cancelled: false, selectedText: "from the fork point" };
      },
      setRebindSession(fn) {
        rebind = fn;
      },
      async dispose() {},
      setCurrent(session) {
        current = session;
      },
      rebind: async () => {
        await rebind?.();
      },
    };

  return { runtime, forks };
}

function harness(deps: Partial<SessionCoreDeps> = {}) {
  const primary = fakeSession();
  const forked = fakeSession({ sessionId: "session-forked" });
  const { runtime, forks } = fakeRuntime(primary.session, () => forked.session);
  const emitted: Array<{ event: string; payload: unknown; sessionId?: string }> = [];
  const trustStore = new Map<string, boolean | null>();

  const core = createSessionCore({
    cwd: CWD,
    agentDir: AGENT_DIR,
    createRuntime: async () => ({ runtime, session: runtime.session }),
    newSessionManager: () => ({ id: "new" }),
    openSessionManager: () => ({ id: "opened" }),
    trustStore: {
      get: (cwd) => trustStore.get(cwd) ?? null,
      set: (cwd, decision) => {
        trustStore.set(cwd, decision);
      },
    },
    requiresTrust: () => false,
    emit: (event, payload, sessionId) => {
      emitted.push({ event, payload, sessionId: sessionId ?? "" });
    },
    ...deps,
  });

  const context: HostRequestContext = {
    method: "state.get" as HostMethod,
    requestId: 1,
    emit: () => {},
    readBlob: async () => null,
  };

  const call = async (method: HostMethod, params?: unknown): Promise<unknown> => {
    const handler = core.handlers()[method];
    if (!handler) throw new Error(`no handler for ${method}`);
    return handler(params, { ...context, method });
  };

  const events = (): string[] => emitted.map((entry) => entry.event);

  return { core, call, emitted, events, trustStore, forks, primary, forked, runtime };
}

describe("session core lifecycle", () => {
  it("creates a session and announces it", async () => {
    const { call, events, emitted, core } = harness();

    const snapshot = await call("session.create");

    expect(snapshot).toMatchObject({ sessionId: "session-1", cwd: CWD, toolCount: 2 });
    expect(events()).toContain("session_started");
    expect(events()).toContain("state");
    expect(emitted.find((entry) => entry.event === "session_started")?.sessionId).toBe("session-1");
    expect(core.cwd()).toBe(CWD);
  });

  it("hands the live session and its runtime to bindSession", async () => {
    const bound: Array<{ session: HostSession; runtime: RuntimeLike }> = [];
    const { call, runtime } = harness({
      bindSession: async (session, boundRuntime) => {
        bound.push({ session, runtime: boundRuntime });
      },
    });

    await call("session.create");
    expect(bound).toHaveLength(1);
    expect(bound[0]!.session.sessionId).toBe("session-1");
    expect(bound[0]!.runtime).toBe(runtime);
  });

  it("refuses to act before a session exists", async () => {
    const { call } = harness();

    await expect(call("prompt", { text: "hi" })).rejects.toThrow(/no session is open/);
    await expect(call("abort")).rejects.toThrow(/no session is open/);
  });

  it("validates prompt input", async () => {
    const { call } = harness();
    await call("session.create");

    await expect(call("prompt", {})).rejects.toThrow(/text must be a non-empty string/);
  });
});

describe("project trust gate", () => {
  it("asks instead of loading project resources silently", async () => {
    const { call, events, emitted } = harness({ requiresTrust: () => true });

    await expect(call("session.create")).rejects.toThrow(/trust prompt/);

    expect(events()).toContain("project_trust");
    const prompt = emitted.find((entry) => entry.event === "project_trust");
    expect(prompt?.payload).toMatchObject({
      requiresTrust: true,
      needsPrompt: true,
      trusted: false,
    });
  });

  it("opens the project once the user trusts it, and remembers the decision", async () => {
    const trustStore = new Map<string, boolean | null>();
    const { call } = harness({
      requiresTrust: () => true,
      trustStore: {
        get: (cwd) => trustStore.get(cwd) ?? null,
        set: (cwd, decision) => {
          trustStore.set(cwd, decision);
        },
      },
    });

    const snapshot = await call("session.create", { trust: "trust" });

    expect(snapshot).toMatchObject({ sessionId: "session-1" });
    expect(trustStore.get(CWD)).toBe(true);
  });

  it("honours a remembered decision without prompting", async () => {
    const { call, events } = harness({
      requiresTrust: () => true,
      trustStore: { get: () => true, set: () => {} },
    });

    await call("session.create");

    expect(events()).not.toContain("project_trust");
  });
});

describe("session core conversation", () => {
  it("forwards a prompt and mirrors SDK events as frames", async () => {
    const { call, events, primary } = harness();
    await call("session.create");

    await call("prompt", { text: "summarise the sheet" });

    expect(primary.prompts).toEqual(["summarise the sheet"]);
    expect(events()).toContain("agent_start");
    expect(events()).toContain("message_update");
    expect(events()).toContain("agent_end");
    // `agent_end` and `message_update` both trigger a fresh state snapshot.
    expect(events().filter((event) => event === "state").length).toBeGreaterThan(1);
  });

  it("reports state, stats and messages", async () => {
    const { call } = harness();
    await call("session.create");
    await call("prompt", { text: "hi" });

    const state = (await call("state.get")) as Record<string, unknown>;
    const stats = (await call("stats.get")) as Record<string, unknown>;
    const messages = (await call("messages.get", { limit: 1 })) as {
      messages: unknown[];
      total: number;
    };

    expect(state).toMatchObject({ streaming: false, thinkingLevel: "medium" });
    expect(stats).toMatchObject({ messageCount: 2, pendingMessages: 0 });
    expect(messages.total).toBe(2);
    expect(messages.messages).toHaveLength(1);
  });

  it("handles steering, follow-up, abort and clearQueue", async () => {
    const { call } = harness();
    await call("session.create");

    await expect(call("abort")).resolves.toEqual({ aborted: true });
    expect(await call("clearQueue")).toEqual({ cleared: { steering: ["a"], followUp: [] } });
    // The fake session exposes neither steer nor followUp.
    await expect(call("steer", { text: "stop" })).rejects.toThrow(/not supported/);
    await expect(call("followUp", { text: "then" })).rejects.toThrow(/not supported/);
  });
});

describe("extension model changes", () => {
  it("emits a state snapshot when an extension selects a model", async () => {
    let notify: (() => void) | null = null;
    const { call, emitted, primary } = harness({
      observeModelChanges: (_session, onChange) => {
        notify = onChange;
        return () => {
          notify = null;
        };
      },
    });
    await call("session.create");

    primary.state.model = { id: "gpt-5", provider: "openai", name: "GPT-5" };
    notify!();

    const states = emitted.filter((entry) => entry.event === "state");
    expect(states.at(-1)?.payload).toMatchObject({
      model: { id: "gpt-5", provider: "openai", name: "GPT-5" },
    });
  });

  it("emits a state snapshot for a thinking-level change on the session bus", async () => {
    const { call, emitted, primary } = harness();
    await call("session.create");

    primary.state.thinkingLevel = "high";
    primary.emit({ type: "thinking_level_changed", level: "high" });

    const states = emitted.filter((entry) => entry.event === "state");
    expect(states.at(-1)?.payload).toMatchObject({ thinkingLevel: "high" });
  });

  it("reinstalls the observer on rebind and disposes it with the core", async () => {
    const observers: Array<() => void> = [];
    const disposed = vi.fn();
    const { call, core } = harness({
      observeModelChanges: (_session, onChange) => {
        observers.push(onChange);
        return disposed;
      },
    });
    await call("session.create");
    expect(observers).toHaveLength(1);

    await call("session.reload");
    expect(observers).toHaveLength(2);
    expect(disposed).toHaveBeenCalledTimes(1);

    await core.dispose();
    expect(disposed).toHaveBeenCalledTimes(2);
  });
});

describe("session core configuration", () => {
  it("exposes settings and their errors", async () => {
    const { call } = harness();
    await call("session.create");

    expect(await call("settings.get")).toEqual({
      settings: {
        global: { theme: "dark", npmCommand: ["node", "npm-cli.js"] },
        project: { defaultTools: ["read"] },
      },
      errors: [{ message: "one warning" }],
    });
  });

  it("reports thinking levels, tools and tool selection", async () => {
    const { call } = harness();
    await call("session.create");

    expect(await call("thinking.levels")).toEqual({
      levels: ["off", "low", "medium", "high"],
      current: "medium",
    });
    const tools = (await call("tools.list")) as { tools: unknown[]; active: string[] };
    expect(tools.active).toEqual(["read"]);

    await expect(call("tools.setActive", { names: "read" })).rejects.toThrow(/names array/);
    await expect(call("tools.setActive", { names: ["bash"] })).resolves.toMatchObject({
      sessionId: "session-1",
    });
  });

  it("leaves the profile-wide session listing to the control host", () => {
    const { core } = harness();
    expect(core.handlers()["session.list"]).toBeUndefined();
  });
});

describe("session core replacement", () => {
  it("rebinds subscriptions after a fork and announces the replacement", async () => {
    const { call, events, forks, forked } = harness();
    await call("session.create");

    const snapshot = (await call("session.fork", { entryId: "entry-7" })) as Record<
      string,
      unknown
    >;

    expect(forks).toEqual(["entry-7"]);
    expect(snapshot).toMatchObject({ cancelled: false, selectedText: "from the fork point" });
    expect(events()).toContain("session_replaced");

    // Events from the new session are mirrored, not the old one.
    forked.emit({ type: "agent_start" });
    expect(events().filter((event) => event === "agent_start")).toHaveLength(1);
  });

  it("validates the fork target", async () => {
    const { call } = harness();
    await call("session.create");

    await expect(call("session.fork", {})).rejects.toThrow(/entryId must be a non-empty string/);
  });

  it("reloads and rebinds", async () => {
    const { call, events } = harness();
    await call("session.create");

    await expect(call("session.reload")).resolves.toMatchObject({ sessionId: "session-1" });
    expect(events()).toContain("session_replaced");
  });

  it("disposes without throwing", async () => {
    const { core, call } = harness();
    await call("session.create");
    await expect(core.dispose()).resolves.toBeUndefined();
    expect(core.session()).toBeNull();
  });
});

describe("session core emits via the injected emitter", () => {
  it("tags frames with the session id", async () => {
    const { call, emitted } = harness();
    await call("session.create");
    const withId = emitted.filter((entry) => entry.sessionId === "session-1");
    expect(withId.length).toBeGreaterThan(0);
  });

  it("never throws when the emitter fails", async () => {
    const failure = vi.fn();
    const { call } = harness({
      emit: () => {
        failure();
      },
    });
    await expect(call("session.create")).resolves.toBeDefined();
    expect(failure).toHaveBeenCalled();
  });
});

describe("session core safe mode (plan step 22)", () => {
  function runtimeWith(
    requests: SessionRuntimeRequest[],
    safeMode: boolean | undefined,
    deps: Partial<SessionCoreDeps> = {},
  ) {
    const session = fakeSession().session;
    const runtime: RuntimeLike = {
      get session() {
        return session;
      },
      get services() {
        return { cwd: CWD };
      },
    };
    const harnessed = harness({
      ...deps,
      ...(safeMode === undefined ? {} : { safeMode }),
      createRuntime: async (request) => {
        requests.push(request);
        return { runtime, session };
      },
    });
    return harnessed;
  }

  it("forwards safe mode to the runtime factory so no resources load", async () => {
    const requests: SessionRuntimeRequest[] = [];
    const { call } = runtimeWith(requests, true);
    await call("session.create");
    expect(requests[0]?.safeMode).toBe(true);
  });

  it("omits safe mode when it is off", async () => {
    const requests: SessionRuntimeRequest[] = [];
    const { call } = runtimeWith(requests, undefined);
    await call("session.create");
    expect(requests[0]).not.toHaveProperty("safeMode");
  });

  it("forwards the project trust decision to the runtime factory", async () => {
    const requests: SessionRuntimeRequest[] = [];
    const { call } = runtimeWith(requests, undefined, {
      requiresTrust: () => true,
      trustStore: {
        get: () => false,
        set: () => undefined,
      },
    });
    await call("session.create");
    expect(requests[0]?.projectTrusted).toBe(false);
  });
});
