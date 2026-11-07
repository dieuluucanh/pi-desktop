import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRAFT_PERSIST_DELAY_MS,
  EDITOR_TEXT_DELAY_MS,
  useAppStore,
} from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { hashPromptText } from "../../src/shared/prompt-origin";
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
    draftHistory: {},
    historyBrowse: {},
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
      params: { text: "please fix it", ack: "preflight" },
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
        params: { text: "one more thing", streamingBehavior: "steer", ack: "preflight" },
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

  it("clears the draft before the host acknowledges the send", async () => {
    let release!: (value: unknown) => void;
    stubRequest(async (input) => {
      if (input.method === "prompt") {
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return {};
    });
    useAppStore.getState().setDraft("tab-1", "please fix it");

    const pending = useAppStore.getState().sendPrompt("tab-1", "please fix it");
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("");

    await vi.waitFor(() => expect(typeof release).toBe("function"));
    release({});
    await expect(pending).resolves.toBe(true);
  });

  it("restores a refused send above a newer draft", async () => {
    let reject!: (error: Error) => void;
    stubRequest(async (input) => {
      if (input.method === "prompt") {
        return new Promise((_resolve, fail) => {
          reject = fail;
        });
      }
      return {};
    });
    useAppStore.getState().setDraft("tab-1", "please fix it");

    const pending = useAppStore.getState().sendPrompt("tab-1", "please fix it");
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("");
    useAppStore.getState().setDraft("tab-1", "a newer thought");

    await vi.waitFor(() => expect(typeof reject).toBe("function"));
    reject(new Error("host is down"));

    await expect(pending).resolves.toBe(false);
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("please fix it\n\na newer thought");
  });

  it("sends the raw command as promptOrigin only for prompt/skill commands", async () => {
    const request = stubRequest(async () => ({}));
    useAppStore.setState({
      completionCommands: { "tab-1": [{ name: "review", source: "prompt" }] },
    });

    await useAppStore.getState().sendPrompt("tab-1", "/review the diff");
    const template = request.mock.calls.find(([input]) => input.method === "prompt");
    expect(template?.[0]?.params).toMatchObject({
      text: "/review the diff",
      ack: "preflight",
      promptOrigin: "/review the diff",
    });

    request.mockClear();
    // `ensureSession` applies the fixture's empty tab list; restore the tab so
    // the second send exercises a plain prompt rather than "no tab".
    useAppStore.setState({ tabs: [tab("idle")] });
    await useAppStore.getState().sendPrompt("tab-1", "plain text");
    const plain = request.mock.calls.find(([input]) => input.method === "prompt");
    expect(plain?.[0]?.params).not.toHaveProperty("promptOrigin");
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
      params: { command: "pwd", excludeFromContext: false, ack: "started" },
    });
    expect(useAppStore.getState().draftHistory["tab-1"]).toEqual(["!pwd"]);
  });

  it("sets excludeFromContext for `!!command`", async () => {
    const request = stubRequest(async () => ({ result: { output: "" } }));
    await useAppStore.getState().sendPrompt("tab-1", "!!pwd");
    expect(request).toHaveBeenCalledWith({
      tabId: "tab-1",
      method: "bash.run",
      params: { command: "pwd", excludeFromContext: true, ack: "started" },
    });
  });

  it("clears the draft before a long bash command finishes", async () => {
    let release!: (value: unknown) => void;
    stubRequest(async (input) => {
      if (input.method === "bash.run") {
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return {};
    });
    useAppStore.getState().setDraft("tab-1", "!sleep 5");

    const pending = useAppStore.getState().sendPrompt("tab-1", "!sleep 5");
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("");

    await vi.waitFor(() => expect(typeof release).toBe("function"));
    release({});
    await expect(pending).resolves.toBe(true);
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

  it("persists the stashed draft, not the history preview", () => {
    vi.useFakeTimers();
    const set = vi.fn(async (patch: unknown) => patch);
    (window.pi as unknown as { prefs: { set: unknown } }).prefs.set = set;
    useAppStore.setState({ draftHistory: { "tab-1": ["recalled prompt"] }, historyBrowse: {} });

    useAppStore.getState().setDraft("tab-1", "pending draft");
    useAppStore.getState().historyStep("tab-1", -1, 0);
    // The preview is the visible buffer, but not what belongs on disk.
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("recalled prompt");

    vi.advanceTimersByTime(DRAFT_PERSIST_DELAY_MS + 1);
    expect(set).toHaveBeenLastCalledWith({ drafts: { "tab-1": "pending draft" } });

    // Returning to the draft resumes normal persistence with the same text.
    useAppStore.getState().historyStep("tab-1", 1, 0);
    vi.advanceTimersByTime(DRAFT_PERSIST_DELAY_MS + 1);
    expect(set).toHaveBeenLastCalledWith({ drafts: { "tab-1": "pending draft" } });
  });

  it("mirrors the stashed draft to the host, not the history preview", () => {
    vi.useFakeTimers();
    const request = stubRequest(async () => ({}));
    useAppStore.setState({ draftHistory: { "tab-1": ["recalled prompt"] }, historyBrowse: {} });

    useAppStore.getState().setDraft("tab-1", "pending draft");
    useAppStore.getState().historyStep("tab-1", -1, 0);

    vi.advanceTimersByTime(EDITOR_TEXT_DELAY_MS + 1);

    const mirror = request.mock.calls.find((call) => call[0]?.method === "oi.editorText");
    expect(mirror?.[0]?.params).toEqual({ text: "pending draft" });
  });
});

describe("prompt history (2026-11-07 plan)", () => {
  it("recalls the newest prompt, writes the preview and stashes the draft", () => {
    useAppStore.setState({ draftHistory: { "tab-1": ["newest", "older"] }, historyBrowse: {} });
    useAppStore.getState().setDraft("tab-1", "pending draft");

    expect(useAppStore.getState().historyStep("tab-1", -1, 4)).toEqual({
      kind: "applied",
      text: "newest",
      caret: "newest".length,
      browse: { index: 0, draftText: "pending draft", draftCaret: 4 },
    });
    // The visible buffer is the preview; the stash holds the draft.
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("newest");
    expect(useAppStore.getState().historyBrowse["tab-1"]).toEqual({
      index: 0,
      draftText: "pending draft",
      draftCaret: 4,
    });
  });

  it("walks older entries and restores the draft text and caret", () => {
    useAppStore.setState({ draftHistory: { "tab-1": ["newest", "older"] }, historyBrowse: {} });
    useAppStore.getState().setDraft("tab-1", "pending\ntyping");

    useAppStore.getState().historyStep("tab-1", -1, 7);
    expect(useAppStore.getState().historyStep("tab-1", -1, 0)).toMatchObject({
      kind: "applied",
      text: "older",
    });
    expect(useAppStore.getState().historyStep("tab-1", 1, 0)).toMatchObject({
      kind: "applied",
      text: "newest",
    });

    expect(useAppStore.getState().historyStep("tab-1", 1, 0)).toEqual({
      kind: "applied",
      text: "pending\ntyping",
      caret: 7,
      browse: null,
    });
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("pending\ntyping");
    expect(useAppStore.getState().historyBrowse["tab-1"]).toBeUndefined();
  });

  it("restores an empty draft instead of reporting no step", () => {
    useAppStore.setState({ draftHistory: { "tab-1": ["newest"] }, historyBrowse: {} });

    useAppStore.getState().historyStep("tab-1", -1, 0);
    expect(useAppStore.getState().historyStep("tab-1", 1, 0)).toEqual({
      kind: "applied",
      text: "",
      caret: 0,
      browse: null,
    });
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("");
  });

  it("does nothing when the tab has no sent prompts", () => {
    useAppStore.getState().setDraft("tab-1", "typed");
    expect(useAppStore.getState().historyStep("tab-1", -1, 5)).toEqual({ kind: "none" });
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("typed");
  });

  it("leaves history when a real write lands while browsing", () => {
    useAppStore.setState({ draftHistory: { "tab-1": ["newest"] }, historyBrowse: {} });
    useAppStore.getState().historyStep("tab-1", -1, 0);

    useAppStore.getState().setDraft("tab-1", "edited instead");

    expect(useAppStore.getState().historyBrowse["tab-1"]).toBeUndefined();
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("edited instead");
  });

  it("ends browsing and empties the composer when a recalled prompt is sent", async () => {
    stubRequest(async () => ({}));
    useAppStore.setState({ draftHistory: { "tab-1": ["newest"] }, historyBrowse: {} });
    useAppStore.getState().setDraft("tab-1", "pending");
    useAppStore.getState().historyStep("tab-1", -1, 0);

    await expect(useAppStore.getState().sendPrompt("tab-1", "newest")).resolves.toBe(true);

    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("");
    expect(useAppStore.getState().historyBrowse["tab-1"]).toBeUndefined();
  });

  it("does not duplicate a prompt that is already the newest entry", async () => {
    stubRequest(async () => ({}));
    await useAppStore.getState().sendPrompt("tab-1", "same prompt");
    await useAppStore.getState().sendPrompt("tab-1", "same prompt");
    expect(useAppStore.getState().draftHistory["tab-1"]).toEqual(["same prompt"]);
  });

  it("caps the history at a hundred entries", async () => {
    stubRequest(async () => ({}));
    useAppStore.setState({
      draftHistory: {
        "tab-1": Array.from({ length: 100 }, (_, index) => `prompt ${index}`),
      },
    });

    await useAppStore.getState().sendPrompt("tab-1", "the newest prompt");

    const history = useAppStore.getState().draftHistory["tab-1"] ?? [];
    expect(history).toHaveLength(100);
    expect(history[0]).toBe("the newest prompt");
  });

  it("keeps each tab's walk independent", () => {
    useAppStore.setState({
      draftHistory: { "tab-1": ["first tab prompt"], "tab-2": ["second tab prompt"] },
      historyBrowse: {},
    });
    useAppStore.getState().setDraft("tab-2", "second draft");

    useAppStore.getState().historyStep("tab-1", -1, 0);

    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("first tab prompt");
    expect(useAppStore.getState().prefs.drafts["tab-2"]).toBe("second draft");
    expect(useAppStore.getState().historyBrowse["tab-2"]).toBeUndefined();
  });
});

describe("prompt history seed (2026-11-07 restart plan)", () => {
  it("rebuilds history from the transcript when a session is resumed", async () => {
    stubRequest(async (input) =>
      input.method === "messages.get"
        ? {
            messages: [
              { id: "m1", role: "user", content: "first prompt" },
              { id: "m2", role: "assistant", content: "answer" },
              { id: "m3", role: "user", content: [{ type: "text", text: "newest prompt" }] },
            ],
          }
        : {},
    );

    await useAppStore.getState().hydrateTranscript("tab-1");

    expect(useAppStore.getState().historySeed["tab-1"]).toEqual(["newest prompt", "first prompt"]);
    expect(useAppStore.getState().historyStep("tab-1", -1, 0)).toMatchObject({
      kind: "applied",
      text: "newest prompt",
    });
  });

  it("keeps a prompt sent before hydration above the seeded history", async () => {
    stubRequest(async (input) =>
      input.method === "messages.get"
        ? { messages: [{ id: "m1", role: "user", content: "from the session" }] }
        : {},
    );

    useAppStore.getState().setDraft("tab-1", "sent this run");
    await useAppStore.getState().sendPrompt("tab-1", "sent this run");
    await useAppStore.getState().hydrateTranscript("tab-1");

    expect(useAppStore.getState().historySeed["tab-1"]).toEqual(["from the session"]);
    expect(useAppStore.getState().historyStep("tab-1", -1, 0)).toMatchObject({
      kind: "applied",
      text: "sent this run",
    });
    expect(useAppStore.getState().historyStep("tab-1", -1, 0)).toMatchObject({
      kind: "applied",
      text: "from the session",
    });
  });

  it("re-seeds on a branch switch but keeps prompts sent this run", async () => {
    let messages = [{ id: "a1", role: "user", content: "branch a" }];
    stubRequest(async (input) => (input.method === "messages.get" ? { messages } : {}));

    await useAppStore.getState().hydrateTranscript("tab-1");
    expect(useAppStore.getState().historySeed["tab-1"]).toEqual(["branch a"]);

    useAppStore.getState().setDraft("tab-1", "live prompt");
    await useAppStore.getState().sendPrompt("tab-1", "live prompt");

    useAppStore.getState().resetTranscript("tab-1");
    expect(useAppStore.getState().historySeed["tab-1"]).toBeUndefined();
    expect(useAppStore.getState().draftHistory["tab-1"]).toEqual(["live prompt"]);

    messages = [{ id: "b1", role: "user", content: "branch b" }];
    await useAppStore.getState().hydrateTranscript("tab-1");

    expect(useAppStore.getState().historySeed["tab-1"]).toEqual(["branch b"]);
    expect(useAppStore.getState().historyStep("tab-1", -1, 0)).toMatchObject({
      text: "live prompt",
    });
    expect(useAppStore.getState().historyStep("tab-1", -1, 0)).toMatchObject({
      text: "branch b",
    });
  });

  it("upgrades a command seed to the typed origin when prefs arrive", async () => {
    stubRequest(async (input) =>
      input.method === "messages.get"
        ? { messages: [{ id: "m1", role: "user", content: "expanded body" }] }
        : {},
    );
    await useAppStore.getState().hydrateTranscript("tab-1");
    expect(useAppStore.getState().historySeed["tab-1"]).toEqual(["expanded body"]);

    const promptOrigins = { [hashPromptText("expanded body")]: "/skill:review src" };
    (window.pi as unknown as { prefs: { get: unknown } }).prefs.get = async () => ({
      ...DEFAULT_PREFS,
      promptOrigins,
    });
    await useAppStore.getState().loadPrefs();

    expect(useAppStore.getState().prefs.promptOrigins).toEqual(promptOrigins);
    expect(useAppStore.getState().historySeed["tab-1"]).toEqual(["/skill:review src"]);
  });

  it("seeds nothing for a transcript with no user prompts", async () => {
    stubRequest(async (input) =>
      input.method === "messages.get"
        ? {
            messages: [
              {
                id: "m1",
                role: "user",
                content: [
                  { type: "image", source: { type: "base64", mediaType: "image/png", data: "AA" } },
                ],
              },
              { id: "m2", role: "assistant", content: "answer" },
              { id: "m3", role: "bashExecution", command: "pwd", output: "/work" },
            ],
          }
        : {},
    );

    await useAppStore.getState().hydrateTranscript("tab-1");

    expect(useAppStore.getState().historySeed["tab-1"]).toEqual([]);
    expect(useAppStore.getState().historyStep("tab-1", -1, 0)).toEqual({ kind: "none" });
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

describe("prompt origin persistence", () => {
  it("records a command origin from a live message_start", () => {
    const body = "expanded commit body";
    useAppStore.getState().applySessionEvents({
      tabId: "tab-1",
      seq: 1,
      events: [
        {
          event: "message_start",
          payload: {
            message: { role: "user", content: [{ type: "text", text: body }] },
            promptOrigin: "/commit -a",
          },
        },
      ],
    });

    expect(useAppStore.getState().prefs.promptOrigins).toEqual({
      [hashPromptText(body)]: "/commit -a",
    });
  });
});
