import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRAFT_PERSIST_DELAY_MS, useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import { installBridge } from "./fixtures";

/**
 * The composer's store actions (plan step 6): what reaches the host, and what
 * happens to the user's text when a run is cancelled.
 */

function tab(status: TabRecord["status"]): TabRecord {
  return {
    id: "tab-1",
    kind: "session",
    cwd: "/work/app",
    title: "app",
    sessionFile: "/profile/s1.jsonl",
    status,
    createdAt: 0,
    lastActiveAt: 0,
    model: "test-model",
  };
}

function stubRequest(impl: (input: { method: string; params?: unknown }) => Promise<unknown>) {
  const request = vi.fn(async (input: { method: string; params?: unknown }) => impl(input));
  (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
  return request;
}

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    tabs: [tab("idle")],
    activeTabId: "tab-1",
    transcripts: {},
    sessionStates: {},
    sendModes: {},
    draftHistory: {},
    historyIndex: {},
    hint: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sendPrompt", () => {
  it("sends a plain prompt when idle, clears the draft and remembers it", async () => {
    const request = stubRequest(async () => ({}));
    useAppStore.getState().setDraft("tab-1", "please fix it");

    await expect(useAppStore.getState().sendPrompt("tab-1", "please fix it")).resolves.toBe(true);

    expect(request).toHaveBeenCalledWith({
      tabId: "tab-1",
      method: "prompt",
      params: { text: "please fix it" },
    });
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("");
    expect(useAppStore.getState().draftHistory["tab-1"]).toEqual(["please fix it"]);
  });

  it("falls back to steer when a stale renderer sends without a mode during a turn", async () => {
    const request = stubRequest(async () => ({}));
    useAppStore.setState({ tabs: [tab("running")] });

    await expect(useAppStore.getState().sendPrompt("tab-1", "one more thing")).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "prompt",
        params: { text: "one more thing", streamingBehavior: "steer" },
      }),
    );
  });

  it("delivers a steer or a follow-up with the mode the host requires", async () => {
    const request = stubRequest(async () => ({}));
    useAppStore.setState({ tabs: [tab("running")] });

    await useAppStore.getState().sendPrompt("tab-1", "stop that", { mode: "steer" });
    await useAppStore.getState().sendPrompt("tab-1", "then commit", { mode: "followUp" });

    expect(request.mock.calls[0]?.[0]).toMatchObject({
      method: "prompt",
      params: { text: "stop that", streamingBehavior: "steer" },
    });
    expect(request.mock.calls[1]?.[0]).toMatchObject({
      params: { text: "then commit", streamingBehavior: "followUp" },
    });
  });

  it("passes images through unchanged", async () => {
    const request = stubRequest(async () => ({}));
    await useAppStore.getState().sendPrompt("tab-1", "look", {
      images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    });
    const promptCall = request.mock.calls.find(([input]) => input.method === "prompt");
    expect(promptCall?.[0]).toMatchObject({
      params: { images: [{ type: "image", data: "AAAA", mimeType: "image/png" }] },
    });
  });

  it("reports a host refusal instead of pretending it sent", async () => {
    stubRequest(async () => {
      throw new Error("the agent is already streaming");
    });
    await expect(useAppStore.getState().sendPrompt("tab-1", "hi")).resolves.toBe(false);
    expect(useAppStore.getState().hint).toMatch(/already streaming/);
  });
});

