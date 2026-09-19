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

  it("refuses a plain prompt while the agent is streaming", async () => {
    const request = stubRequest(async () => ({}));
    useAppStore.setState({ tabs: [tab("running")] });

    await expect(useAppStore.getState().sendPrompt("tab-1", "one more thing")).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
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
    expect(request.mock.calls[0]?.[0]).toMatchObject({
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
