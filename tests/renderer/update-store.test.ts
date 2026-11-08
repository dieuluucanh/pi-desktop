import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { updateNotificationId } from "../../src/shared/notifications";
import { initialUpdateState } from "../../src/shared/updates";
import { installBridge, removeBridge } from "./fixtures";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

/**
 * Update store actions (plan step 26): the renderer never invents updater state
 * — it reads `updates.get`, follows `updates.onState`, and turns a finished
 * check into status-bar feedback when there is nothing to install.
 */

beforeEach(() => {
  vi.clearAllMocks();
  installBridge({ update: initialUpdateState(true) });
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    prefsLoaded: true,
    view: "welcome",
    settingsFocus: null,
    update: null,
    notifications: [],
    hint: null,
    offlineNotice: null,
  });
});

describe("update store (plan step 26)", () => {
  it("loads the current state from main", async () => {
    await useAppStore.getState().loadUpdateState();
    expect(useAppStore.getState().update).toMatchObject({ phase: "idle", supported: true });
  });

  it("sanitizes a pushed state", () => {
    useAppStore.getState().applyUpdateState({ supported: true, phase: "teleporting" });
    expect(useAppStore.getState().update).toMatchObject({ phase: "idle", supported: true });
    useAppStore.getState().applyUpdateState({
      supported: true,
      phase: "available",
      version: " 0.2.0 ",
    });
    expect(useAppStore.getState().update).toMatchObject({ phase: "available", version: "0.2.0" });
  });

  it("asks main to check and records an up-to-date answer as a hint", async () => {
    const check = vi.fn(async () => initialUpdateState(true));
    (window.pi as unknown as { updates: { check: unknown } }).updates.check = check;

    await useAppStore.getState().checkForUpdates();

    expect(check).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().update?.phase).toBe("idle");
  });

  it("reports a dev build honestly when the menu asks for a check", async () => {
    removeBridge();
    installBridge({
      update: initialUpdateState(false, { unsupportedReason: "development" }),
    });
    await useAppStore.getState().checkForUpdates();
    expect(useAppStore.getState().hint).toBe("Updates are checked in installed builds only.");
  });

  it("uses a friendly hint for the updater's error kind", async () => {
    const check = vi.fn(async () => ({
      ...initialUpdateState(true),
      phase: "error" as const,
      error: "feed down",
      problemKind: "network" as const,
    }));
    (window.pi as unknown as { updates: { check: unknown } }).updates.check = check;

    await useAppStore.getState().checkForUpdates();

    expect(useAppStore.getState().update?.phase).toBe("error");
    expect(useAppStore.getState().hint).toContain("Couldn't reach the update server");
  });

  it("reports a missing published feed neutrally", async () => {
    const check = vi.fn(async () => ({
      ...initialUpdateState(true),
      phase: "no-feed" as const,
      problemKind: "no-feed" as const,
      error: "ERR_UPDATER_LATEST_VERSION_NOT_FOUND",
    }));
    (window.pi as unknown as { updates: { check: unknown } }).updates.check = check;

    await useAppStore.getState().checkForUpdates();

    expect(useAppStore.getState().update?.phase).toBe("no-feed");
    expect(useAppStore.getState().hint).toBe("No published release was found for this build.");
  });

  it("forwards download and install to main", async () => {
    const calls: string[] = [];
    const api = window.pi as unknown as {
      updates: { download: () => Promise<unknown>; install: () => Promise<boolean> };
    };
    api.updates.download = async () => {
      calls.push("download");
      return { ...initialUpdateState(true), phase: "downloading" as const, percent: 10 };
    };
    api.updates.install = async () => {
      calls.push("install");
      return true;
    };

    await useAppStore.getState().downloadUpdate();
    expect(useAppStore.getState().update).toMatchObject({ phase: "downloading", percent: 10 });
    await useAppStore.getState().installUpdate();
    expect(calls).toEqual(["download", "install"]);
  });

  it("notes a rejected update call instead of throwing", async () => {
    const api = window.pi as unknown as { updates: { check: () => Promise<unknown> } };
    api.updates.check = async () => {
      throw new Error("no updater");
    };
    await useAppStore.getState().checkForUpdates();
    expect(useAppStore.getState().hint).toBe("no updater");
  });

  it("clears a problem through main and drops the hint", async () => {
    const clearProblem = vi.fn(async () => initialUpdateState(true));
    (window.pi as unknown as { updates: { clearProblem: unknown } }).updates.clearProblem =
      clearProblem;
    useAppStore.setState({
      update: {
        ...initialUpdateState(true),
        phase: "error",
        error: "feed down",
        problemKind: "unknown",
      },
      hint: "The update check failed.",
    });

    await useAppStore.getState().clearUpdateProblem();

    expect(clearProblem).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().update?.phase).toBe("idle");
    expect(useAppStore.getState().hint).toBeNull();
  });

  it("opens the About & updates view and can start a check", async () => {
    const check = vi.fn(async () => initialUpdateState(true));
    (window.pi as unknown as { updates: { check: unknown } }).updates.check = check;

    useAppStore.getState().openUpdatesView();
    expect(useAppStore.getState().view).toBe("updates");
    expect(useAppStore.getState().settingsFocus).toBeNull();

    useAppStore.getState().openUpdatesView({ check: true });
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    expect(useAppStore.getState().view).toBe("updates");
    expect(useAppStore.getState().settingsFocus).toBeNull();
  });

  it("raises one notification per offered version and remembers it", () => {
    const offer = (version: string) => ({
      ...initialUpdateState(true),
      phase: "available" as const,
      version,
    });

    useAppStore.getState().applyUpdateState(offer("0.4.0"));
    let state = useAppStore.getState();
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]).toMatchObject({
      id: updateNotificationId("0.4.0"),
      message: "Pi Desktop v0.4.0 is available.",
      class: "update",
      action: { kind: "open-updates" },
    });
    expect(state.prefs.updates.notifiedVersion).toBe("0.4.0");
    expect(toast.info).toHaveBeenCalledTimes(1);

    // A repeated push does not duplicate the row or the toast.
    useAppStore.getState().applyUpdateState(offer("0.4.0"));
    state = useAppStore.getState();
    expect(state.notifications).toHaveLength(1);
    expect(toast.info).toHaveBeenCalledTimes(1);

    // A newer offer notifies again.
    useAppStore.getState().applyUpdateState(offer("0.5.0"));
    state = useAppStore.getState();
    expect(state.notifications.map((entry) => entry.id)).toEqual([
      updateNotificationId("0.5.0"),
      updateNotificationId("0.4.0"),
    ]);
    expect(state.prefs.updates.notifiedVersion).toBe("0.5.0");
    expect(toast.info).toHaveBeenCalledTimes(2);
  });

  it("defers the offer until the stored prefs have loaded", async () => {
    useAppStore.setState({ prefsLoaded: false, prefs: { ...DEFAULT_PREFS } });
    useAppStore.getState().applyUpdateState({
      ...initialUpdateState(true),
      phase: "available",
      version: "0.4.0",
    });
    expect(useAppStore.getState().notifications).toHaveLength(0);
    expect(useAppStore.getState().prefs.updates.notifiedVersion).toBeNull();

    await useAppStore.getState().loadPrefs();
    expect(useAppStore.getState().notifications).toHaveLength(1);
    expect(useAppStore.getState().prefs.updates.notifiedVersion).toBe("0.4.0");
  });

  it("respects the update class and raises once it is enabled", () => {
    useAppStore.setState({
      prefs: {
        ...DEFAULT_PREFS,
        notifications: {
          ...DEFAULT_PREFS.notifications,
          classes: { ...DEFAULT_PREFS.notifications.classes, update: false },
        },
      },
    });
    useAppStore.getState().applyUpdateState({
      ...initialUpdateState(true),
      phase: "available",
      version: "0.4.0",
    });
    expect(useAppStore.getState().notifications).toHaveLength(0);
    expect(useAppStore.getState().prefs.updates.notifiedVersion).toBeNull();

    useAppStore.getState().setNotificationClass("update", true);
    expect(useAppStore.getState().prefs.notifications.classes.update).toBe(true);
    expect(useAppStore.getState().notifications).toHaveLength(1);
    expect(useAppStore.getState().prefs.updates.notifiedVersion).toBe("0.4.0");
  });

  it("dismisses without re-raising and restores on demand", () => {
    const offer = {
      ...initialUpdateState(true),
      phase: "available" as const,
      version: "0.4.0",
    };
    useAppStore.getState().applyUpdateState(offer);
    const id = updateNotificationId("0.4.0");

    useAppStore.getState().dismissNotification(id);
    expect(useAppStore.getState().notifications).toHaveLength(0);
    expect(useAppStore.getState().prefs.updates.notifiedVersion).toBe("0.4.0");

    // A repeated push does not resurrect a dismissed notification.
    useAppStore.getState().applyUpdateState(offer);
    expect(useAppStore.getState().notifications).toHaveLength(0);

    useAppStore.getState().restoreUpdateNotification();
    expect(useAppStore.getState().notifications).toHaveLength(1);
    expect(useAppStore.getState().notifications[0]?.id).toBe(id);
  });

  it("clears the archive without letting the same version raise again", () => {
    const offer = {
      ...initialUpdateState(true),
      phase: "available" as const,
      version: "0.4.0",
    };
    useAppStore.getState().applyUpdateState(offer);
    useAppStore.getState().clearNotifications();
    expect(useAppStore.getState().notifications).toHaveLength(0);

    useAppStore.getState().applyUpdateState(offer);
    expect(useAppStore.getState().notifications).toHaveLength(0);
    expect(useAppStore.getState().prefs.updates.notifiedVersion).toBe("0.4.0");
  });

  it("routes the update toast action to About & updates", () => {
    useAppStore.getState().applyUpdateState({
      ...initialUpdateState(true),
      phase: "available",
      version: "0.4.0",
    });
    const calls = (toast.info as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const options = calls[0]?.[1] as
      { action?: { label?: string; onClick?: () => void } } | undefined;
    expect(options?.action?.label).toBe("View update");
    options?.action?.onClick?.();
    expect(useAppStore.getState().view).toBe("updates");
  });

  it("opens Settings focused on Notifications", () => {
    useAppStore.getState().openNotificationSettings();
    expect(useAppStore.getState().view).toBe("settings");
    expect(useAppStore.getState().settingsFocus).toBe("notifications");
  });

  it("does nothing when the bridge is absent", async () => {
    removeBridge();
    useAppStore.setState({ update: null });
    await useAppStore.getState().loadUpdateState();
    await useAppStore.getState().checkForUpdates();
    await useAppStore.getState().downloadUpdate();
    await useAppStore.getState().installUpdate();
    expect(useAppStore.getState().update).toBeNull();
  });
});