describe("bash mode", () => {
  it("routes `!command` to bash.run and never to prompt", async () => {
    const request = stubRequest(async () => ({ result: { output: "/work/app" } }));
    await expect(useAppStore.getState().sendPrompt("tab-1", "!pwd")).resolves.toBe(true);
    const bashCalls = request.mock.calls.filter(([input]) => input.method === "bash.run");
    expect(bashCalls).toHaveLength(1);
    expect(request.mock.calls.some(([input]) => input.method === "prompt")).toBe(false);
    expect(bashCalls[0]?.[0]).toEqual({
      tabId: "tab-1",
      method: "bash.run",
      params: { command: "pwd", excludeFromContext: false },
    });
    expect(useAppStore.getState().draftHistory["tab-1"]).toEqual(["!pwd"]);
  });

  it("sets excludeFromContext for `!!command`", async () => {
    const request = stubRequest(async () => ({ result: { output: "" } }));
    await useAppStore.getState().sendPrompt("tab-1", "!!pwd");
    expect(request).toHaveBeenCalledWith({
      tabId: "tab-1",
      method: "bash.run",
      params: { command: "pwd", excludeFromContext: true },
    });
  });

  it("ignores a bare `!` (nothing to run)", async () => {
    const request = stubRequest(async () => ({}));
    await expect(useAppStore.getState().sendPrompt("tab-1", "!   ")).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses a second command while one runs and keeps the text", async () => {
    const request = stubRequest(async () => ({}));
    useAppStore.setState({ sessionStates: { "tab-1": { bashRunning: true } as never } });
    await expect(useAppStore.getState().sendPrompt("tab-1", "!ls")).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(useAppStore.getState().hint).toMatch(/already running/i);
  });

  it("Esc during bash aborts the command first, not the agent turn", async () => {
    const request = stubRequest(async () => ({ aborted: true }));
    useAppStore.setState({
      tabs: [tab("running")],
      sessionStates: { "tab-1": { bashRunning: true } as never },
    });
    await useAppStore.getState().stopRun("tab-1");
    expect(request.mock.calls.map((call) => call[0]?.method)).toEqual(["bash.abort"]);
  });

  it("Esc during a retry or compaction cancels that run instead of the turn", async () => {
    const request = stubRequest(async () => ({ aborted: true }));
    useAppStore.setState({
      tabs: [tab("running")],
      sessionStates: { "tab-1": { retrying: true } as never },
    });
    await useAppStore.getState().stopRun("tab-1");
    expect(request.mock.calls.map((call) => call[0]?.method)).toEqual(["session.abortRetry"]);

    request.mockClear();
    useAppStore.setState({ sessionStates: { "tab-1": { compacting: true } as never } });
    await useAppStore.getState().stopRun("tab-1");
    expect(request.mock.calls.map((call) => call[0]?.method)).toEqual(["session.abortCompaction"]);
  });
});

describe("stopRun", () => {
  it("clears the queue, aborts, and hands the queued text back to the editor", async () => {
    const request = stubRequest(async (input) => {
      if (input.method === "clearQueue") {
        return { cleared: { steering: ["stop and test"], followUp: ["then commit"] } };
      }
      return { aborted: true };
    });
    useAppStore.setState({ tabs: [tab("running")] });

    await useAppStore.getState().stopRun("tab-1");

    expect(request.mock.calls.map((call) => call[0]?.method)).toEqual(["clearQueue", "abort"]);
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("stop and test\n\nthen commit");
  });

  it("does not touch the draft when nothing was queued", async () => {
    stubRequest(async () => ({ cleared: { steering: [], followUp: [] } }));
    useAppStore.setState({ tabs: [tab("running")] });
    useAppStore.getState().setDraft("tab-1", "my own draft");

    await useAppStore.getState().stopRun("tab-1");

    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("my own draft");
  });

  it("restores the queue without aborting the run (Alt+Up, plan step 9)", async () => {
    const request = stubRequest(async (input) => {
      if (input.method === "clearQueue") {
        return { cleared: { steering: ["steer text"], followUp: ["follow text"] } };
      }
      return {};
    });
    useAppStore.setState({ tabs: [tab("running")] });
    useAppStore.getState().setDraft("tab-1", "still typing");

    await useAppStore.getState().restoreQueue("tab-1");

    expect(request.mock.calls.map((call) => call[0]?.method)).toEqual(["clearQueue"]);
    // Steering first, then follow-ups, then the user's own draft.
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe(
      "steer text\n\nfollow text\n\nstill typing",
    );
  });
});

