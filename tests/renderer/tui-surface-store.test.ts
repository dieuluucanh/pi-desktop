import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../src/renderer/src/state/app-store";
import { EMPTY_EXTENSION_UI } from "../../src/shared/extension-ui";
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

  it("never resizes a stopped tab into a host spawn", () => {
    const request = stubRequest(async () => ({ ok: true }));
    useAppStore.setState({
      tabs: useAppStore.getState().tabs.map((tab) => ({ ...tab, status: "stopped" })),
    });

    useAppStore.getState().resizeTuiSurface(TAB, 12, 80);
    expect(request).not.toHaveBeenCalled();

    useAppStore.setState({
      tabs: useAppStore.getState().tabs.map((tab) => ({ ...tab, status: "idle" })),
    });
    useAppStore.getState().resizeTuiSurface(TAB, 12, 80);
    expect(request).toHaveBeenCalledWith({
      tabId: TAB,
      method: "tui.resize",
      params: { rows: 12, cols: 80 },
    });
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

  it("treats a sleeping host as a normal status, not a shortcut error", async () => {
    const request = stubRequest(async () => {
      throw new Error(
        "Error invoking remote method 'pi:sessions:request': Error: The session is asleep. Activate the tab to wake its host.",
      );
    });
    useAppStore.setState({ shortcutsLoaded: false, shortcutsTabId: null });

    await useAppStore.getState().loadShortcuts();
    expect(request).toHaveBeenCalledWith({ tabId: TAB, method: "shortcuts.list" });
    expect(useAppStore.getState().shortcutsError).toBeNull();
    expect(useAppStore.getState().shortcutsLoaded).toBe(false);
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

/**
 * Escape parity (plan step 22).
 *
 * Desktop Escape must behave like terminal Pi's: the extension gets the key
 * first, and the run is stopped only when nothing consumed it. Every failure
 * mode (bridge error, timeout, a host that never answers) fails OPEN to `stopRun`
 * so Escape is never dead.
 */
describe("interruptRun", () => {
  const stopRun = vi.fn(async () => {});

  function sessionTab(id: string, status: string, kind = "session") {
    return {
      id,
      kind: kind as "session",
      cwd: "C:/work/app",
      title: id,
      sessionFile: null,
      status: status as "running",
      createdAt: 1,
      lastActiveAt: 1,
      model: null,
    };
  }

  beforeEach(() => {
    stopRun.mockReset();
    stopRun.mockResolvedValue(undefined);
    useAppStore.setState({ stopRun });
  });

  it("does not stop the run when the host consumed the key", async () => {
    const request = stubRequest(async (method) =>
      method === "tui.input" ? { ok: true, consumed: true, dispatched: true } : {},
    );
    useAppStore.setState({ tabs: [sessionTab("esc-consumed", "running")] });

    await useAppStore.getState().interruptRun("esc-consumed");

    expect(request).toHaveBeenCalledWith({
      tabId: "esc-consumed",
      method: "tui.input",
      params: { data: "\x1b" },
    });
    expect(stopRun).not.toHaveBeenCalled();
  });

  it("stops the run when nothing consumed the key", async () => {
    stubRequest(async () => ({ ok: true, consumed: false, dispatched: false }));
    useAppStore.setState({ tabs: [sessionTab("esc-unconsumed", "running")] });

    await useAppStore.getState().interruptRun("esc-unconsumed");

    expect(stopRun).toHaveBeenCalledWith("esc-unconsumed");
  });

  it("fails open when the bridge request rejects", async () => {
    stubRequest(async () => {
      throw new Error("host is gone");
    });
    useAppStore.setState({ tabs: [sessionTab("esc-rejected", "running")] });

    await useAppStore.getState().interruptRun("esc-rejected");

    expect(stopRun).toHaveBeenCalledWith("esc-rejected");
  });

  it("fails open when the host never answers", async () => {
    vi.useFakeTimers();
    try {
      stubRequest(() => new Promise(() => {}));
      useAppStore.setState({ tabs: [sessionTab("esc-timeout", "running")] });

      const pending = useAppStore.getState().interruptRun("esc-timeout");
      await vi.advanceTimersByTimeAsync(500);
      await pending;

      expect(stopRun).toHaveBeenCalledWith("esc-timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never stops a run for an idle, stopped or crashed tab", async () => {
    const request = stubRequest(async () => ({ ok: true, consumed: false }));
    useAppStore.setState({
      tabs: [
        sessionTab("esc-idle", "idle"),
        sessionTab("esc-stopped", "stopped"),
        sessionTab("esc-crashed", "crashed"),
      ],
    });

    await useAppStore.getState().interruptRun("esc-idle");
    await useAppStore.getState().interruptRun("esc-stopped");
    await useAppStore.getState().interruptRun("esc-crashed");

    expect(request).not.toHaveBeenCalled();
    expect(stopRun).not.toHaveBeenCalled();
  });

  it("forwards Escape for idle extension work", async () => {
    const request = stubRequest(async () => ({
      ok: true,
      consumed: true,
      dispatched: true,
    }));
    useAppStore.setState({
      tabs: [sessionTab("esc-manual", "idle")],
      extensionUi: {
        "esc-manual": {
          ...EMPTY_EXTENSION_UI,
          working: {
            message: "🔍 Reviewing plan…",
            visible: null,
            frames: null,
            intervalMs: null,
          },
        },
      },
    });

    await useAppStore.getState().interruptRun("esc-manual");

    expect(request).toHaveBeenCalledWith({
      tabId: "esc-manual",
      method: "tui.input",
      params: { data: "\x1b" },
    });
    expect(stopRun).not.toHaveBeenCalled();
  });

  it("does not stop an idle extension-work tab when the key is unconsumed", async () => {
    const request = stubRequest(async () => ({
      ok: true,
      consumed: false,
      dispatched: true,
    }));
    useAppStore.setState({
      tabs: [sessionTab("esc-manual-idle", "idle")],
      extensionUi: {
        "esc-manual-idle": {
          ...EMPTY_EXTENSION_UI,
          working: {
            message: "🔍 Reviewing plan…",
            visible: null,
            frames: null,
            intervalMs: null,
          },
        },
      },
    });

    await useAppStore.getState().interruptRun("esc-manual-idle");

    expect(request).toHaveBeenCalled();
    expect(stopRun).not.toHaveBeenCalled();
  });

  it("ignores a non-session tab", async () => {
    const request = stubRequest(async () => ({ ok: true, consumed: false }));
    useAppStore.setState({ tabs: [sessionTab("esc-terminal", "running", "terminal")] });

    await useAppStore.getState().interruptRun("esc-terminal");

    expect(request).not.toHaveBeenCalled();
    expect(stopRun).not.toHaveBeenCalled();
  });

  it("dedupes a repeated Escape inside the window", async () => {
    const request = stubRequest(async () => ({ ok: true, consumed: false, dispatched: true }));
    useAppStore.setState({ tabs: [sessionTab("esc-repeat", "running")] });

    await useAppStore.getState().interruptRun("esc-repeat");
    await useAppStore.getState().interruptRun("esc-repeat");

    expect(request).toHaveBeenCalledTimes(1);
    expect(stopRun).toHaveBeenCalledTimes(1);
  });
});
