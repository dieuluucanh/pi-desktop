import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionTabStrip } from "../../src/renderer/src/layout/SessionTabStrip";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { SessionTabsEnvelope, TabRecord } from "../../src/shared/session-ipc";
import { TUI_STATE_EVENT } from "../../src/shared/tui-surface";
import { installBridge } from "./fixtures";

const TAB = "startup-close-tab";
const PREVIOUS = "previous-live-tab";
const PASSIVE_TAB = `passive-close-tab-${Date.now()}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function tab(id: string, status: TabRecord["status"] = "idle"): TabRecord {
  return {
    id,
    kind: "session",
    cwd: "C:/work/project",
    title: id,
    sessionFile: null,
    status,
    createdAt: 1,
    lastActiveAt: 1,
    model: null,
  };
}

function envelope(tabs: TabRecord[], activeTabId: string | null): SessionTabsEnvelope {
  return { tabs, activeTabId };
}

function setup() {
  const { bridge, hostRequests } = installBridge();
  useAppStore.setState({
    view: "session",
    project: { path: "C:/work/project", name: "project" },
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    tabs: [tab(PREVIOUS), tab(TAB, "starting")],
    activeTabId: TAB,
    hint: null,
    trustPrompt: null,
    transcripts: {},
    sessionStates: {},
    tuiSurfaces: {},
    extensionUi: {},
    contributions: {},
  });
  return { bridge, hostRequests };
}

beforeEach(() => {
  setup();
});

describe("renderer close during startup", () => {
  it("closes once and fences deferred create/activate continuations", async () => {
    const { bridge, hostRequests } = setup();
    const create = deferred<SessionTabsEnvelope>();
    const activate = deferred<SessionTabsEnvelope>();
    const close = deferred<SessionTabsEnvelope>();
    (bridge.sessions as unknown as { create: unknown }).create = vi.fn(() => create.promise);
    (bridge.sessions as unknown as { activate: unknown }).activate = vi.fn(() => activate.promise);
    const closeCall = vi.fn(() => close.promise);
    (bridge.sessions as unknown as { close: unknown }).close = closeCall;

    render(<SessionTabStrip />);
    const createTask = useAppStore.getState().createSessionTab();
    const activateTask = useAppStore.getState().activateTab(TAB);
    fireEvent.click(screen.getByRole("button", { name: `Close ${TAB}` }));
    fireEvent.click(screen.getByRole("button", { name: `Close ${TAB}` }));

    await waitFor(() => expect(closeCall).toHaveBeenCalledTimes(1));
    expect(hostRequests.map((request) => [request.tabId, request.method])).toEqual([]);
    close.resolve(envelope([tab(PREVIOUS)], PREVIOUS));
    await waitFor(() => expect(useAppStore.getState().activeTabId).toBe(PREVIOUS));

    // Old lifecycle completions arrive after close settled. They are not allowed
    // to focus the stale tab, hydrate it, or report its intentional cancellation.
    create.resolve({
      ...envelope([tab(PREVIOUS)], PREVIOUS),
      cancelled: { reason: "tab-closed", tabId: TAB },
    });
    activate.resolve(envelope([tab(PREVIOUS)], PREVIOUS));
    await Promise.all([createTask, activateTask]);

    expect(useAppStore.getState().tabs.map(({ id }) => id)).toEqual([PREVIOUS]);
    expect(useAppStore.getState().activeTabId).toBe(PREVIOUS);
    expect(useAppStore.getState().view).toBe("session");
    expect(useAppStore.getState().hint).toBeNull();
    expect(useAppStore.getState().trustPrompt).toBeNull();
    expect(useAppStore.getState().transcripts[TAB]).toBeUndefined();
    expect(hostRequests.map((request) => [request.tabId, request.method])).toEqual([]);
  });

  it("does not turn passive cancellation or late TUI work into empty cached state", async () => {
    const { bridge } = setup();
    useAppStore.setState({
      tabs: [tab(PREVIOUS), tab(PASSIVE_TAB, "starting")],
      activeTabId: PASSIVE_TAB,
    });
    const tui = deferred<unknown>();
    const tuiFailure = deferred<unknown>();
    let tuiCalls = 0;
    const request = vi.fn(({ method }: { tabId: string; method: string }) =>
      method === "tui.state"
        ? tuiCalls++ === 0
          ? tui.promise
          : tuiFailure.promise
        : Promise.resolve({ cancelled: { reason: "tab-closed", tabId: PASSIVE_TAB } }),
    );
    (bridge.sessions as unknown as { request: unknown }).request = request;

    const pull = useAppStore.getState().loadTuiSurface(PASSIVE_TAB);
    const failedPull = useAppStore.getState().loadTuiSurface(PASSIVE_TAB);
    await useAppStore.getState().loadExtensionUi(PASSIVE_TAB);
    await useAppStore.getState().hydrateTranscript(PASSIVE_TAB);
    useAppStore.getState().applySessionEvents({
      tabId: PASSIVE_TAB,
      seq: 1,
      events: [{ event: TUI_STATE_EVENT, payload: { active: true } }],
    });
    useAppStore.getState().applySessionState({ tabId: PASSIVE_TAB, state: { sessionId: "late" } });
    expect(useAppStore.getState().tabs.map(({ id }) => id)).toContain(PASSIVE_TAB);
    useAppStore.getState().applyTabs(envelope([tab(PREVIOUS)], PREVIOUS));
    useAppStore.getState().handleExtensionUiEvent(PASSIVE_TAB, {
      event: TUI_STATE_EVENT,
      payload: { active: true },
    });
    tui.resolve({ active: true, footer: { seq: 1, width: 2, height: 1, lines: ["late"] } });
    tuiFailure.reject(new Error("late host failure"));
    await Promise.all([pull, failedPull]);

    expect(request.mock.calls.map(([input]) => input.method)).toEqual([
      "tui.state",
      "tui.state",
      "oi.state",
      "messages.get",
    ]);
    expect(useAppStore.getState().transcripts[PASSIVE_TAB]).toBeUndefined();
    expect(useAppStore.getState().tuiSurfaces[PASSIVE_TAB]).toBeUndefined();
    expect(useAppStore.getState().sessionStates[PASSIVE_TAB]).toBeUndefined();
    expect(useAppStore.getState().tabs.map(({ id }) => id)).toEqual([PREVIOUS]);
  });

  it("uses the empty-shell fallback when the closing tab was the last tab", async () => {
    const { bridge } = setup();
    useAppStore.setState({ tabs: [tab(PASSIVE_TAB, "starting")], activeTabId: PASSIVE_TAB });
    (bridge.sessions as unknown as { close: unknown }).close = async () => envelope([], null);

    render(<SessionTabStrip />);
    fireEvent.click(screen.getByRole("button", { name: `Close ${PASSIVE_TAB}` }));
    await waitFor(() => expect(useAppStore.getState().tabs).toEqual([]));
    expect(useAppStore.getState().activeTabId).toBeNull();
  });

  it("releases a failed live close for retry and preserves real failures", async () => {
    const { bridge } = setup();
    const failure = new Error("close transport failed");
    const close = vi
      .fn<() => Promise<SessionTabsEnvelope>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(envelope([tab(PREVIOUS)], PREVIOUS));
    (bridge.sessions as unknown as { close: unknown }).close = close;

    await useAppStore.getState().closeTab(TAB);
    expect(useAppStore.getState().tabs.some(({ id }) => id === TAB)).toBe(true);
    expect(useAppStore.getState().hint).toContain("close transport failed");
    await useAppStore.getState().closeTab(TAB);
    expect(close).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().tabs.map(({ id }) => id)).toEqual([PREVIOUS]);
  });
});
