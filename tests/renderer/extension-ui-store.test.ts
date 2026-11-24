import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { useAppStore } from "../../src/renderer/src/state/app-store";
import { buildContributionSnapshot } from "../../src/shared/extension-contributions-view";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { EMPTY_EXTENSION_UI } from "../../src/shared/extension-ui";
import { isNotificationSuppressed } from "../../src/shared/notifications";
import { installBridge } from "./fixtures";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
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
    notifications: [],
    muteTarget: null,
    notificationCooldowns: {},
  });
}

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
});

describe("dialog focus policy (2026-11-06 tab-switch plan)", () => {
  const OTHER = "tab-2";

  function twoTabs(): void {
    useAppStore.setState({
      tabs: [
        ...useAppStore.getState().tabs,
        {
          id: OTHER,
          kind: "session",
          cwd: "C:/work/other",
          title: "other",
          sessionFile: null,
          status: "idle",
          createdAt: 1,
          lastActiveAt: 1,
          model: null,
        },
      ],
    });
  }

  it("badges a background dialog instead of taking the window while streaming", () => {
    twoTabs();
    useAppStore.setState({ sessionStates: { [TAB]: { streaming: true } }, dialogAttention: {} });

    useAppStore.getState().applySessionEvents({
      tabId: OTHER,
      seq: 1,
      events: [
        {
          event: "oi.request",
          payload: { id: "d1", method: "confirm", params: { title: "?", message: "?" } },
        },
      ],
    });

    expect(useAppStore.getState().activeTabId).toBe(TAB);
    expect(useAppStore.getState().dialogAttention[OTHER]).toBe(true);
    // The dialog itself still belongs to the tab that asked, so answering it
    // never gets mixed up with the visible session.
    expect(useAppStore.getState().extensionDialogs.map((dialog) => dialog.tabId)).toEqual([OTHER]);
  });

  it("clears the badge when the user opens the tab", async () => {
    twoTabs();
    useAppStore.setState({ dialogAttention: { [OTHER]: true } });

    await useAppStore.getState().activateTab(OTHER);

    expect(useAppStore.getState().dialogAttention[OTHER]).toBeUndefined();
  });
});

