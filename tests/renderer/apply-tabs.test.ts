import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../src/renderer/src/state/app-store";
import {
  MAX_RETAINED_BLOBS,
  MAX_RETAINED_TRANSCRIPTS,
} from "../../src/renderer/src/state/retention";
import { createTranscriptState } from "../../src/renderer/src/session/session-events";
import type { TabRecord } from "../../src/shared/session-ipc";
import { installBridge } from "./fixtures";

/**
 * `applyTabs` identity preservation (2026-11-03 plan step 5).
 *
 * Main sends a deep copy of the whole tab table on every publish, including
 * every session state frame. Reusing an unchanged record is what stops an open
 * editor from re-reading its file when a background session produces a message.
 * A real change must still replace the record.
 */

function tab(overrides: Partial<TabRecord> = {}): TabRecord {
  return {
    id: "session-1",
    kind: "session",
    cwd: "C:/work/app",
    title: "app",
    sessionFile: null,
    status: "idle",
    createdAt: 1,
    lastActiveAt: 1,
    model: null,
    ...overrides,
  };
}

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    tabs: [],
    activeTabId: null,
    webTabStates: {},
    webNavigationPrompt: null,
  });
});

describe("tab revisions (2026-11-06 tab-switch plan)", () => {
  // The counters are process-lifetime by design (main's revision only grows), so
  // these cases use strictly increasing revisions instead of resetting them.
  it("ignores a table older than the newest applied revision", () => {
    const a = tab({ id: "a" });
    useAppStore.getState().applyTabs({ tabs: [a], activeTabId: "a", revision: 1, selectionSeq: 1 });

    const stale = tab({ id: "stale", title: "stale" });
    useAppStore
      .getState()
      .applyTabs({ tabs: [stale], activeTabId: "stale", revision: 0, selectionSeq: 1 });

    expect(useAppStore.getState().tabs.map((entry) => entry.id)).toEqual(["a"]);
    expect(useAppStore.getState().activeTabId).toBe("a");
  });

  it("keeps the user's tab when a push carries an older selection", async () => {
    const a = tab({ id: "a" });
    const b = tab({ id: "b" });
    useAppStore.setState({ tabs: [a, b], activeTabId: "a" });

    // A real gesture: this window's selection sequence moves past main's.
    await useAppStore.getState().activateTab("b");
    // A push that main published before it processed the gesture (a background
    // wake, a reconcile, a late response) must not move the window back.
    useAppStore.getState().applyTabs(
      { tabs: [a, b], activeTabId: "a", revision: 2, selectionSeq: 0 },
      {
        adoptSelection: true,
      },
    );

    expect(useAppStore.getState().activeTabId).toBe("b");
  });

  it("adopts a newer selection made elsewhere", () => {
    const a = tab({ id: "a" });
    const b = tab({ id: "b" });
    useAppStore.setState({ tabs: [a, b], activeTabId: "a" });

    useAppStore.getState().applyTabs(
      { tabs: [a, b], activeTabId: "b", revision: 3, selectionSeq: 3 },
      {
        adoptSelection: true,
      },
    );

    expect(useAppStore.getState().activeTabId).toBe("b");
  });
});

describe("web tab selection (2026-11-06 tab-switch plan)", () => {
  it("reports a web tab selection to main so the next push cannot revert it", async () => {
    const session = tab({ id: "session-1" });
    const web = tab({
      id: "web-1",
      kind: "web",
      title: "127.0.0.1:8080",
      url: "http://127.0.0.1:8080/",
      sessionTabId: session.id,
    });
    useAppStore.setState({ tabs: [session, web], activeTabId: session.id });
    const activate = vi.fn(async (tabId: string) => ({
      tabs: useAppStore.getState().tabs,
      activeTabId: tabId,
    }));
    (window.pi as unknown as { sessions: { activate: unknown } }).sessions.activate = activate;

    await useAppStore.getState().activateTab(web.id);

    expect(activate).toHaveBeenCalledWith(web.id);
    expect(useAppStore.getState().activeTabId).toBe(web.id);
  });
});

