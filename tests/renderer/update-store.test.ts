import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { initialUpdateState } from "../../src/shared/updates";
import { installBridge, removeBridge } from "./fixtures";

/**
 * Update store actions (plan step 26): the renderer never invents updater state
 * — it reads `updates.get`, follows `updates.onState`, and turns a finished
 * check into status-bar feedback when there is nothing to install.
 */

beforeEach(() => {
  installBridge({ update: initialUpdateState(true) });
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    view: "welcome",
    settingsFocus: null,
    update: null,
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

  it("persists a per-version notification dismissal", () => {
    useAppStore.setState({
      prefs: { ...DEFAULT_PREFS },
      update: { ...initialUpdateState(true), phase: "available", version: "0.4.0" },
    });

    useAppStore.getState().dismissUpdateNotification();

    expect(useAppStore.getState().prefs.updates.dismissedVersion).toBe("0.4.0");

    // Nothing is offered / downloaded: the action is a no-op.
    useAppStore.setState({
      prefs: { ...DEFAULT_PREFS },
      update: { ...initialUpdateState(true), phase: "idle" },
    });
    useAppStore.getState().dismissUpdateNotification();
    expect(useAppStore.getState().prefs.updates.dismissedVersion).toBeNull();
  });

  it("opens Settings on the updates card and can start a check", async () => {
    const check = vi.fn(async () => initialUpdateState(true));
    (window.pi as unknown as { updates: { check: unknown } }).updates.check = check;

    useAppStore.getState().openUpdateSettings();
    expect(useAppStore.getState().view).toBe("settings");
    expect(useAppStore.getState().settingsFocus).toBe("updates");

    // Navigating away consumes/clears the section target.
    useAppStore.getState().setView("welcome");
    expect(useAppStore.getState().settingsFocus).toBeNull();

    useAppStore.getState().openUpdateSettings({ check: true });
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    expect(useAppStore.getState().view).toBe("settings");
    expect(useAppStore.getState().settingsFocus).toBe("updates");
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
