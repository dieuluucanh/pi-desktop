import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { SettingsSnapshot } from "../../src/shared/settings";
import { installBridge } from "./fixtures";

/**
 * The settings store actions (plan step 12). These assert what reaches the
 * control host and how a snapshot updates the store; the SDK owns the files.
 */

const PROJECT = "C:/work/app";

function snapshot(overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
  return {
    settings: { global: { theme: "dark" }, project: {} },
    errors: [],
    files: {
      global: { path: "/profile/agent/settings.json", exists: true, mtimeMs: 100 },
      project: { path: `${PROJECT}/.pi/settings.json`, exists: true, mtimeMs: 200 },
    },
    projectTrusted: true,
    ...overrides,
  };
}

function stubRequest(impl?: (method: string, params?: unknown) => Promise<unknown>) {
  const request = vi.fn(async (input: { method: string; params?: unknown }) => {
    if (impl) return impl(input.method, input.params);
    return snapshot();
  });
  (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
  return request;
}

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    project: { path: PROJECT, name: "app" },
    settingsCwd: null,
    settings: null,
    settingsLoaded: false,
    settingsBusy: false,
    settingsError: null,
    settingsErrors: [],
    settingsFiles: null,
    settingsProjectTrusted: true,
    settingsMtimes: { global: null, project: null },
    settingsExternalEdit: false,
    view: "settings",
  });
});

