import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { createTranscriptState } from "../../src/renderer/src/session/session-events";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * Reliability store actions (plan step 22): a failed call is classified, an
 * offline failure raises the persistent banner, and a crashed host can be
 * restarted without losing the transcript's place in the session file.
 */

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    view: "session",
    prefs: { ...DEFAULT_PREFS },
    hint: null,
    offlineNotice: null,
    transcripts: { "tab-1": { ...createTranscriptState(), hydrated: true } },
  });
});

describe("noteFailure", () => {
  it("sets the transient hint for any failure", () => {
    useAppStore.getState().noteFailure(new Error("no handler for state.get"));
    expect(useAppStore.getState().hint).toBe("no handler for state.get");
    expect(useAppStore.getState().offlineNotice).toBeNull();
  });

  it("raises the offline banner only for connectivity failures", () => {
    useAppStore.getState().noteFailure(new Error("getaddrinfo ENOTFOUND registry.npmjs.org"));
    expect(useAppStore.getState().offlineNotice).toContain("ENOTFOUND");
    expect(useAppStore.getState().hint).toContain("ENOTFOUND");
  });

  it("accepts a non-Error throw", () => {
    useAppStore.getState().noteFailure("fetch failed");
    expect(useAppStore.getState().offlineNotice).toBe("fetch failed");
  });

  it("clears the banner on demand", () => {
    useAppStore.getState().noteFailure(new Error("ECONNRESET"));
    expect(useAppStore.getState().offlineNotice).not.toBeNull();
    useAppStore.getState().clearOffline();
    expect(useAppStore.getState().offlineNotice).toBeNull();
  });
});

describe("restartTab", () => {
  it("asks main to restart the host and re-hydrates the transcript", async () => {
    const restart = vi.fn(async () => ({ tabs: [], activeTabId: null }));
    (window.pi as unknown as { sessions: { restart: unknown } }).sessions.restart = restart;

    await useAppStore.getState().restartTab("tab-1");

    expect(restart).toHaveBeenCalledWith("tab-1");
    expect(useAppStore.getState().transcripts["tab-1"]?.hydrated).toBe(false);
  });

  it("surfaces a restart failure as a hint", async () => {
    const restart = vi.fn(async () => {
      throw new Error("host for tab-1 is not running");
    });
    (window.pi as unknown as { sessions: { restart: unknown } }).sessions.restart = restart;

    await useAppStore.getState().restartTab("tab-1");

    expect(useAppStore.getState().hint).toContain("not running");
  });
});

describe("a failed send", () => {
  it("funnels through noteFailure, so an offline host raises the banner", async () => {
    const request = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1");
    });
    (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;

    const sent = await useAppStore.getState().sendPromptNow("tab-1", "hello");

    expect(sent).toBe(false);
    expect(useAppStore.getState().offlineNotice).toContain("ECONNREFUSED");
  });
});