describe("extension UI state", () => {
  const drafts = (tabId = TAB): string | undefined => useAppStore.getState().prefs.drafts[tabId];
  const push = (editor: Record<string, unknown> | null): void => {
    useAppStore.getState().handleExtensionUiEvent(TAB, {
      event: "oi.state",
      payload: editor === null ? {} : { editor },
    });
  };

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

  it("applies a new host's low sequence after an old host's high one", () => {
    push({ seq: 9, text: "old host", binding: "host-old" });
    expect(drafts()).toBe("old host");

    // The same binding repeating its sequence still cannot clobber the user.
    useAppStore.getState().setDraft(TAB, "typed after");
    push({ seq: 9, text: "old host", binding: "host-old" });
    expect(drafts()).toBe("typed after");

    // A replacement host restarts at 1: the binding decides, not the number.
    push({ seq: 1, text: "new host", binding: "host-new" });
    expect(drafts()).toBe("new host");
  });

  it("ignores an out-of-order frame from a retired binding", () => {
    push({ seq: 9, text: "old host", binding: "host-order-old" });
    push({ seq: 1, text: "new host", binding: "host-order-new" });
    expect(drafts()).toBe("new host");

    // A late frame from the previous runner must not replay over the new one.
    push({ seq: 10, text: "stale replay", binding: "host-order-old" });
    expect(drafts()).toBe("new host");
  });

  it("resets fencing on a reload/replace so the replacement runner can edit", () => {
    stubRequest(async () => ({}));
    push({ seq: 7, text: "before reload", binding: "runner-reload-a" });
    expect(drafts()).toBe("before reload");

    // A reload keeps the session id but replaces the runner: the epoch advances
    // and the tab's extension UI (including its binding) is dropped.
    useAppStore.getState().applySessionEvents({
      tabId: TAB,
      seq: 1,
      sessionEpoch: 2,
      events: [{ event: "session.reloaded" }],
    });

    // The outgoing binding is fenced; the replacement's own low sequence lands.
    push({ seq: 8, text: "stale old runner", binding: "runner-reload-a" });
    expect(drafts()).toBe("before reload");
    push({ seq: 1, text: "after reload", binding: "runner-reload-b" });
    expect(drafts()).toBe("after reload");
  });

  it("resets fencing when an extension replaces the session", () => {
    stubRequest(async () => ({}));
    useAppStore.setState({
      sessionStates: { [TAB]: { sessionId: "session-a" } as never },
    });
    push({ seq: 4, text: "before switch", binding: "session-binding-a" });
    expect(drafts()).toBe("before switch");

    useAppStore.getState().applySessionEvents({
      tabId: TAB,
      seq: 1,
      events: [{ event: "session_replaced", payload: { sessionId: "session-b" } }],
    });

    push({ seq: 1, text: "after switch", binding: "session-binding-b" });
    expect(drafts()).toBe("after switch");
  });

  it("applies a background tab's edit to that tab only", () => {
    const OTHER = "tab-background";
    useAppStore.setState({
      tabs: [
        ...useAppStore.getState().tabs,
        {
          id: OTHER,
          kind: "session",
          cwd: "C:/work/other",
          title: "other",
          sessionFile: null,
          status: "idle",
          createdAt: 1,
          lastActiveAt: 1,
          model: null,
        },
      ],
      prefs: { ...useAppStore.getState().prefs, drafts: { [TAB]: "focused draft" } },
    });

    useAppStore.getState().handleExtensionUiEvent(OTHER, {
      event: "oi.state",
      payload: { editor: { seq: 1, text: "background prefill", binding: "bg-host" } },
    });

    expect(drafts(OTHER)).toBe("background prefill");
    expect(drafts(TAB)).toBe("focused draft");
    expect(useAppStore.getState().activeTabId).toBe(TAB);
  });

  it("acknowledges a consumed edit so a reconnect cannot replay it", () => {
    const request = stubRequest(async () => ({ ok: true }));
    push({ seq: 3, text: "hello", binding: "ack-host" });
    expect(request).toHaveBeenCalledWith({
      tabId: TAB,
      method: "oi.editorConsumed",
      params: { seq: 3, binding: "ack-host" },
    });
  });

  it("never applies a pending edit from a reconnecting oi.state read", async () => {
    const request = stubRequest(async (method) =>
      method === "oi.state"
        ? { editor: { seq: 3, text: "stale prefill", binding: "stale-host" } }
        : {},
    );
    useAppStore.setState({
      prefs: { ...useAppStore.getState().prefs, drafts: { [TAB]: "restored draft" } },
    });

    await useAppStore.getState().loadExtensionUi(TAB);

    // The read keeps the restored draft and spends the command instead.
    expect(drafts()).toBe("restored draft");
    expect(request).toHaveBeenCalledWith({
      tabId: TAB,
      method: "oi.editorConsumed",
      params: { seq: 3, binding: "stale-host" },
    });
  });

  it("keeps an undelivered prefill when there is no draft to protect", async () => {
    stubRequest(async (method) =>
      method === "oi.state" ? { editor: { seq: 1, text: "prefill", binding: "prefill-host" } } : {},
    );

    await useAppStore.getState().loadExtensionUi(TAB);

    expect(drafts()).toBe("prefill");
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
  it("retracts a visible dialog when the host cancels it (row 28)", () => {
    stubRequest(async () => ({ ok: true }));
    useAppStore.getState().handleExtensionUiEvent(TAB, {
      event: "oi.request",
      payload: { id: "ui-abort", method: "input", params: { title: "Name", timeout: 5000 } },
    });
    expect(useAppStore.getState().extensionDialogs).toHaveLength(1);

    useAppStore.getState().handleExtensionUiEvent(TAB, {
      event: "oi.cancel",
      payload: { id: "ui-abort" },
    });
    expect(useAppStore.getState().extensionDialogs).toHaveLength(0);
    // A cancel for an unknown/duplicate id is a no-op, never a crash.
    useAppStore.getState().handleExtensionUiEvent(TAB, {
      event: "oi.cancel",
      payload: { id: "ui-abort" },
    });
    useAppStore.getState().handleExtensionUiEvent(TAB, {
      event: "oi.cancel",
      payload: { id: 5 },
    });
    expect(useAppStore.getState().extensionDialogs).toHaveLength(0);
  });

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
    expect(useAppStore.getState().notifications[0]).toMatchObject({
      id: "n1",
      message: "Installed",
      type: "warning",
      class: "warning",
      tabId: TAB,
      action: null,
    });
    useAppStore.getState().clearNotifications();
    expect(useAppStore.getState().notifications).toHaveLength(0);
  });

  it("archives an info notification but suppresses it by default", () => {
    useAppStore.getState().handleExtensionUiEvent(TAB, {
      event: "oi.notify",
      payload: { id: "n-info", message: "Server logs ready (local)", type: "info" },
    });
    const [entry] = useAppStore.getState().notifications;
    expect(entry).toMatchObject({ class: "info" });
    expect(isNotificationSuppressed(entry!, useAppStore.getState().prefs.notifications)).toBe(true);
    expect(toast.info).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("toggles a class without dropping the mute rules", () => {
    const notification = {
      id: "n-class",
      message: "Installed workflow",
      type: "warning" as const,
      class: "warning" as const,
      tabId: TAB,
      at: 1,
      action: null,
    };
    useAppStore.getState().muteNotification(notification, "exact");
    useAppStore.getState().setNotificationClass("info", true);

    const prefs = useAppStore.getState().prefs.notifications;
    expect(prefs.classes.info).toBe(true);
    expect(prefs.muted).toHaveLength(1);
  });

  it("archives a muted notification but suppresses its toast", () => {
    const notification = {
      id: "n-muted",
      message: "Workflow plan: thinking xhigh → high (model does not support xhigh).",
      type: "warning" as const,
      class: "warning" as const,
      tabId: TAB,
      at: 1,
      action: null,
    };
    useAppStore.getState().muteNotification(notification, "template");
    expect(useAppStore.getState().prefs.notifications.muted).toHaveLength(1);

    useAppStore.getState().handleExtensionUiEvent(TAB, {
      event: "oi.notify",
      payload: { id: "n-muted", message: notification.message, type: "warning" },
    });
    expect(useAppStore.getState().notifications[0]).toMatchObject({
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
      class: "warning" as const,
      tabId: TAB,
      at: 1,
      action: null,
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
      class: "warning" as const,
      tabId: TAB,
      at: 1,
      action: null,
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
    expect(useAppStore.getState().notifications).toHaveLength(1);
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

describe("contribution read fencing and honest action results", () => {
  const snapshotOf = (label: string) =>
    buildContributionSnapshot(
      [
        {
          ownerId: "fixture.ext",
          epoch: 0,
          revision: 1,
          contributions: [
            {
              id: "mode",
              kind: "mode",
              slot: "mode",
              label,
              tone: "accent",
              order: 0,
              actions: [],
            },
          ],
        },
      ],
      { supported: true, updatedAt: 1 },
    );

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("a delayed contributions load cannot overwrite a newer push", async () => {
    const oi = deferred<unknown>();
    const contributions = deferred<unknown>();
    stubRequest((method) =>
      method === "oi.state"
        ? oi.promise
        : method === "contributions.state"
          ? contributions.promise
          : Promise.resolve({}),
    );
    const loading = useAppStore.getState().loadExtensionUi(TAB);
    // The host pushes a newer snapshot while the read is still pending.
    useAppStore.getState().handleExtensionUiEvent(TAB, {
      event: "contributions.state",
      payload: snapshotOf("Pushed"),
    } as never);
    contributions.resolve(snapshotOf("Stale"));
    oi.resolve({});
    await loading;
    expect(useAppStore.getState().contributions[TAB]?.contributions[0]?.text).toBe("Pushed");
  });

  it("the later of two overlapping loads wins", async () => {
    const pending: Array<ReturnType<typeof deferred<unknown>>> = [];
    stubRequest((method) => {
      if (method === "oi.state") return Promise.resolve({});
      const next = deferred<unknown>();
      pending.push(next);
      return next.promise;
    });
    const loadA = useAppStore.getState().loadExtensionUi(TAB);
    // Wait until A has actually issued its contributions request, so the two
    // loads overlap in a defined order.
    await vi.waitFor(() => expect(pending.length).toBe(1));
    const loadB = useAppStore.getState().loadExtensionUi(TAB);
    await vi.waitFor(() => expect(pending.length).toBe(2));
    pending[1]!.resolve(snapshotOf("Newer"));
    await loadB;
    // The earlier load settles last; its token is stale, so it must not win.
    pending[0]!.resolve(snapshotOf("Older"));
    await loadA;
    expect(useAppStore.getState().contributions[TAB]?.contributions[0]?.text).toBe("Newer");
  });

  it("a failed refresh keeps the last valid snapshot", async () => {
    useAppStore.setState({ contributions: { [TAB]: snapshotOf("Still live") } });
    stubRequest(async (method) => {
      if (method === "contributions.state") throw new Error("host busy");
      return {};
    });
    await useAppStore.getState().refreshContributions(TAB);
    expect(useAppStore.getState().contributions[TAB]?.contributions[0]?.text).toBe("Still live");
  });

  it("a read completing after the tab closed does not resurrect its state", async () => {
    const pending = deferred<unknown>();
    stubRequest((method) => (method === "oi.state" ? Promise.resolve({}) : pending.promise));
    const loading = useAppStore.getState().loadExtensionUi(TAB);
    await Promise.resolve();
    useAppStore.getState().applyTabs({ tabs: [], activeTabId: null } as never, {
      adoptSelection: true,
    });
    pending.resolve(snapshotOf("Ghost"));
    await loading;
    expect(useAppStore.getState().contributions[TAB]).toBeUndefined();
  });

  const runIn = (response: unknown) =>
    stubRequest(async (method) => {
      if (method === "contributions.run") return response;
      return snapshotOf("After");
    });

  it("accepts only an error-free acknowledgement", async () => {
    runIn({ ran: true });
    expect(
      await useAppStore.getState().runContributionAction(TAB, "fixture.ext", "mode-cycle"),
    ).toBe(true);

    for (const [response, expected] of [
      [{ ran: true, error: "handler threw" }, false],
      [{ ran: false }, false],
      [{}, false],
      [undefined, false],
    ] as const) {
      runIn(response);
      expect(
        await useAppStore.getState().runContributionAction(TAB, "fixture.ext", "mode-cycle"),
      ).toBe(expected);
    }
  });

  it("refreshes authoritative state but never replays a refusal", async () => {
    const request = stubRequest(async (method) =>
      method === "contributions.run" ? { ran: false } : snapshotOf("After"),
    );
    const accepted = await useAppStore
      .getState()
      .runContributionAction(TAB, "fixture.ext", "mode-cycle");
    expect(accepted).toBe(false);
    const methods = request.mock.calls.map(([input]) => (input as { method: string }).method);
    // One attempt, then a read of the live snapshot: no automatic retry.
    expect(methods.filter((method) => method === "contributions.run")).toHaveLength(1);
    await vi.waitFor(() => expect(methods).toContain("contributions.state"));
  });

  it("suppresses a duplicate activation while one is pending", async () => {
    const gate = deferred<unknown>();
    const request = stubRequest((method) =>
      method === "contributions.run" ? gate.promise : Promise.resolve(snapshotOf("After")),
    );
    const first = useAppStore.getState().runContributionAction(TAB, "fixture.ext", "mode-cycle");
    await Promise.resolve();
    const second = useAppStore.getState().runContributionAction(TAB, "fixture.ext", "mode-cycle");
    expect(await second).toBe(false);
    gate.resolve({ ran: true });
    expect(await first).toBe(true);
    expect(
      request.mock.calls.filter(
        ([input]) => (input as { method: string }).method === "contributions.run",
      ),
    ).toHaveLength(1);
    // Pending state is cleared for a later activation.
    expect(useAppStore.getState().contributionActions[TAB]).toEqual({});
  });
});

describe("passive refresh lifecycle (prompt-refinement plan step 29)", () => {
  const passiveSnapshot = (label: string) =>
    buildContributionSnapshot(
      [
        {
          ownerId: "fixture.ext",
          epoch: 0,
          revision: 1,
          contributions: [
            {
              id: "mode",
              kind: "mode",
              slot: "mode",
              label,
              tone: "accent",
              order: 0,
              actions: [],
            },
          ],
        },
      ],
      { supported: true, updatedAt: 1 },
    );

  it("does not read contributions for a stopped tab and keeps the last snapshot", async () => {
    const request = stubRequest(async () => passiveSnapshot("should not be read"));
    const current = passiveSnapshot("Workflow");
    useAppStore.setState({
      contributions: { [TAB]: current },
      tabs: useAppStore.getState().tabs.map((tab) => ({ ...tab, status: "stopped" as const })),
    });

    await useAppStore.getState().refreshContributions(TAB);

    // A status/toggle reconciliation is a refresh, not a wake: nothing is sent
    // and the previous authoritative snapshot survives.
    expect(request).not.toHaveBeenCalled();
    expect(useAppStore.getState().contributions[TAB]).toBe(current);
  });

  it("does not send an action for a tab that no longer exists", async () => {
    const request = stubRequest(async () => ({ ran: true }));
    useAppStore.setState({ tabs: [], activeTabId: null });

    await expect(
      useAppStore.getState().runContributionAction("tab-gone", "fixture.ext", "toggle"),
    ).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("leaves the shortcut list unlatched when the host is asleep, then retries", async () => {
    let attempts = 0;
    const request = stubRequest(async (method) => {
      if (method !== "shortcuts.list") return {};
      attempts += 1;
      if (attempts === 1) {
        throw new Error(
          "Error invoking remote method 'pi:sessions:request': Error: The session is asleep. Activate the tab to wake its host.",
        );
      }
      return { shortcuts: [{ key: "tab", extensionPath: "/ext/workflow", source: "workflow" }] };
    });

    await useAppStore.getState().loadShortcuts({ tabId: TAB, refresh: true });
    const asleep = useAppStore.getState().shortcutStates[TAB];
    expect(asleep?.error).toBe(null);
    expect(asleep?.loaded).toBe(false);
    expect(asleep?.busy).toBe(false);

    // Activation/ensure asks again; the asleep answer never latches forever.
    await useAppStore.getState().loadShortcuts({ tabId: TAB });
    expect(attempts).toBe(2);
    expect(useAppStore.getState().shortcutStates[TAB]?.shortcuts.shortcuts).toHaveLength(1);
    expect(request).toHaveBeenCalled();
  });
});