describe("applyTabs", () => {
  it("reuses unchanged records and skips the state write entirely", () => {
    const first = tab();
    useAppStore.getState().applyTabs({ tabs: [first], activeTabId: first.id });
    const before = useAppStore.getState().tabs;
    const subscriber = vi.fn();
    const unsubscribe = useAppStore.subscribe(subscriber);

    // A fresh copy with the same fields, exactly what main sends on a state
    // frame that only touched another tab's transcript.
    useAppStore.getState().applyTabs({ tabs: [{ ...first }], activeTabId: first.id });

    expect(useAppStore.getState().tabs).toBe(before);
    expect(subscriber).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("replaces a record when a rendered field changes", () => {
    const first = tab();
    useAppStore.getState().applyTabs({ tabs: [first], activeTabId: first.id });

    useAppStore.getState().applyTabs({
      tabs: [{ ...first, status: "running" }],
      activeTabId: first.id,
    });

    const next = useAppStore.getState().tabs[0]!;
    expect(next).not.toBe(first);
    expect(next.status).toBe("running");
  });

  it("updates the selection without rebuilding the records", () => {
    const first = tab();
    const second = tab({ id: "session-2", lastActiveAt: 2 });
    useAppStore.getState().applyTabs({ tabs: [first, second], activeTabId: first.id });

    useAppStore.getState().applyTabs({
      tabs: [{ ...first }, { ...second }],
      activeTabId: second.id,
    });

    const state = useAppStore.getState();
    expect(state.activeTabId).toBe(second.id);
    expect(state.tabs[0]).toBe(first);
    expect(state.tabs[1]).toBe(second);
  });

  it("keeps the envelope order while reusing each record by id", () => {
    const first = tab();
    const second = tab({ id: "session-2", lastActiveAt: 2 });
    useAppStore.getState().applyTabs({ tabs: [first, second], activeTabId: first.id });

    useAppStore
      .getState()
      .applyTabs({ tabs: [{ ...second }, { ...first }], activeTabId: first.id });

    const state = useAppStore.getState();
    expect(state.tabs[0]).toBe(second);
    expect(state.tabs[1]).toBe(first);
  });

  it("clears a navigation prompt whose tab is gone", () => {
    const web = tab({ id: "web-1", kind: "web", url: "https://example.com/review" });
    useAppStore.getState().applyTabs({ tabs: [web], activeTabId: web.id });
    useAppStore.setState({
      webNavigationPrompt: {
        tabId: web.id,
        url: "https://example.com/elsewhere",
        disposition: "link",
        at: 1,
      },
    });

    useAppStore.getState().applyTabs({ tabs: [], activeTabId: null });

    expect(useAppStore.getState().webNavigationPrompt).toBeNull();
  });

  it("drops every per-tab cache when a tab closes", async () => {
    const handles = installBridge();
    const first = tab();
    useAppStore.getState().applyTabs({ tabs: [first], activeTabId: first.id });
    vi.spyOn(handles.bridge.sessions, "request").mockResolvedValue({ contents: "{}" });
    await useAppStore.getState().loadBlob(first.id, { $blob: "C:/blobs/a.json", bytes: 1 });
    useAppStore.setState({
      transcripts: { [first.id]: { ...createTranscriptState(), hydrated: true } },
      sessionStates: { [first.id]: { model: "test" } },
      modelCatalog: { [first.id]: [] },
      pasteBodies: { [first.id]: { 1: "large paste" } },
    });
    expect(useAppStore.getState().blobs["C:/blobs/a.json"]).toBeDefined();

    useAppStore.getState().applyTabs({ tabs: [], activeTabId: null });

    const state = useAppStore.getState();
    expect(state.transcripts[first.id]).toBeUndefined();
    expect(state.sessionStates[first.id]).toBeUndefined();
    expect(state.modelCatalog[first.id]).toBeUndefined();
    expect(state.pasteBodies[first.id]).toBeUndefined();
    expect(state.blobs["C:/blobs/a.json"]).toBeUndefined();
  });

  it("keeps at most MAX_RETAINED_TRANSCRIPTS and rehydrates on activation", async () => {
    const handles = installBridge();
    const tabs = Array.from({ length: 6 }, (_, index) =>
      tab({ id: `session-${index + 1}`, lastActiveAt: index + 1 }),
    );
    useAppStore.getState().applyTabs({ tabs, activeTabId: tabs[0]!.id });
    useAppStore.setState({
      transcripts: Object.fromEntries(
        tabs.map((entry) => [entry.id, { ...createTranscriptState(), hydrated: true }]),
      ),
    });

    useAppStore.getState().applyTabs({ tabs, activeTabId: tabs[5]!.id });

    const hydrated = Object.values(useAppStore.getState().transcripts).filter(
      (transcript) => transcript.hydrated,
    );
    expect(hydrated).toHaveLength(MAX_RETAINED_TRANSCRIPTS);
    expect(useAppStore.getState().transcripts["session-6"]?.hydrated).toBe(true);

    const request = vi
      .spyOn(handles.bridge.sessions, "request")
      .mockResolvedValue({ messages: [] });
    await useAppStore.getState().activateTab("session-1");

    // `activateTab` starts hydration fire-and-forget; wait for the async read.
    await vi.waitFor(() => {
      expect(useAppStore.getState().transcripts["session-1"]?.hydrated).toBe(true);
    });
    expect(request).toHaveBeenCalledWith({ tabId: "session-1", method: "messages.get" });
  });

  it("never evicts a running transcript", () => {
    const running = tab({ id: "session-running", status: "running", lastActiveAt: 1 });
    const tabs = [running];
    for (let index = 0; index < 6; index += 1) {
      tabs.push(tab({ id: `session-${index}`, lastActiveAt: index + 2 }));
    }
    useAppStore.getState().applyTabs({ tabs, activeTabId: tabs.at(-1)!.id });
    useAppStore.setState({
      transcripts: Object.fromEntries(
        tabs.map((entry) => [entry.id, { ...createTranscriptState(), hydrated: true }]),
      ),
    });

    useAppStore.getState().applyTabs({ tabs, activeTabId: tabs.at(-1)!.id });

    expect(useAppStore.getState().transcripts["session-running"]?.hydrated).toBe(true);
  });

  it("ignores a late event batch for a closed tab", () => {
    const first = tab();
    useAppStore.getState().applyTabs({ tabs: [first], activeTabId: first.id });
    useAppStore.getState().applyTabs({ tabs: [], activeTabId: null });

    useAppStore.getState().applySessionEvents({
      tabId: first.id,
      seq: 1,
      events: [
        {
          event: "message_start",
          payload: { message: { role: "assistant", content: "late" } },
        },
      ],
    });

    expect(useAppStore.getState().transcripts[first.id]).toBeUndefined();
  });

  it("does not reintroduce a closed transcript while trimming the cache", () => {
    const tabs = Array.from({ length: 6 }, (_, index) =>
      tab({ id: `session-${index + 1}`, lastActiveAt: index + 1 }),
    );
    useAppStore.getState().applyTabs({ tabs, activeTabId: tabs[0]!.id });
    useAppStore.setState({
      transcripts: Object.fromEntries(
        tabs.map((entry) => [entry.id, { ...createTranscriptState(), hydrated: true }]),
      ),
    });

    useAppStore.getState().applyTabs({ tabs: tabs.slice(0, 5), activeTabId: tabs[0]!.id });

    expect(useAppStore.getState().transcripts["session-6"]).toBeUndefined();
  });

  it("does not resurrect a transcript when messages.get resolves after close", async () => {
    const handles = installBridge();
    const first = tab();
    useAppStore.getState().applyTabs({ tabs: [first], activeTabId: first.id });
    let resolve: ((value: { messages: unknown[] }) => void) | undefined;
    vi.spyOn(handles.bridge.sessions, "request").mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );

    const pending = useAppStore.getState().hydrateTranscript(first.id);
    useAppStore.getState().applyTabs({ tabs: [], activeTabId: null });
    resolve?.({ messages: [] });
    await pending;

    expect(useAppStore.getState().transcripts[first.id]).toBeUndefined();
  });

  it("bounds the lazy blob cache", async () => {
    const handles = installBridge();
    const first = tab();
    useAppStore.getState().applyTabs({ tabs: [first], activeTabId: first.id });
    vi.spyOn(handles.bridge.sessions, "request").mockResolvedValue({ contents: "x" });

    for (let index = 0; index < MAX_RETAINED_BLOBS + 3; index += 1) {
      await useAppStore
        .getState()
        .loadBlob(first.id, { $blob: `C:/blobs/${index}.json`, bytes: 1 });
    }

    expect(Object.keys(useAppStore.getState().blobs)).toHaveLength(MAX_RETAINED_BLOBS);
  });
});

describe("transcript hydration from a spilled response", () => {
  it("hydrates a large messages.get answer through the blob reader", async () => {
    const handles = installBridge();
    const first = tab({ id: "session-spilled" });
    useAppStore.getState().applyTabs({ tabs: [first], activeTabId: first.id });
    const request = vi
      .spyOn(handles.bridge.sessions, "request")
      .mockImplementation(async (input: { method: string }) => {
        if (input.method === "messages.get") {
          return { $blob: "C:/blobs/messages.json", bytes: 120 };
        }
        if (input.method === "host.blobs.read") {
          return {
            path: "C:/blobs/messages.json",
            contents: JSON.stringify({
              messages: [{ role: "assistant", content: "recovered history" }],
            }),
            offset: 0,
            nextOffset: 120,
            size: 120,
            done: true,
          };
        }
        return {};
      });

    await useAppStore.getState().hydrateTranscript(first.id);

    const transcript = useAppStore.getState().transcripts[first.id];
    expect(transcript?.hydrated).toBe(true);
    expect(transcript?.items.length).toBeGreaterThan(0);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: "host.blobs.read" }));
  });

  it("reports a failed hydration instead of showing an empty session", async () => {
    const handles = installBridge();
    const first = tab({ id: "session-failed" });
    useAppStore.getState().applyTabs({ tabs: [first], activeTabId: first.id });
    const request = vi
      .spyOn(handles.bridge.sessions, "request")
      .mockRejectedValueOnce(new Error("the spilled result is gone"));

    await useAppStore.getState().hydrateTranscript(first.id);

    expect(useAppStore.getState().transcripts[first.id]?.hydrated).toBe(false);
    expect(useAppStore.getState().hint).toMatch(/spilled result is gone/);

    // The failure is not cached as success: the next attempt can recover.
    request.mockResolvedValueOnce({ messages: [] });
    await useAppStore.getState().hydrateTranscript(first.id);
    expect(useAppStore.getState().transcripts[first.id]?.hydrated).toBe(true);
  });
});