describe("drafts", () => {
  it("persists the draft map shortly after typing stops", async () => {
    vi.useFakeTimers();
    const set = vi.fn(async (patch: unknown) => patch);
    (window.pi as unknown as { prefs: { set: unknown } }).prefs.set = set;

    useAppStore.getState().setDraft("tab-1", "half written");
    expect(set).not.toHaveBeenCalled();

    vi.advanceTimersByTime(DRAFT_PERSIST_DELAY_MS + 1);
    expect(set).toHaveBeenCalledWith({ drafts: { "tab-1": "half written" } });
  });

  it("keeps a draft per tab so switching tabs cannot lose one", () => {
    useAppStore.getState().setDraft("tab-1", "first tab draft");
    useAppStore.getState().setDraft("tab-2", "second tab draft");
    expect(useAppStore.getState().prefs.drafts).toEqual({
      "tab-1": "first tab draft",
      "tab-2": "second tab draft",
    });
  });
});

describe("history", () => {
  it("walks back through prompts and forward to the live draft", () => {
    useAppStore.setState({ draftHistory: { "tab-1": ["newest", "older"] }, historyIndex: {} });
    expect(useAppStore.getState().historyStep("tab-1", -1)).toBe("newest");
    expect(useAppStore.getState().historyStep("tab-1", -1)).toBe("older");
    expect(useAppStore.getState().historyStep("tab-1", 1)).toBe("newest");
    expect(useAppStore.getState().historyStep("tab-1", 1)).toBeNull();
  });
});

describe("copy last assistant (plan step 12)", () => {
  it("copies the last assistant text from the host", async () => {
    stubRequest(async (input) =>
      input.method === "session.lastAssistantText" ? { text: "the final answer" } : {},
    );
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    await expect(useAppStore.getState().copyLastAssistant("tab-1")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("the final answer");
    expect(useAppStore.getState().hint).toMatch(/copied/i);
  });

  it("explains when there is nothing to copy yet", async () => {
    stubRequest(async () => ({ text: null }));
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    await expect(useAppStore.getState().copyLastAssistant("tab-1")).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    expect(useAppStore.getState().hint).toMatch(/no assistant message/i);
  });
});

describe("session info (plan step 12)", () => {
  it("maps the live stats payload into the dialog view", async () => {
    stubRequest(async () => ({
      messageCount: 12,
      toolCount: 3,
      model: { id: "test-model", provider: "test" },
      thinkingLevel: "high",
      streaming: true,
      pendingMessages: 1,
      contextUsage: { tokens: 1200, contextWindow: 200_000, percent: 60 },
      tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1, total: 126, cost: 0.03 },
      steeringMode: "all",
      followUpMode: "one-at-a-time",
      autoCompaction: true,
      autoRetry: false,
    }));
    useAppStore.setState({
      tabs: [tab("running")],
      sessionStates: {
        "tab-1": {
          sessionId: "s1",
          sessionFile: "/profile/s1.jsonl",
          sessionName: "Fix the bug",
        } as never,
      },
    });

    await useAppStore.getState().openSessionInfo("tab-1");

    const data = useAppStore.getState().sessionInfoData;
    expect(data).toMatchObject({
      sessionId: "s1",
      sessionFile: "/profile/s1.jsonl",
      sessionName: "Fix the bug",
      cwd: "/work/app",
      messageCount: 12,
      toolCount: 3,
      streaming: true,
      steeringMode: "all",
      autoCompaction: true,
      tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1, total: 126, cost: 0.03 },
    });
    expect(useAppStore.getState().sessionInfoOpen).toBe(true);
    useAppStore.getState().closeSessionInfo();
    expect(useAppStore.getState().sessionInfoOpen).toBe(false);
  });
});
