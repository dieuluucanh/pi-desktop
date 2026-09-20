import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { SettingsSnapshot } from "../../src/shared/settings";
import type { ResourcesSnapshot } from "../../src/shared/resources";
import { installBridge } from "./fixtures";

/**
 * The Extensions hub store actions (plan step 13). They decide which host answers
 * (live session vs control host), how an enable/disable becomes a settings-array
 * edit, and what a runtime reload reports — the SDK and Pi own the files.
 */

const PROJECT = "C:/work/app";

function settingsSnapshot(global: Record<string, unknown> = {}): SettingsSnapshot {
  return {
    settings: { global, project: {} },
    errors: [],
    files: {
      global: { path: "/profile/agent/settings.json", exists: true, mtimeMs: 100 },
      project: { path: `${PROJECT}/.pi/settings.json`, exists: true, mtimeMs: 200 },
    },
    projectTrusted: true,
  };
}

function resourcesSnapshot(overrides: Partial<ResourcesSnapshot> = {}): Partial<ResourcesSnapshot> {
  return {
    cwd: PROJECT,
    scope: "control",
    resources: [
      {
        id: "extensions:C:/res/foo/index.ts",
        kind: "extensions",
        name: "index.ts",
        path: "C:/res/foo/index.ts",
        overridePath: "C:/res/foo/index.ts",
        source: "user",
        scope: "user",
        origin: "top-level",
        settingsKey: "extensions",
        enabled: true,
      },
    ],
    overrides: [],
    diagnostics: [],
    runtimeErrors: [],
    loadedAt: 42,
    ...overrides,
  };
}

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
    prefs: { ...DEFAULT_PREFS },
    project: { path: PROJECT, name: "app" },
    tabs: [],
    activeTabId: null,
    settings: null,
    settingsLoaded: false,
    settingsBusy: false,
    settingsError: null,
    resources: {
      cwd: null,
      scope: "control",
      resources: [],
      overrides: [],
      diagnostics: [],
      runtimeErrors: [],
      loadedAt: 0,
    },
    resourcesLoaded: false,
    resourcesBusy: false,
    resourcesError: null,
    resourcesTabId: null,
    resourcesCwd: null,
    resourcesChange: null,
    view: "extensions",
  });
}

beforeEach(resetStore);

