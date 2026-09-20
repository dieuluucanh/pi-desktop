import { describe, expect, it } from "vitest";
import type { HostMethod } from "../../src/shared/host-protocol";
import { createSessionCore, type HostSession, type RuntimeLike } from "../../src/host/session-core";

const CWD = "C:/work/app";
const AGENT_DIR = "C:/profile";

/** A session that records what the per-project defaults did to it. */
function fakeSession(catalog: readonly unknown[]) {
  const appliedModels: unknown[] = [];
  const appliedThinking: Array<{ level: string; persist: boolean | undefined }> = [];

  const session = {
    sessionId: "session-1",
    sessionFile: `${AGENT_DIR}/sessions/s1.jsonl`,
    sessionName: "App",
    model: null,
    thinkingLevel: null,
    isStreaming: false,
    isIdle: true,
    messages: [],
    pendingMessageCount: 0,
    getAvailableThinkingLevels: () => ["off", "low", "high"],
    getActiveToolNames: () => [],
    modelRuntime: { getAvailableSnapshot: () => catalog },
    subscribe: () => () => undefined,
    async setModel(model: unknown) {
      appliedModels.push(model);
    },
    setThinkingLevel(level: string, options?: { persist?: boolean }) {
      appliedThinking.push({ level, persist: options?.persist });
    },
  } as unknown as HostSession;

  const runtime: RuntimeLike = {
    get session() {
      return session;
    },
    get services() {
      return {};
    },
    setRebindSession: () => undefined,
    async dispose() {},
  };

  return { session, runtime, appliedModels, appliedThinking };
}

function core(catalog: readonly unknown[]) {
  const fake = fakeSession(catalog);
  const created = createSessionCore({
    cwd: CWD,
    agentDir: AGENT_DIR,
    createRuntime: async () => ({ runtime: fake.runtime, session: fake.session }),
    newSessionManager: () => ({ id: "new" }),
    openSessionManager: () => ({ id: "opened" }),
    requiresTrust: () => false,
    emit: () => undefined,
  });
  const call = async (method: HostMethod, params?: unknown): Promise<unknown> => {
    const handler = created.handlers()[method];
    if (!handler) throw new Error(`no handler for ${method}`);
    return handler(params, {} as never) as Promise<unknown>;
  };
  return { ...fake, call };
}

const CATALOG = [
  { id: "claude-sonnet-4", provider: "anthropic", name: "Claude Sonnet 4" },
  { id: "gpt-5", provider: "openai", name: "GPT-5" },
];

describe("per-project model and thinking defaults (plan step 10)", () => {
  it("applies a matching default model without persisting it", async () => {
    const { call, appliedModels, appliedThinking } = core(CATALOG);

    await call("session.create", {
      cwd: CWD,
      model: "anthropic/claude-sonnet-4",
      thinking: "high",
    });

    expect(appliedModels).toEqual([CATALOG[0]]);
    expect(appliedThinking).toEqual([{ level: "high", persist: false }]);
  });

  it("accepts a bare model id and ignores a model the catalog does not offer", async () => {
    const bare = core(CATALOG);
    await bare.call("session.create", { cwd: CWD, model: "gpt-5" });
    expect(bare.appliedModels).toEqual([CATALOG[1]]);

    const unknown = core(CATALOG);
    await unknown.call("session.create", { cwd: CWD, model: "provider/not-there" });
    expect(unknown.appliedModels).toEqual([]);
  });

  it("never applies defaults when a session is resumed or opened", async () => {
    const { call, appliedModels, appliedThinking } = core(CATALOG);

    await call("session.resume", {
      sessionFile: `${AGENT_DIR}/sessions/s1.jsonl`,
      model: "anthropic/claude-sonnet-4",
      thinking: "high",
    });
    await call("session.open", {
      sessionFile: `${AGENT_DIR}/sessions/s2.jsonl`,
      model: "anthropic/claude-sonnet-4",
    });

    expect(appliedModels).toEqual([]);
    expect(appliedThinking).toEqual([]);
  });

  it("creates the session even when the host offers no model catalog", async () => {
    const { call, appliedThinking } = core([]);
    const snapshot = await call("session.create", { cwd: CWD, model: "a/b", thinking: "low" });
    expect(snapshot).toMatchObject({ sessionId: "session-1" });
    expect(appliedThinking).toEqual([{ level: "low", persist: false }]);
  });
});
