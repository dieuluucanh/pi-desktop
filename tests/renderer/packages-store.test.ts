import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { SettingsSnapshot } from "../../src/shared/settings";
import {
  packageUpdateSignature,
  type PackagesSnapshot,
  type PackageSummary,
  type PackageUpdateSummary,
} from "../../src/shared/packages";
import { offerNotifications, type AppNotification } from "../../src/shared/notifications";
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
 * The package store actions (plan step 14).
 *
 * The behaviour this file pins: a bare name is normalised before it is shown in
 * the consent dialog, the dialog is the only path to `packages.install`, and the
 * consent echoed back is exactly the source the user saw.
 */

const PROJECT = "C:/work/app";

function packageSummary(overrides: Partial<PackageSummary> = {}): PackageSummary {
  return {
    source: "npm:@dieulc/workflow",
    name: "@dieulc/workflow",
    kind: "npm",
    scope: "user",
    filtered: false,
    version: "0.3.2",
    pinned: false,
    installedPath: "C:/profile/agent/npm/node_modules/@dieulc/workflow",
    installed: true,
    ...overrides,
  };
}

function packagesSnapshot(packages: PackageSummary[] = [packageSummary()]): PackagesSnapshot {
  return { packages, loadedAt: 42 };
}

function updateEntry(overrides: Partial<PackageUpdateSummary> = {}): PackageUpdateSummary {
  return {
    source: "npm:@dieulc/workflow",
    name: "@dieulc/workflow",
    kind: "npm",
    scope: "user",
    latestVersion: "0.4.0",
    ...overrides,
  };
}

function settingsSnapshot(): SettingsSnapshot {
  return {
    settings: { global: {}, project: {} },
    errors: [],
    files: {
      global: { path: "/profile/agent/settings.json", exists: true, mtimeMs: 100 },
      project: { path: `${PROJECT}/.pi/settings.json`, exists: true, mtimeMs: 200 },
    },
    projectTrusted: true,
  };
}

function stubRequest(impl: (method: string, params?: unknown) => Promise<unknown>) {
  const request = vi.fn((input: { method: string; params?: unknown }) =>
    impl(input.method, input.params),
  );
  (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
  return request;
}

function defaultImpl(method: string): Promise<unknown> {
  if (method === "packages.list") return Promise.resolve(packagesSnapshot());
  if (method === "settings.get") return Promise.resolve(settingsSnapshot());
  if (method === "resources.list") {
    return Promise.resolve({
      cwd: PROJECT,
      scope: "control",
      resources: [],
      overrides: [],
      diagnostics: [],
      runtimeErrors: [],
      loadedAt: 1,
    });
  }
  return Promise.resolve({});
}

function resetStore() {
  vi.clearAllMocks();
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    prefsLoaded: true,
    project: { path: PROJECT, name: "app" },
    tabs: [],
    activeTabId: null,
    settings: null,
    settingsLoaded: false,
    resourcesLoaded: false,
    packages: [],
    packagesLoaded: false,
    packagesBusy: false,
    packagesError: null,
    packagesCwd: null,
    packageProgress: null,
    packageConsent: null,
    packageUpdates: [],
    packageUpdatesCheckedAt: null,
    packageUpdatesBusy: false,
    packageUpdatesError: null,
    packageUpdatesOffline: false,
    packageUpdatesUnavailable: false,
    packageUpdatesCwd: null,
    packagesMutatedAt: null,
    notifications: [],
    hint: null,
    view: "extensions",
  });
}

beforeEach(resetStore);

/** The bell's derived offer rows (offers are never stored in the archive). */
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

describe("package listing", () => {
  it("asks the control host for the active project's packages", async () => {
    const request = stubRequest(defaultImpl);
    await useAppStore.getState().loadPackages();

    expect(request).toHaveBeenCalledWith({
      tabId: "control",
      method: "packages.list",
      params: { cwd: PROJECT },
    });
    const state = useAppStore.getState();
    expect(state.packages).toHaveLength(1);
    expect(state.packagesCwd).toBe(PROJECT);
    expect(state.packagesLoaded).toBe(true);
  });

  it("records a host failure instead of throwing", async () => {
    stubRequest(async (method) => {
      if (method === "packages.list") throw new Error("no package manager");
      return defaultImpl(method);
    });
    await useAppStore.getState().loadPackages();
    expect(useAppStore.getState().packagesError).toBe("no package manager");
    expect(useAppStore.getState().packagesBusy).toBe(false);
  });
});

