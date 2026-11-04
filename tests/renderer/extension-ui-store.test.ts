import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { EMPTY_EXTENSION_UI } from "../../src/shared/extension-ui";
import { installBridge } from "./fixtures";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

/**
 * The renderer's extension-UI store (plan step 16).
 *
 * What matters: a dialog is queued and answered with the exact id the host
 * minted, a host-issued editor edit is applied once (never on every state push),
 * and extension UI events never leak into the transcript.
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
    extensionUi: {},
    extensionDialogs: [],
    extensionNotifications: [],
    muteTarget: null,
    notificationCooldowns: {},
  });
}

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
});

describe("extension UI state", () => {
  it("stores an oi.state snapshot and applies an editor command exactly once", () => {
    const store = useAppStore.getState();
    store.handleExtensionUiEvent(TAB, {
      event: "oi.state",
      payload: {
        statuses: { build: "ok" },
        working: { message: "Thinking" },
        editor: { seq: 1, text: "hello" },
      },
    });
    expect(useAppStore.getState().extensionUi[TAB]).toMatchObject({
      statuses: { build: "ok" },
      working: { message: "Thinking" },
    });
    expect(useAppStore.getState().prefs.drafts[TAB]).toBe("hello");

    // A later push repeating the same edit must not clobber typed text.
    useAppStore.getState().setDraft(TAB, "hello world");
    useAppStore.getState().handleExtensionUiEvent(TAB, {
      event: "oi.state",
      payload: { editor: { seq: 1, text: "hello" } },
    });
    expect(useAppStore.getState().prefs.drafts[TAB]).toBe("hello world");

    // A newer edit is applied.
    useAppStore.getState().handleExtensionUiEvent(TAB, {
      event: "oi.state",
      payload: { editor: { seq: 2, text: "replaced" } },
    });
    expect(useAppStore.getState().prefs.drafts[TAB]).toBe("replaced");
  });

  it("fetches oi.state on demand and falls back to empty on failure", async () => {
    const request = stubRequest(async (method) =>
      method === "oi.state" ? { statuses: { a: "b" } } : {},
    );
    await useAppStore.getState().loadExtensionUi(TAB);
    expect(request).toHaveBeenCalledWith({ tabId: TAB, method: "oi.state" });
    expect(useAppStore.getState().extensionUi[TAB]?.statuses).toEqual({ a: "b" });

    stubRequest(async () => {
      throw new Error("no port");
    });
    await useAppStore.getState().loadExtensionUi(TAB);
    expect(useAppStore.getState().extensionUi[TAB]).toEqual(EMPTY_EXTENSION_UI);
  });
});

describe("extension dialogs", () => {
  it("queues a dialog and answers it with oi.respond", async () => {
    const request = stubRequest(async () => ({ delivered: true }));
    useAppStore.getState().handleExtensionUiEvent(TAB, {
      event: "oi.request",
      payload: {
        id: "ui-7",
        method: "select",
        params: { title: "Pick", options: ["a", "b"], timeout: 5000 },
      },
    });
    const dialog = useAppStore.getState().extensionDialogs[0];
    expect(dialog).toMatchObject({ id: "ui-7", method: "select", options: ["a", "b"], tabId: TAB });

    await useAppStore.getState().answerExtensionDialog(dialog!, { value: "b" });
    expect(useAppStore.getState().extensionDialogs).toHaveLength(0);
    expect(request).toHaveBeenCalledWith({
      tabId: TAB,
      method: "oi.respond",
      params: { id: "ui-7", value: "b" },
    });
  });

  it("ignores a provider-login prompt and a malformed request", () => {
    useAppStore.getState().handleExtensionUiEvent(TAB, {
      event: "oi.request",
      payload: { id: "p", method: "input", params: { source: "provider-login", loginId: "l" } },
    });
    useAppStore.getState().handleExtensionUiEvent(TAB, {
      event: "oi.request",
      payload: { method: "select", params: {} },
    });
    expect(useAppStore.getState().extensionDialogs).toHaveLength(0);
  });

  it("activates the owning tab when a background dialog arrives", () => {
    useAppStore.setState({ activeTabId: "other", view: "welcome" });
    const activate = vi.spyOn(useAppStore.getState(), "activateTab").mockResolvedValue(undefined);
    useAppStore.getState().handleExtensionUiEvent(TAB, {
      event: "oi.request",
      payload: { id: "ui-8", method: "confirm", params: { title: "?", message: "Sure?" } },
    });
    expect(activate).toHaveBeenCalledWith(TAB);
    activate.mockRestore();
  });
});

describe("notifications, theme and shutdown", () => {
  it("purges a closed tab's queued dialogs and their timeout", async () => {
    vi.useFakeTimers();
    try {
      const request = stubRequest(async () => ({ ok: true }));
      useAppStore.getState().handleExtensionUiEvent(TAB, {
        event: "oi.request",
        payload: {
          id: "ui-close",
          method: "select",
          params: { title: "Pick", options: ["a"], timeout: 1000 },
        },
      });
      expect(useAppStore.getState().extensionDialogs).toHaveLength(1);

      await useAppStore.getState().closeTab(TAB);
      expect(useAppStore.getState().extensionDialogs).toHaveLength(0);

      vi.advanceTimersByTime(1100);
      expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ method: "oi.respond" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("appends notifications to the history", () => {
    useAppStore.getState().handleExtensionUiEvent(TAB, {
      event: "oi.notify",
      payload: { id: "n1", message: "Installed", type: "warning" },
    });
    expect(useAppStore.getState().extensionNotifications[0]).toMatchObject({
      id: "n1",
      message: "Installed",
      type: "warning",
      tabId: TAB,
    });
    useAppStore.getState().clearExtensionNotifications();
    expect(useAppStore.getState().extensionNotifications).toHaveLength(0);
  });

  it("archives a muted notification but suppresses its toast", () => {
    const notification = {
      id: "n-muted",
      message: "Workflow plan: thinking xhigh → high (model does not support xhigh).",
      type: "warning" as const,
      tabId: TAB,
      at: 1,
    };
    useAppStore.getState().muteNotification(notification, "template");
    expect(useAppStore.getState().prefs.notifications.muted).toHaveLength(1);

    useAppStore.getState().handleExtensionUiEvent(TAB, {
      event: "oi.notify",
      payload: { id: "n-muted", message: notification.message, type: "warning" },
    });
    expect(useAppStore.getState().extensionNotifications[0]).toMatchObject({
      message: notification.message,
    });
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("toasts once, suppresses an identical repeat, then allows it after the window", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const event = {
        event: "oi.notify",
        payload: { id: "n-repeat", message: "Same warning", type: "warning" },
      };
      useAppStore.getState().handleExtensionUiEvent(TAB, event);
      useAppStore.getState().handleExtensionUiEvent(TAB, event);
      expect(toast.warning).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5 * 60_000 + 1);
      useAppStore.getState().handleExtensionUiEvent(TAB, event);
      expect(toast.warning).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the mute dialog and unmutes a notification", () => {
    const notification = {
      id: "n-dialog",
      message: "Installed workflow",
      type: "warning" as const,
      tabId: TAB,
      at: 1,
    };
    useAppStore.getState().openMuteDialog(notification);
    expect(useAppStore.getState().muteTarget).toEqual(notification);

    useAppStore.getState().muteNotification(notification, "exact");
    expect(useAppStore.getState().muteTarget).toBeNull();
    expect(useAppStore.getState().prefs.notifications.muted).toHaveLength(1);

    useAppStore.getState().unmuteNotification(notification);
    expect(useAppStore.getState().prefs.notifications.muted).toHaveLength(0);
  });

  it("removes one rule by id or all rules", () => {
    const first = {
      id: "n-one",
      message: "one",
      type: "warning" as const,
      tabId: TAB,
      at: 1,
    };
    const second = { ...first, id: "n-two", message: "two" };
    useAppStore.getState().muteNotification(first, "exact");
    useAppStore.getState().muteNotification(second, "exact");
    const [newest, oldest] = useAppStore.getState().prefs.notifications.muted;
    expect(newest && oldest).toBeTruthy();

    useAppStore.getState().unmuteNotificationRule(oldest!.id);
    expect(useAppStore.getState().prefs.notifications.muted).toHaveLength(1);
    useAppStore.getState().unmuteAllNotifications();
    expect(useAppStore.getState().prefs.notifications.muted).toHaveLength(0);
  });

  it("routes a theme switch to setActiveTheme", () => {
    const setActiveTheme = vi
      .spyOn(useAppStore.getState(), "setActiveTheme")
      .mockResolvedValue(true);
    useAppStore.getState().handleExtensionUiEvent(TAB, {
      event: "oi.theme",
      payload: { name: "light" },
    });
    expect(setActiveTheme).toHaveBeenCalledWith("light");
    setActiveTheme.mockRestore();
  });

  it("closes the tab when an extension asks to shut down", () => {
    const closeTab = vi.spyOn(useAppStore.getState(), "closeTab").mockResolvedValue(undefined);
    useAppStore.getState().handleExtensionUiEvent(TAB, {
      event: "session.shutdown_requested",
      payload: {},
    });
    expect(closeTab).toHaveBeenCalledWith(TAB);
    closeTab.mockRestore();
  });
});

describe("applySessionEvents routing", () => {
  it("puts notify output in the transcript but keeps dialogs and state out", () => {
    useAppStore.getState().applySessionEvents({
      tabId: TAB,
      seq: 1,
      events: [
        { event: "oi.notify", payload: { id: "n", message: "hi", type: "info" } },
        {
          event: "message_end",
          payload: { message: { id: "m1", role: "assistant", content: "ok" } },
        },
      ],
    });
    // The archive still receives every notification.
    expect(useAppStore.getState().extensionNotifications).toHaveLength(1);
    const items = useAppStore.getState().transcripts[TAB]?.items ?? [];
    expect(items).toHaveLength(2);
    const notice = items[0];
    expect(notice?.kind).toBe("notice");
    if (notice?.kind !== "notice") throw new Error("expected a notify notice");
    expect(notice.notice).toMatchObject({ event: "oi.notify", severity: "info", text: "hi" });
    expect(items[1]?.kind).toBe("message");
  });
});

describe("extension completion bridge", () => {
  it("sanitizes host suggestions and the applied result", async () => {
    stubRequest(async (method) => {
      if (method === "completion.suggest") {
        return { prefix: "#do", items: [{ value: "#doc", label: "#doc", description: "Excel" }] };
      }
      return { lines: ["#doc "], cursorLine: 0, cursorCol: 5 };
    });
    const suggestions = await useAppStore.getState().extensionCompletion(TAB, {
      lines: ["#do"],
      cursorLine: 0,
      cursorCol: 3,
      base: null,
    });
    expect(suggestions).toEqual({
      prefix: "#do",
      items: [{ value: "#doc", label: "#doc", description: "Excel" }],
    });

    const applied = await useAppStore.getState().extensionApplyCompletion(TAB, {
      lines: ["#do"],
      cursorLine: 0,
      cursorCol: 3,
      item: { value: "#doc", label: "#doc" },
      prefix: "#do",
    });
    expect(applied).toEqual({ lines: ["#doc "], cursorLine: 0, cursorCol: 5 });
  });

  it("returns null for a malformed or failed response", async () => {
    stubRequest(async () => {
      throw new Error("no providers");
    });
    expect(
      await useAppStore.getState().extensionCompletion(TAB, {
        lines: ["a"],
        cursorLine: 0,
        cursorCol: 1,
        base: null,
      }),
    ).toBeNull();

    stubRequest(async () => ({ lines: "not an array" }));
    expect(
      await useAppStore.getState().extensionApplyCompletion(TAB, {
        lines: ["a"],
        cursorLine: 0,
        cursorCol: 1,
        item: { value: "b", label: "b" },
        prefix: "a",
      }),
    ).toBeNull();
  });
});
