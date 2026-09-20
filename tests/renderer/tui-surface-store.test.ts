import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { EMPTY_TUI_SURFACE, TUI_STATE_EVENT } from "../../src/shared/tui-surface";
import { installBridge } from "./fixtures";

/**
 * The renderer's TUI-surface store (plan step 17).
 *
 * What matters: a pushed `tui.state` replaces the whole surface, a pull on tab
 * activation is sanitized, resize/input are fire-and-forget requests, and the
 * frames never reach the transcript reducer.
 */

const TAB = "tab-1";

function stubRequest(impl: (method: string, params?: unknown) => Promise<unknown>) {
  const request = vi.fn((input: { method: string; params?: unknown }) =>
    impl(input.method, input.params),
  );
  (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
  return request;
}

function resetStore() {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    tabs: [
      {
        id: TAB,
        kind: "session",
        cwd: "C:/work/app",
        title: "app",
        sessionFile: null,
        status: "idle",
        createdAt: 1,
        lastActiveAt: 1,
        model: null,
      },
    ],
    activeTabId: TAB,
    transcripts: {},
    tuiSurfaces: {},
  });
}

beforeEach(() => {
  resetStore();
});

describe("tui surface store", () => {
  it("stores a pushed snapshot and sanitizes it", () => {
    useAppStore.getState().handleExtensionUiEvent(TAB, {
      event: TUI_STATE_EVENT,
      payload: {
        active: true,
        focus: "custom",
        custom: {
          seq: 1,
          width: 40,
          height: 1,
          lines: ["\x1b[32mhi\x1b[0m"],
          cursor: { row: 0, col: 1 },
        },
        junk: 42,
      },
    });
    const snapshot = useAppStore.getState().tuiSurfaces[TAB];
    expect(snapshot?.active).toBe(true);
    expect(snapshot?.focus).toBe("custom");
    expect(snapshot?.custom?.lines).toEqual(["\x1b[32mhi\x1b[0m"]);
    expect(snapshot?.custom?.cursor).toEqual({ row: 0, col: 1 });
  });

  it("fetches tui.state on demand and falls back to empty on failure", async () => {
    const request = stubRequest(async (method) =>
      method === "tui.state"
        ? { active: true, footer: { seq: 1, width: 10, height: 1, lines: ["f"] } }
        : {},
    );
    await useAppStore.getState().loadTuiSurface(TAB);
    expect(request).toHaveBeenCalledWith({ tabId: TAB, method: "tui.state" });
    expect(useAppStore.getState().tuiSurfaces[TAB]?.footer?.lines).toEqual(["f"]);

    stubRequest(async () => {
      throw new Error("no port");
    });
    await useAppStore.getState().loadTuiSurface(TAB);
    expect(useAppStore.getState().tuiSurfaces[TAB]).toEqual(EMPTY_TUI_SURFACE);
  });

  it("sends resize and input requests", () => {
    const request = stubRequest(async () => ({ ok: true }));
    useAppStore.getState().resizeTuiSurface(TAB, 12, 80);
    useAppStore.getState().sendTuiInput(TAB, "\x1b[A");
    expect(request).toHaveBeenCalledWith({
      tabId: TAB,
      method: "tui.resize",
      params: { rows: 12, cols: 80 },
    });
    expect(request).toHaveBeenCalledWith({
      tabId: TAB,
      method: "tui.input",
      params: { data: "\x1b[A" },
    });
  });

  it("never routes a surface frame into the transcript", () => {
    useAppStore.getState().applySessionEvents({
      tabId: TAB,
      seq: 1,
      events: [{ event: TUI_STATE_EVENT, payload: { active: true } }],
    });
    expect(useAppStore.getState().transcripts[TAB]).toBeUndefined();
    expect(useAppStore.getState().tuiSurfaces[TAB]?.active).toBe(true);
  });
});