describe("the consent dialog", () => {
  it("normalises a bare name and installs nothing until confirmed", async () => {
    const request = stubRequest(defaultImpl);
    useAppStore.getState().requestPackageInstall("@dieulc/workflow", "user");

    const consent = useAppStore.getState().packageConsent;
    expect(consent).toMatchObject({
      kind: "install",
      source: "npm:@dieulc/workflow",
      scope: "user",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses an unusable source without opening a dialog", () => {
    useAppStore.getState().requestPackageInstall("not a source", "user");
    expect(useAppStore.getState().packageConsent).toBeNull();
    expect(useAppStore.getState().packagesError).toMatch(/whitespace/);
  });

  it("sends the exact source it displayed and then refreshes", async () => {
    const request = stubRequest(defaultImpl);
    useAppStore.setState({
      projects: [
        { path: PROJECT, name: "app", addedAt: 1, lastOpenedAt: 1, useProjectSettings: true },
      ],
    });
    useAppStore.getState().requestPackageInstall("npm:@dieulc/workflow", "project");
    const ok = await useAppStore.getState().confirmPackageConsent();

    expect(ok).toBe(true);
    expect(request).toHaveBeenCalledWith({
      tabId: "control",
      method: "packages.install",
      params: {
        source: "npm:@dieulc/workflow",
        scope: "project",
        cwd: PROJECT,
        consent: { source: "npm:@dieulc/workflow", systemAccess: true },
      },
    });
    // The refresh covers the list, the settings arrays and the loaded resources.
    expect(request.mock.calls.map(([input]) => input.method)).toEqual(
      expect.arrayContaining([
        "packages.install",
        "packages.list",
        "settings.get",
        "resources.list",
      ]),
    );
    expect(useAppStore.getState().packageConsent).toBeNull();
  });

  it("does nothing when there is no pending consent", async () => {
    const request = stubRequest(defaultImpl);
    expect(await useAppStore.getState().confirmPackageConsent()).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("uses '*' as the update-all consent and omits the source parameter", async () => {
    const request = stubRequest(defaultImpl);
    useAppStore.getState().requestPackageUpdate(null, "user");
    expect(useAppStore.getState().packageConsent).toMatchObject({ kind: "update", source: "*" });

    await useAppStore.getState().confirmPackageConsent();
    expect(request).toHaveBeenCalledWith({
      tabId: "control",
      method: "packages.update",
      params: { scope: "user", cwd: PROJECT, consent: { source: "*", systemAccess: true } },
    });
  });

  it("surfaces a refused install as an error", async () => {
    stubRequest(async (method) => {
      if (method === "packages.install") throw new Error("npm ERR! code E404");
      return defaultImpl(method);
    });
    useAppStore.getState().requestPackageInstall("npm:missing-pkg", "user");
    expect(await useAppStore.getState().confirmPackageConsent()).toBe(false);
    expect(useAppStore.getState().packagesError).toMatch(/E404/);
    expect(useAppStore.getState().packagesBusy).toBe(false);
  });

  it("cancel closes the dialog without touching the host", () => {
    const request = stubRequest(defaultImpl);
    useAppStore.getState().requestPackageInstall("npm:foo", "user");
    useAppStore.getState().cancelPackageConsent();
    expect(useAppStore.getState().packageConsent).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});

describe("remove, pin and unpin", () => {
  it("removes without a consent dialog", async () => {
    const request = stubRequest(defaultImpl);
    const ok = await useAppStore.getState().removePackage(packageSummary());

    expect(ok).toBe(true);
    expect(request).toHaveBeenCalledWith({
      tabId: "control",
      method: "packages.remove",
      params: { source: "npm:@dieulc/workflow", scope: "user", cwd: PROJECT },
    });
    expect(useAppStore.getState().packageConsent).toBeNull();
  });

  it("pins to the installed version and unpins to floating", () => {
    useAppStore.getState().pinPackage(packageSummary());
    expect(useAppStore.getState().packageConsent).toMatchObject({
      kind: "install",
      source: "npm:@dieulc/workflow@0.3.2",
    });

    useAppStore.getState().cancelPackageConsent();
    useAppStore.getState().unpinPackage(packageSummary());
    expect(useAppStore.getState().packageConsent).toMatchObject({
      kind: "install",
      source: "npm:@dieulc/workflow",
    });
  });

  it("does not offer pinning for a git or path source", () => {
    useAppStore.getState().pinPackage(packageSummary({ kind: "git", version: "main" }));
    expect(useAppStore.getState().packageConsent).toBeNull();
    useAppStore.getState().unpinPackage(packageSummary({ kind: "git", version: "main" }));
    expect(useAppStore.getState().packageConsent).toBeNull();
  });
});

describe("recommended packages and control events", () => {
  it("routes a recommended install through the consent dialog", () => {
    const request = stubRequest(defaultImpl);
    const entry = {
      id: "dieulc-workflow",
      name: "@dieulc/workflow",
      source: "npm:@dieulc/workflow",
      description: "",
      provides: "",
      verifiableInRepo: false,
    };
    useAppStore.getState().installRecommendedPackage(entry);
    expect(useAppStore.getState().packageConsent).toMatchObject({ source: "npm:@dieulc/workflow" });
    expect(request).not.toHaveBeenCalled();
  });

  it("tracks progress frames and clears them when the operation ends", () => {
    const apply = useAppStore.getState().applyControlEvent;
    apply({
      event: "packages.progress",
      payload: { operationId: "op-1", action: "install", phase: "start", source: "npm:foo" },
    });
    expect(useAppStore.getState().packageProgress).toMatchObject({
      phase: "start",
      source: "npm:foo",
    });

    apply({
      event: "packages.progress",
      payload: { operationId: "op-1", action: "install", phase: "complete", source: "npm:foo" },
    });
    expect(useAppStore.getState().packageProgress).toBeNull();

    // A malformed frame is ignored rather than stored.
    apply({ event: "packages.progress", payload: { action: "install" } });
    expect(useAppStore.getState().packageProgress).toBeNull();
  });

  it("re-lists when the host reports a package change", async () => {
    const request = stubRequest(defaultImpl);
    useAppStore.getState().applyControlEvent({ event: "packages.changed", payload: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: "packages.list" }));
  });
});

describe("extension update checks", () => {
  function stubCheck(result: {
    updates: PackageUpdateSummary[];
    checkedAt: number;
    offline: boolean;
  }) {
    return stubRequest((method) => {
      if (method === "packages.checkUpdates") return Promise.resolve(result);
      return defaultImpl(method);
    });
  }

  it("stores the sanitized sweep and asks the control host for the project", async () => {
    const request = stubCheck({ updates: [updateEntry()], checkedAt: 500, offline: false });

    await useAppStore.getState().checkPackageUpdates();

    const state = useAppStore.getState();
    expect(state.packageUpdates).toEqual([updateEntry()]);
    expect(state.packageUpdatesCheckedAt).toBe(500);
    expect(state.packageUpdatesCwd).toBe(PROJECT);
    expect(state.packageUpdatesBusy).toBe(false);
    expect(state.packageUpdatesError).toBeNull();
    expect(request).toHaveBeenCalledWith({
      tabId: "control",
      method: "packages.checkUpdates",
      params: { cwd: PROJECT },
    });
  });

  it("sends force only when asked", async () => {
    const request = stubCheck({ updates: [], checkedAt: 1, offline: false });
    await useAppStore.getState().checkPackageUpdates({ force: true });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ params: { cwd: PROJECT, force: true } }),
    );
  });

  it("passes the offline flag through", async () => {
    stubCheck({ updates: [], checkedAt: 1, offline: true });
    await useAppStore.getState().checkPackageUpdates({ automatic: true });
    expect(useAppStore.getState().packageUpdatesOffline).toBe(true);
  });

  it("keeps the previous list and records the reason when the sweep fails", async () => {
    useAppStore.setState({ packageUpdates: [updateEntry()], packageUpdatesCheckedAt: 100 });
    stubRequest(async (method) => {
      if (method === "packages.checkUpdates") throw new Error("registry unreachable");
      return defaultImpl(method);
    });

    await useAppStore.getState().checkPackageUpdates({ automatic: true });

    const state = useAppStore.getState();
    // A failed sweep is not proof that nothing is outdated.
    expect(state.packageUpdates).toEqual([updateEntry()]);
    expect(state.packageUpdatesCheckedAt).toBe(100);
    expect(state.packageUpdatesError).toMatch(/registry unreachable/);
    expect(state.packageUpdatesBusy).toBe(false);
    expect(offers()).toHaveLength(1);
    // Background failures stay quiet.
    expect(state.hint).toBeNull();
  });

  it("marks a host without a package manager as unavailable, not failed", async () => {
    stubRequest(async (method) => {
      if (method === "packages.checkUpdates") {
        throw Object.assign(new Error("packages are not available"), { code: "not_implemented" });
      }
      return defaultImpl(method);
    });
    await useAppStore.getState().checkPackageUpdates();
    expect(useAppStore.getState().packageUpdatesUnavailable).toBe(true);
  });

  it("tells a manual check why it failed", async () => {
    stubRequest(async (method) => {
      if (method === "packages.checkUpdates") throw new Error("registry unreachable");
      return defaultImpl(method);
    });
    await useAppStore.getState().checkPackageUpdates();
    expect(useAppStore.getState().hint).toMatch(/Could not check for extension updates/);
  });

  it("announces one update set without storing a row", async () => {
    stubCheck({ updates: [updateEntry()], checkedAt: 500, offline: false });
    await useAppStore.getState().checkPackageUpdates();

    const first = useAppStore.getState();
    expect(offers()).toHaveLength(1);
    expect(offers()[0]).toMatchObject({
      action: { kind: "open-extensions" },
      message: "1 extension update available.",
    });
    expect(offers()[0]?.id).toMatch(/^app:packages:/);
    // The offer is state, not an arrived row.
    expect(first.notifications).toHaveLength(0);
    expect(first.prefs.packages.notifiedSignature).toBe(packageUpdateSignature([updateEntry()]));
    expect(toast.info).toHaveBeenCalledTimes(1);

    // The same set is not announced twice.
    await useAppStore.getState().checkPackageUpdates();
    expect(offers()).toHaveLength(1);
    expect(toast.info).toHaveBeenCalledTimes(1);
  });

  it("replaces the offer when a newer target changes the set", async () => {
    stubCheck({ updates: [updateEntry()], checkedAt: 500, offline: false });
    await useAppStore.getState().checkPackageUpdates();

    stubCheck({
      updates: [updateEntry({ latestVersion: "0.5.0" })],
      checkedAt: 600,
      offline: false,
    });
    await useAppStore.getState().checkPackageUpdates();

    expect(offers()).toHaveLength(1);
    expect(offers()[0]?.id).toBe(
      offerNotifications({
        prefsLoaded: true,
        prefs: DEFAULT_PREFS.notifications,
        update: null,
        packageUpdates: [updateEntry({ latestVersion: "0.5.0" })],
        packageUpdatesCheckedAt: 600,
        dismissedVersion: null,
        dismissedSignature: null,
      })[0]?.id,
    );
    expect(toast.info).toHaveBeenCalledTimes(2);
  });

  it("adds no offer and no marker for a muted class", async () => {
    useAppStore.setState({
      prefs: {
        ...DEFAULT_PREFS,
        notifications: {
          ...DEFAULT_PREFS.notifications,
          classes: { ...DEFAULT_PREFS.notifications.classes, extension: false },
        },
      },
    });
    stubCheck({ updates: [updateEntry()], checkedAt: 500, offline: false });
    await useAppStore.getState().checkPackageUpdates();

    const state = useAppStore.getState();
    expect(offers()).toHaveLength(0);
    expect(state.notifications).toHaveLength(0);
    // Enabling the class later must announce the offer instead of finding a hidden row.
    expect(state.prefs.packages.notifiedSignature).toBeNull();
    expect(toast.info).not.toHaveBeenCalled();

    useAppStore.getState().setNotificationClass("extension", true);
    expect(offers()).toHaveLength(1);
    expect(useAppStore.getState().prefs.packages.notifiedSignature).not.toBeNull();
    expect(toast.info).toHaveBeenCalledTimes(1);
  });

  it("drops the matching update after a consented update", async () => {
    useAppStore.setState({ packageUpdates: [updateEntry()] });
    stubRequest(defaultImpl);
    useAppStore.getState().requestPackageUpdate("npm:@dieulc/workflow", "user");

    expect(await useAppStore.getState().confirmPackageConsent()).toBe(true);

    expect(useAppStore.getState().packageUpdates).toEqual([]);
    expect(offers()).toEqual([]);
    expect(useAppStore.getState().packagesMutatedAt).toEqual(expect.any(Number));
  });

  it("drops every update after Update all", async () => {
    useAppStore.setState({
      packageUpdates: [updateEntry(), updateEntry({ source: "npm:other", name: "other" })],
    });
    expect(offers()).toHaveLength(1);
    expect(offers()[0]?.message).toBe("2 extension updates available.");
    stubRequest(defaultImpl);
    useAppStore.getState().requestPackageUpdate(null, "user");

    await useAppStore.getState().confirmPackageConsent();

    expect(useAppStore.getState().packageUpdates).toEqual([]);
    expect(offers()).toEqual([]);
  });

  it("drops the matching update when another window reports a change", async () => {
    useAppStore.setState({
      packageUpdates: [updateEntry(), updateEntry({ source: "npm:other", name: "other" })],
    });
    stubRequest(defaultImpl);

    useAppStore.getState().applyControlEvent({
      event: "packages.changed",
      payload: { source: "npm:@dieulc/workflow" },
    });

    expect(useAppStore.getState().packageUpdates.map((entry) => entry.source)).toEqual([
      "npm:other",
    ]);
    expect(offers()).toHaveLength(1);
    expect(offers()[0]?.message).toBe("1 extension update available.");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("dismisses and restores the set through the persisted markers", async () => {
    stubCheck({ updates: [updateEntry()], checkedAt: 500, offline: false });
    await useAppStore.getState().checkPackageUpdates();
    const id = offers()[0]?.id ?? "";

    useAppStore.getState().dismissNotification(id);
    expect(offers()).toHaveLength(0);
    expect(useAppStore.getState().prefs.packages.dismissedSignature).toBe(
      packageUpdateSignature([updateEntry()]),
    );

    await useAppStore.getState().checkPackageUpdates();
    expect(offers()).toHaveLength(0);
    expect(toast.info).toHaveBeenCalledTimes(1);

    useAppStore.getState().restorePackageUpdateOffer();
    expect(offers()).toHaveLength(1);
    expect(useAppStore.getState().prefs.packages.dismissedSignature).toBeNull();
    expect(toast.info).toHaveBeenCalledTimes(2);
  });

  it("keeps the other package-check pref when one is patched", () => {
    useAppStore.setState({
      prefs: {
        ...DEFAULT_PREFS,
        packages: { autoCheck: true, notifiedSignature: "npm:foo@2.0.0", dismissedSignature: null },
      },
    });
    useAppStore.getState().setPackageCheckPrefs({ autoCheck: false });
    expect(useAppStore.getState().prefs.packages).toEqual({
      autoCheck: false,
      notifiedSignature: "npm:foo@2.0.0",
      dismissedSignature: null,
    });
  });

  it("clears the reload hint", () => {
    useAppStore.setState({ packagesMutatedAt: 123 });
    useAppStore.getState().dismissPackageReloadHint();
    expect(useAppStore.getState().packagesMutatedAt).toBeNull();
  });

  it("removes the offer when a sweep finds nothing", async () => {
    stubCheck({ updates: [updateEntry()], checkedAt: 500, offline: false });
    await useAppStore.getState().checkPackageUpdates();
    expect(offers()).toHaveLength(1);

    // The package was updated outside the app: the next sweep is the truth.
    stubCheck({ updates: [], checkedAt: 600, offline: false });
    await useAppStore.getState().checkPackageUpdates();

    expect(offers()).toEqual([]);
    expect(useAppStore.getState().prefs.packages.dismissedSignature).toBeNull();
  });

  it("narrows the offer after a partial update", async () => {
    useAppStore.setState({
      packageUpdates: [updateEntry(), updateEntry({ source: "npm:other", name: "other" })],
    });
    expect(offers()[0]?.message).toBe("2 extension updates available.");
    stubRequest(defaultImpl);
    useAppStore.getState().requestPackageUpdate("npm:@dieulc/workflow", "user");

    expect(await useAppStore.getState().confirmPackageConsent()).toBe(true);

    expect(offers()).toHaveLength(1);
    expect(offers()[0]?.message).toBe("1 extension update available.");
  });

  it("drops a pinned package from the offer", async () => {
    useAppStore.setState({ packageUpdates: [updateEntry()] });
    expect(offers()).toHaveLength(1);
    stubRequest(defaultImpl);

    useAppStore.getState().pinPackage(packageSummary());
    expect(await useAppStore.getState().confirmPackageConsent()).toBe(true);

    expect(offers()).toEqual([]);
  });

  it("keeps a dismissed set dismissed across a relaunch", async () => {
    stubCheck({ updates: [updateEntry()], checkedAt: 500, offline: false });
    await useAppStore.getState().checkPackageUpdates();
    useAppStore.getState().dismissNotification(offers()[0]!.id);

    // Relaunch: the archive is in-memory, the persisted markers are not.
    useAppStore.setState({ notifications: [], notificationCooldowns: {} });
    expect(offers()).toEqual([]);

    // A changed set is a new offer.
    useAppStore.setState({
      packageUpdates: [updateEntry({ latestVersion: "0.5.0" })],
      packageUpdatesCheckedAt: 600,
    });
    expect(offers()).toHaveLength(1);
  });
});
