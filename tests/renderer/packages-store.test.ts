import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { SettingsSnapshot } from "../../src/shared/settings";
import type { PackagesSnapshot, PackageSummary } from "../../src/shared/packages";
import { installBridge } from "./fixtures";

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
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
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
    view: "extensions",
  });
}

beforeEach(resetStore);

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