describe("resources store", () => {
  it("asks the control host for the active project's resources", async () => {
    const request = stubRequest(async (method) =>
      method === "resources.list" ? resourcesSnapshot() : settingsSnapshot(),
    );
    await useAppStore.getState().loadResources();

    expect(request).toHaveBeenCalledWith({
      tabId: "control",
      method: "resources.list",
      params: { cwd: PROJECT, refresh: false },
    });
    const state = useAppStore.getState();
    expect(state.resourcesLoaded).toBe(true);
    expect(state.resources.resources[0]?.name).toBe("index.ts");
    expect(state.resourcesTabId).toBe("control");
    expect(state.resourcesCwd).toBe(PROJECT);
  });

  it("prefers the active session tab so the hub shows live resources", async () => {
    const request = stubRequest(async () => resourcesSnapshot({ scope: "session" }));
    useAppStore.setState({
      tabs: [
        {
          id: "tab-1",
          kind: "session",
          cwd: PROJECT,
          title: "app",
          sessionFile: null,
          status: "idle",
          createdAt: 1,
          lastActiveAt: 1,
          model: null,
        },
      ],
      activeTabId: "tab-1",
    });
    await useAppStore.getState().loadResources();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: "tab-1", method: "resources.list" }),
    );
  });

  it("skips a redundant load and honors an explicit refresh", async () => {
    const request = stubRequest(async () => resourcesSnapshot());
    await useAppStore.getState().loadResources();
    await useAppStore.getState().loadResources();
    expect(request).toHaveBeenCalledTimes(1);
    await useAppStore.getState().loadResources({ refresh: true });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("records a readable error when the host has no inspector", async () => {
    stubRequest(async () => {
      throw new Error("resources.list is not available in this host");
    });
    await useAppStore.getState().loadResources();
    expect(useAppStore.getState().resourcesError).toMatch(/not available/);
    expect(useAppStore.getState().resourcesBusy).toBe(false);
  });

  it("disables a loaded resource with a -path settings entry, then reloads", async () => {
    const request = stubRequest(async (method, params) => {
      if (method === "resources.list") return resourcesSnapshot();
      if (method === "settings.get") return settingsSnapshot();
      if (method === "settings.set") {
        const input = params as { value: string[] };
        return settingsSnapshot({ extensions: [...input.value] });
      }
      return {};
    });

    const ok = await useAppStore.getState().toggleResource(
      {
        id: "extensions:C:/res/foo/index.ts",
        kind: "extensions",
        name: "index.ts",
        path: "C:/res/foo/index.ts",
        overridePath: "C:/res/foo/index.ts",
        source: "user",
        scope: "user",
        origin: "top-level",
        settingsKey: "extensions",
        enabled: true,
      },
      false,
    );

    expect(ok).toBe(true);
    expect(request).toHaveBeenCalledWith({
      tabId: "control",
      method: "settings.set",
      params: { cwd: PROJECT, key: "extensions", value: ["-C:/res/foo/index.ts"], scope: "global" },
    });
    // The toggle re-lists with a forced refresh so the card reflects reality.
    const refreshCall = request.mock.calls.at(-1)?.[0] as { method: string; params: unknown };
    expect(refreshCall.method).toBe("resources.list");
    expect(refreshCall.params).toEqual({ cwd: PROJECT, refresh: true });
  });

  it("re-enables a project resource through the project scope", async () => {
    const request = stubRequest(async (method) => {
      if (method === "resources.list") return resourcesSnapshot();
      if (method === "settings.get")
        return { ...settingsSnapshot(), settings: { global: {}, project: {} } };
      if (method === "settings.set") return settingsSnapshot();
      return {};
    });

    await useAppStore.getState().toggleResource(
      {
        id: "skills:C:/p/.pi/skills/x/SKILL.md",
        kind: "skills",
        name: "x",
        path: "C:/p/.pi/skills/x/SKILL.md",
        overridePath: "C:/p/.pi/skills/x/SKILL.md",
        source: "-C:/p/.pi/skills/x/SKILL.md",
        scope: "project",
        origin: "top-level",
        settingsKey: "skills",
        enabled: false,
        override: "-C:/p/.pi/skills/x/SKILL.md",
      },
      true,
    );

    expect(request).toHaveBeenCalledWith({
      tabId: "control",
      method: "settings.set",
      params: {
        cwd: PROJECT,
        key: "skills",
        value: ["+C:/p/.pi/skills/x/SKILL.md"],
        scope: "project",
      },
    });
  });

  it("reloads a live runtime and reports what changed", async () => {
    const request = stubRequest(async (method) => {
      if (method === "session.reload") return {};
      if (method === "resources.list") {
        return resourcesSnapshot({
          resources: [
            ...(resourcesSnapshot().resources ?? []),
            {
              id: "skills:C:/res/skills/new/SKILL.md",
              kind: "skills",
              name: "new",
              path: "C:/res/skills/new/SKILL.md",
              overridePath: "C:/res/skills/new/SKILL.md",
              source: "user",
              scope: "user",
              origin: "top-level",
              settingsKey: "skills",
              enabled: true,
            },
          ],
        });
      }
      return {};
    });
    useAppStore.setState({
      tabs: [
        {
          id: "tab-1",
          kind: "session",
          cwd: PROJECT,
          title: "app",
          sessionFile: null,
          status: "idle",
          createdAt: 1,
          lastActiveAt: 1,
          model: null,
        },
      ],
      activeTabId: "tab-1",
      resources: {
        cwd: PROJECT,
        scope: "session",
        resources: resourcesSnapshot().resources as never,
        overrides: [],
        diagnostics: [],
        runtimeErrors: [],
        loadedAt: 1,
      },
      resourcesLoaded: true,
      resourcesTabId: "tab-1",
      resourcesCwd: PROJECT,
    });

    await useAppStore.getState().reloadResources();

    const methods = request.mock.calls.map((call) => (call[0] as { method: string }).method);
    expect(methods).toContain("session.reload");
    expect(useAppStore.getState().resourcesChange?.added.map((entry) => entry.name)).toEqual([
      "new",
    ]);
  });
});