describe("settings store", () => {
  it("loads both scopes for the active project", async () => {
    const request = stubRequest();
    await useAppStore.getState().loadSettings();

    expect(request).toHaveBeenCalledWith({
      tabId: "control",
      method: "settings.get",
      params: { cwd: PROJECT },
    });
    const state = useAppStore.getState();
    expect(state.settings?.global).toMatchObject({ theme: "dark" });
    expect(state.settingsLoaded).toBe(true);
    expect(state.settingsMtimes).toEqual({ global: 100, project: 200 });
    expect(state.settingsProjectTrusted).toBe(true);
  });

  it("skips a redundant load for the same project", async () => {
    const request = stubRequest();
    await useAppStore.getState().loadSettings();
    await useAppStore.getState().loadSettings();
    expect(request).toHaveBeenCalledTimes(1);
    await useAppStore.getState().loadSettings({ refresh: true });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("writes one key in one scope and applies the returned snapshot", async () => {
    const request = stubRequest((method) =>
      Promise.resolve(
        method === "settings.set"
          ? snapshot({ settings: { global: { theme: "light" }, project: {} } })
          : snapshot(),
      ),
    );
    const ok = await useAppStore.getState().setSetting("theme", "light", "global");

    expect(ok).toBe(true);
    expect(request).toHaveBeenCalledWith({
      tabId: "control",
      method: "settings.set",
      params: { cwd: PROJECT, key: "theme", value: "light", scope: "global" },
    });
    expect(useAppStore.getState().settings?.global.theme).toBe("light");
  });

  it("records an error and returns false when a write is refused", async () => {
    stubRequest(() => Promise.reject(new Error("httpProxy is a global-only setting")));
    const ok = await useAppStore.getState().setSetting("httpProxy", "http://x", "project");
    expect(ok).toBe(false);
    expect(useAppStore.getState().settingsError).toMatch(/global-only/);
  });

  it("writes a raw scope document", async () => {
    const request = stubRequest();
    await useAppStore.getState().writeRawSettings("project", { theme: "light" });
    expect(request).toHaveBeenCalledWith({
      tabId: "control",
      method: "settings.raw",
      params: { cwd: PROJECT, scope: "project", document: { theme: "light" } },
    });
  });

  it("resets a key to its documented default, or deletes it", async () => {
    const request = stubRequest();
    await useAppStore.getState().resetSetting("theme", "global");
    expect(request).toHaveBeenLastCalledWith({
      tabId: "control",
      method: "settings.set",
      params: { cwd: PROJECT, key: "theme", value: "dark", scope: "global" },
    });
    await useAppStore.getState().resetSetting("httpProxy", "global");
    expect(request).toHaveBeenLastCalledWith({
      tabId: "control",
      method: "settings.set",
      params: { cwd: PROJECT, key: "httpProxy", value: undefined, scope: "global" },
    });
  });

  it("resets a scope to defaults globally and to no overrides in a project", async () => {
    const request = stubRequest();
    await useAppStore.getState().resetScope("project");
    expect(request).toHaveBeenLastCalledWith({
      tabId: "control",
      method: "settings.raw",
      params: { cwd: PROJECT, scope: "project", document: {} },
    });
    await useAppStore.getState().resetScope("global");
    const call = request.mock.calls.at(-1)?.[0] as unknown as {
      params: { document: Record<string, unknown> };
    };
    expect(call.params.document.theme).toBe("dark");
    expect(call.params.document.compaction).toMatchObject({ reserveTokens: 16384 });
  });

  it("detects an external edit by mtime and can reload it", async () => {
    let mtime = 100;
    stubRequest((method) => {
      if (method === "settings.get") {
        const base = snapshot();
        return Promise.resolve({
          ...base,
          files: {
            global: { ...base.files.global, mtimeMs: mtime },
            project: base.files.project,
          },
        });
      }
      return Promise.resolve(snapshot());
    });

    await useAppStore.getState().loadSettings();
    expect(await useAppStore.getState().checkExternalSettingsEdit()).toBe(false);

    mtime = 999;
    expect(await useAppStore.getState().checkExternalSettingsEdit()).toBe(true);
    expect(useAppStore.getState().settingsExternalEdit).toBe(true);

    await useAppStore.getState().reloadSettings();
    expect(useAppStore.getState().settingsExternalEdit).toBe(false);
    expect(useAppStore.getState().settingsMtimes.global).toBe(999);
  });

  it("resolves the effective value with the project override winning", async () => {
    useAppStore.setState({
      settings: { global: { theme: "dark" }, project: { theme: "light" } },
    });
    expect(useAppStore.getState().effectiveSetting("theme")).toBe("light");
    useAppStore.setState({ settings: { global: { theme: "dark" }, project: {} } });
    expect(useAppStore.getState().effectiveSetting("theme")).toBe("dark");
  });
});

describe("queue delivery modes (plan step 9)", () => {
  function sessionTab(id: string, kind: "session" | "web" = "session") {
    return {
      id,
      kind,
      cwd: PROJECT,
      title: id,
      sessionFile: null,
      status: "running" as const,
      createdAt: 0,
      lastActiveAt: 0,
      model: "test-model",
    };
  }

  it("fans a steering/follow-up mode change out to every open Pi tab", async () => {
    const request = stubRequest((method) =>
      Promise.resolve(
        method === "settings.set"
          ? snapshot({
              settings: {
                global: { steeringMode: "all", followUpMode: "all" },
                project: {},
              },
            })
          : snapshot(),
      ),
    );
    useAppStore.setState({
      tabs: [sessionTab("tab-1"), sessionTab("tab-2"), sessionTab("web-1", "web")],
    });

    await useAppStore.getState().setSetting("steeringMode", "all", "global");

    expect(request).toHaveBeenCalledWith({
      tabId: "tab-2",
      method: "session.queueMode",
      params: { kind: "steering", mode: "all" },
    });
    expect(request).toHaveBeenCalledWith({
      tabId: "tab-2",
      method: "session.queueMode",
      params: { kind: "followUp", mode: "all" },
    });
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ tabId: "web-1" }));
  });

  it("reads the project scope first and tolerates a dead tab", async () => {
    const request = stubRequest((method) => {
      if (method === "settings.set") {
        return Promise.resolve(
          snapshot({
            settings: { global: { steeringMode: "all" }, project: { followUpMode: "all" } },
          }),
        );
      }
      return Promise.resolve(snapshot());
    });
    useAppStore.setState({ tabs: [sessionTab("tab-1"), sessionTab("tab-2")] });
    request.mockImplementation(async (input: { tabId?: string; method: string }) => {
      if (input.method === "session.queueMode" && input.tabId === "tab-2") {
        throw new Error("host gone");
      }
      if (input.method === "settings.set") {
        return snapshot({
          settings: { global: { steeringMode: "all" }, project: { followUpMode: "all" } },
        });
      }
      return snapshot();
    });

    await expect(useAppStore.getState().setSetting("followUpMode", "all", "project")).resolves.toBe(
      true,
    );
  });
});
