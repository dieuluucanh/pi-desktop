import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { SettingsSnapshot } from "../../src/shared/settings";
import type { PackagesSnapshot } from "../../src/shared/packages";
import {
  emptyIntegrationsState,
  officeBridgePackageSource,
  type IntegrationsState,
} from "../../src/shared/integrations";
import { installBridge } from "./fixtures";

/**
 * The Office integration store actions (plan step 19).
 *
 * The behaviour this file pins: the bridge install goes through the *same*
 * consent dialog as any package, with the pinned source shown verbatim; the
 * app state record is written only after that consent is confirmed; and the
 * Office session is an ordinary `office`-kind tab (focused, not duplicated).
 */

const PROJECT = "C:/work/app";

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

function packagesSnapshot(installed = false): PackagesSnapshot {
  return {
    packages: installed
      ? [
          {
            source: officeBridgePackageSource(),
            name: "@dieulc/pi-office-bridge",
            kind: "npm",
            scope: "user",
            filtered: false,
            version: "0.5.0",
            pinned: true,
            installedPath: "C:/profile/agent/npm/node_modules/@dieulc/pi-office-bridge",
            installed: true,
          },
        ]
      : [],
    loadedAt: 42,
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

function resetStore(integrations: IntegrationsState = emptyIntegrationsState()) {
  installBridge({ integrations });
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
    integrations,
    integrationsLoaded: false,
    view: "extensions",
  });
}

beforeEach(() => resetStore());

describe("loadIntegrations", () => {
  it("reads the app record once and keeps it in state", async () => {
    const get = vi.fn(async () => ({
      office: { bridgeInstalledAt: "2026-09-20T10:00:00.000Z", lastSetupAt: null },
    }));
    (window.pi as unknown as { integrations: { get: unknown } }).integrations.get = get;

    await useAppStore.getState().loadIntegrations();

    expect(get).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().integrations.office.bridgeInstalledAt).toBe(
      "2026-09-20T10:00:00.000Z",
    );
    expect(useAppStore.getState().integrationsLoaded).toBe(true);

    // A second call is a no-op until something forces a refresh.
    await useAppStore.getState().loadIntegrations();
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe("installOfficeBridge", () => {
  it("opens the standard consent dialog with the pinned source", () => {
    const request = stubRequest(defaultImpl);
    useAppStore.getState().installOfficeBridge();

    const consent = useAppStore.getState().packageConsent;
    expect(consent?.source).toBe(officeBridgePackageSource());
    expect(consent?.scope).toBe("user");
    expect(consent?.integration).toBe("office");
    // Nothing is installed yet: the dialog is the only path to `packages.install`.
    expect(request).not.toHaveBeenCalled();
  });

  it("records the consented install only after a successful install", async () => {
    const request = stubRequest(defaultImpl);
    const record = vi.fn(async (patch: unknown) => ({
      office: {
        bridgeInstalledAt: "recorded",
        lastSetupAt: null,
        ...(patch as object),
      },
    }));
    (
      window.pi as unknown as { integrations: { recordOffice: unknown } }
    ).integrations.recordOffice = record;

    useAppStore.getState().installOfficeBridge();
    await useAppStore.getState().confirmPackageConsent();

    const installCall = request.mock.calls.find(([input]) => input.method === "packages.install");
    expect(installCall?.[0].params).toMatchObject({
      source: officeBridgePackageSource(),
      scope: "user",
      consent: { source: officeBridgePackageSource(), systemAccess: true },
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toHaveProperty("bridgeInstalledAt");
  });

  it("does not record anything when the install fails", async () => {
    stubRequest((method) => {
      if (method === "packages.install") return Promise.reject(new Error("npm exploded"));
      return defaultImpl(method);
    });
    const record = vi.fn(async () => emptyIntegrationsState());
    (
      window.pi as unknown as { integrations: { recordOffice: unknown } }
    ).integrations.recordOffice = record;

    useAppStore.getState().installOfficeBridge();
    const ok = await useAppStore.getState().confirmPackageConsent();

    expect(ok).toBe(false);
    expect(record).not.toHaveBeenCalled();
    expect(useAppStore.getState().packagesError).toMatch(/npm exploded/);
  });
});

describe("openOfficeSession", () => {
  it("opens an office-kind tab in the active project", async () => {
    const create = vi.fn(async () => ({ tabs: [], activeTabId: null }));
    (window.pi as unknown as { sessions: { create: unknown } }).sessions.create = create;

    await useAppStore.getState().openOfficeSession();

    expect(create).toHaveBeenCalledWith({ cwd: PROJECT, kind: "office" });
    expect(useAppStore.getState().view).toBe("session");
  });

  it("focuses an existing office tab instead of opening a second bridge", async () => {
    const activate = vi.fn(async () => ({ tabs: [], activeTabId: "office-1" }));
    const create = vi.fn(async () => ({ tabs: [], activeTabId: null }));
    (
      window.pi as unknown as { sessions: { activate: unknown; create: unknown } }
    ).sessions.activate = activate;
    (window.pi as unknown as { sessions: { activate: unknown; create: unknown } }).sessions.create =
      create;
    useAppStore.setState({
      tabs: [
        {
          id: "office-1",
          kind: "office",
          cwd: PROJECT,
          title: "Office",
          sessionFile: null,
          status: "idle",
          createdAt: 1,
          lastActiveAt: 1,
          model: null,
        },
      ],
    });

    await useAppStore.getState().openOfficeSession();

    expect(activate).toHaveBeenCalledWith("office-1");
    expect(create).not.toHaveBeenCalled();
    expect(useAppStore.getState().view).toBe("session");
  });

  it("asks for a project first when none is open", async () => {
    useAppStore.setState({ project: null });

    await useAppStore.getState().openOfficeSession();

    expect(useAppStore.getState().hint).toMatch(/choose a project first/i);
  });
});
