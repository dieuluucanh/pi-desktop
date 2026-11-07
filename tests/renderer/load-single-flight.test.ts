import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import { installBridge } from "./fixtures";

/**
 * Loader single-flight (2026-11-07 host-singleton plan).
 *
 * Every control-addressed loader was guarded only by its `*Loaded` flag, which
 * is still false while the first response is in flight. React StrictMode mounts
 * effects twice in dev and the welcome/session surfaces ask for the same state,
 * so several callers issued the same host request from one tick — those were the
 * concurrent `controlHost()` callers that raced the supervisor into spawning a
 * host each. These tests pin "one request per burst".
 */

const PROJECT = "C:/work/app";

function tabRecord(overrides: Partial<TabRecord> = {}): TabRecord {
  return {
    id: "tab-1",
    kind: "session",
    cwd: PROJECT,
    title: "app",
    sessionFile: "C:/profile/sessions/s1.jsonl",
    status: "idle",
    createdAt: 1,
    lastActiveAt: 1,
    model: "test-model",
    ...overrides,
  };
}

function settingsSnapshot() {
  return {
    settings: { global: { theme: "dark" }, project: {} },
    errors: [],
    files: {
      global: { path: "C:/profile/settings.json", exists: true, mtimeMs: 1 },
      project: { path: `${PROJECT}/.pi/settings.json`, exists: false, mtimeMs: 0 },
    },
    projectTrusted: true,
  };
}

interface Call {
  tabId: string;
  method: string;
  params?: unknown;
}

function stubSessions(options: { tabs?: TabRecord[]; activeTabId?: string | null } = {}) {
  const calls: Call[] = [];
  const list = vi.fn(async () => ({
    tabs: options.tabs ?? [],
    activeTabId: options.activeTabId ?? null,
    revision: 1,
    selectionSeq: 1,
  }));
  const request = vi.fn(async (input: Call) => {
    calls.push(input);
    // One microtask: the in-flight window the old guards missed.
    await Promise.resolve();
    if (input.method === "settings.get") return settingsSnapshot();
    if (input.method === "providers.list") return { providers: [] };
    return {};
  });
  const sessions = (window.pi as unknown as { sessions: Record<string, unknown> }).sessions;
  sessions.list = list;
  sessions.request = request;
  return { calls, list, request };
}

function callsOf(calls: Call[], method: string): Call[] {
  return calls.filter((call) => call.method === method);
}

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    project: { path: PROJECT, name: "app" },
    tabs: [],
    tabsLoaded: false,
    activeTabId: null,
    providers: [],
    providersLoaded: false,
    providersError: null,
    settings: null,
    settingsLoaded: false,
    settingsBusy: false,
    settingsError: null,
    settingsCwd: null,
    themesLoaded: false,
    themesBusy: false,
    themesError: null,
    resourcesLoaded: false,
    resourcesBusy: false,
    resourcesError: null,
    resourcesTabId: null,
    resourcesCwd: null,
    packages: [],
    packagesLoaded: false,
    packagesBusy: false,
    packagesError: null,
    packagesCwd: null,
  });
});

describe("loader single-flight", () => {
  it("reads providers once for a burst of callers", async () => {
    const { calls } = stubSessions();

    await Promise.all(Array.from({ length: 3 }, () => useAppStore.getState().loadProviders()));

    const providerCalls = callsOf(calls, "providers.list");
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]?.tabId).toBe("control");
    expect(useAppStore.getState().providersLoaded).toBe(true);
  });

  it("reads settings once for a burst of callers and still refreshes later", async () => {
    const { calls } = stubSessions();

    await Promise.all(Array.from({ length: 3 }, () => useAppStore.getState().loadSettings()));
    expect(callsOf(calls, "settings.get")).toHaveLength(1);

    await useAppStore.getState().loadSettings({ refresh: true });
    expect(callsOf(calls, "settings.get")).toHaveLength(2);
  });

  it("reads the tab table once for concurrent readers", async () => {
    const { list } = stubSessions({ tabs: [tabRecord()], activeTabId: "tab-1" });

    await Promise.all(Array.from({ length: 3 }, () => useAppStore.getState().loadTabs()));

    expect(list).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().tabsLoaded).toBe(true);
    expect(useAppStore.getState().tabs.map((tab) => tab.id)).toEqual(["tab-1"]);
  });

  it("waits for the tab table before choosing the theme target", async () => {
    const { calls, list } = stubSessions({ tabs: [tabRecord()], activeTabId: "tab-1" });

    // Both callers start before any tab table exists: the old code resolved the
    // target to `control` and raced the very push that would have provided one.
    await Promise.all([useAppStore.getState().loadThemes(), useAppStore.getState().loadThemes()]);

    expect(list).toHaveBeenCalledTimes(1);
    const themeCalls = callsOf(calls, "themes.list");
    expect(themeCalls).toHaveLength(1);
    expect(themeCalls[0]?.tabId).toBe("tab-1");
  });

  it("reads resources once and targets the restored session tab", async () => {
    const { calls } = stubSessions({ tabs: [tabRecord()], activeTabId: "tab-1" });

    await Promise.all(Array.from({ length: 3 }, () => useAppStore.getState().loadResources()));

    const resourceCalls = callsOf(calls, "resources.list");
    expect(resourceCalls).toHaveLength(1);
    expect(resourceCalls[0]?.tabId).toBe("tab-1");
  });

  it("reads packages once for a burst of callers", async () => {
    const { calls } = stubSessions();

    await Promise.all(Array.from({ length: 3 }, () => useAppStore.getState().loadPackages()));

    const packageCalls = callsOf(calls, "packages.list");
    expect(packageCalls).toHaveLength(1);
    expect(packageCalls[0]?.tabId).toBe("control");
  });

  it("keeps the burst to one request when surfaces mount in StrictMode order", async () => {
    const { calls } = stubSessions({ tabs: [tabRecord()], activeTabId: "tab-1" });
    const state = useAppStore.getState();

    // The boot shape: providers (WelcomeView ×2), themes (App effect) and
    // settings (a wizard/settings surface) all fire before the first response.
    await Promise.all([
      state.loadProviders(),
      state.loadProviders(),
      state.loadThemes(),
      state.loadSettings(),
      state.loadSettings(),
    ]);

    expect(calls).toHaveLength(3);
    expect(callsOf(calls, "providers.list")).toHaveLength(1);
    expect(callsOf(calls, "themes.list")).toHaveLength(1);
    expect(callsOf(calls, "settings.get")).toHaveLength(1);
  });
});
