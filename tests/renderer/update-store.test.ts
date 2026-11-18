import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import {
  offerNotifications,
  updateNotificationId,
  type AppNotification,
} from "../../src/shared/notifications";
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

/**
 * The bell's offer rows. Offers are derived from live state, so the tests assert
 * this derivation instead of looking for a stored archive row.
 */
function offers(): AppNotification[] {
  const state = useAppStore.getState();
  return offerNotifications({
    prefsLoaded: state.prefsLoaded,
    prefs: state.prefs.notifications,
    update: state.update,
    packageUpdates: state.packageUpdates,
    packageUpdatesCheckedAt: state.packageUpdatesCheckedAt,
    dismissedVersion: state.prefs.updates.dismissedVersion,
    dismissedSignature: state.prefs.packages.dismissedSignature,
  });
}

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

  it("announces one offer per version without storing a row", () => {
    const offer = (version: string) => ({
      ...initialUpdateState(true),
      phase: "available" as const,
      version,
    });

    useAppStore.getState().applyUpdateState(offer("0.4.0"));
    let state = useAppStore.getState();
    expect(offers()).toHaveLength(1);
    expect(offers()[0]).toMatchObject({
      id: updateNotificationId("0.4.0"),
      message: "Pi Desktop v0.4.0 is available.",
      class: "update",
      action: { kind: "open-updates" },
    });
    // The offer is state, not an archived arrival.
    expect(state.notifications).toHaveLength(0);
    expect(state.prefs.updates.notifiedVersion).toBe("0.4.0");
    expect(toast.info).toHaveBeenCalledTimes(1);

    // A repeated push does not duplicate the row or the toast.
    useAppStore.getState().applyUpdateState(offer("0.4.0"));
    expect(offers()).toHaveLength(1);
    expect(toast.info).toHaveBeenCalledTimes(1);

    // A newer offer replaces the row and notifies again.
    useAppStore.getState().applyUpdateState(offer("0.5.0"));
    state = useAppStore.getState();
    expect(offers().map((entry) => entry.id)).toEqual([updateNotificationId("0.5.0")]);
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
    expect(offers()).toHaveLength(0);
    expect(useAppStore.getState().prefs.updates.notifiedVersion).toBeNull();

    await useAppStore.getState().loadPrefs();
    expect(offers()).toHaveLength(1);
    expect(useAppStore.getState().prefs.updates.notifiedVersion).toBe("0.4.0");
    expect(toast.info).toHaveBeenCalledTimes(1);
  });

  it("respects the update class and announces once it is enabled", () => {
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
    expect(offers()).toHaveLength(0);
    expect(useAppStore.getState().prefs.updates.notifiedVersion).toBeNull();
    expect(toast.info).not.toHaveBeenCalled();

    useAppStore.getState().setNotificationClass("update", true);
    expect(useAppStore.getState().prefs.notifications.classes.update).toBe(true);
    expect(offers()).toHaveLength(1);
    expect(useAppStore.getState().prefs.updates.notifiedVersion).toBe("0.4.0");
    expect(toast.info).toHaveBeenCalledTimes(1);
  });

  it("dismisses through the persisted marker and restores on demand", () => {
    const offer = {
      ...initialUpdateState(true),
      phase: "available" as const,
      version: "0.4.0",
    };
    useAppStore.getState().applyUpdateState(offer);
    const id = updateNotificationId("0.4.0");

    useAppStore.getState().dismissNotification(id);
    expect(offers()).toHaveLength(0);
    expect(useAppStore.getState().prefs.updates.dismissedVersion).toBe("0.4.0");

    // A repeated push does not resurrect a dismissed offer.
    useAppStore.getState().applyUpdateState(offer);
    expect(offers()).toHaveLength(0);
    expect(toast.info).toHaveBeenCalledTimes(1);

    useAppStore.getState().restoreUpdateNotification();
    expect(offers()).toHaveLength(1);
    expect(offers()[0]?.id).toBe(id);
    expect(useAppStore.getState().prefs.updates.dismissedVersion).toBeNull();
    expect(toast.info).toHaveBeenCalledTimes(2);
  });

  it("clears without letting the same version return", () => {
    const offer = {
      ...initialUpdateState(true),
      phase: "available" as const,
      version: "0.4.0",
    };
    useAppStore.getState().applyUpdateState(offer);
    useAppStore.getState().clearNotifications();
    expect(offers()).toHaveLength(0);
    expect(useAppStore.getState().prefs.updates.dismissedVersion).toBe("0.4.0");

    useAppStore.getState().applyUpdateState(offer);
    expect(offers()).toHaveLength(0);
    expect(toast.info).toHaveBeenCalledTimes(1);
  });

  it("follows the updater phase and never stacks versions", () => {
    const base = { ...initialUpdateState(true), version: "0.4.0", checkedAt: 1 };
    useAppStore.getState().applyUpdateState({ ...base, phase: "available" });
    expect(offers().map((entry) => entry.message)).toEqual(["Pi Desktop v0.4.0 is available."]);

    useAppStore.getState().applyUpdateState({ ...base, phase: "downloaded" });
    expect(offers()).toHaveLength(1);
    expect(offers()[0]?.message).toBe("Pi Desktop v0.4.0 is ready to install.");

    useAppStore.getState().applyUpdateState({ ...base, phase: "up-to-date", version: null });
    expect(offers()).toEqual([]);

    useAppStore.getState().applyUpdateState({
      ...base,
      phase: "error",
      problemKind: "network",
    });
    expect(offers()).toEqual([]);

    useAppStore.getState().applyUpdateState({ ...base, phase: "available" });
    expect(offers()).toHaveLength(1);
  });

  it("keeps a dismissed version dismissed across a relaunch", () => {
    const offer = {
      ...initialUpdateState(true),
      phase: "available" as const,
      version: "0.4.0",
      checkedAt: 1,
    };
    useAppStore.getState().applyUpdateState(offer);
    useAppStore.getState().dismissNotification(updateNotificationId("0.4.0"));

    // Relaunch: in-memory state is rebuilt; persisted prefs survive.
    useAppStore.setState({ notifications: [], notificationCooldowns: {}, update: null });
    useAppStore.getState().applyUpdateState(offer);
    expect(offers()).toEqual([]);

    useAppStore.getState().applyUpdateState({ ...offer, version: "0.5.0" });
    expect(offers()).toHaveLength(1);
    expect(offers()[0]?.id).toBe(updateNotificationId("0.5.0"));
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
