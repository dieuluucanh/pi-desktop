import { beforeEach, describe, expect, it, vi } from "vitest";
import { HOST_STALE_MESSAGE, useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import { appInfoFixture, installBridge } from "./fixtures";

/**
 * Model/thinking/usage actions (plan step 8). These assert what reaches the host
 * and what the app remembers — the SDK owns the actual model switch.
 */

function tab(): TabRecord {
  return {
    id: "tab-1",
    kind: "session",
    cwd: "/work/app",
    title: "app",
    sessionFile: "/profile/s1.jsonl",
    status: "idle",
    createdAt: 0,
    lastActiveAt: 0,
    model: "claude-sonnet-4-5",
  };
}

function stubRequest(
  impl?: (input: { method: string; tabId?: string; params?: unknown }) => Promise<unknown>,
) {
  const request = vi.fn(async (input: { method: string; tabId?: string; params?: unknown }) => {
    if (input.method === "model.available") {
      return {
        models: [
          { id: "claude-sonnet-4-5", provider: "anthropic", name: "Sonnet 4.5" },
          { model: { id: "gpt-5", provider: "openai", name: "GPT-5" }, thinkingLevel: "high" },
        ],
        scoped: [{ model: { id: "gpt-5", provider: "openai" }, thinkingLevel: "high" }],
        auth: { anthropic: { configured: true, source: "stored" }, openai: { configured: false } },
        thinkingLevels: ["off", "low", "high"],
      };
    }
    if (input.method === "model.set") {
      return { model: { id: "gpt-5" }, thinkingLevels: ["off", "high"] };
    }
    return impl ? impl(input) : {};
  });
  (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
  return request;
}

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    info: appInfoFixture(),
    mainOutdated: null,
    tabs: [tab()],
    activeTabId: "tab-1",
    sessionStates: {},
    modelCatalog: {},
    providerAuth: {},
    thinkingLevels: {},
    modelScope: {},
    modelScopeBusy: {},
    picker: null,
    pickerError: null,
    pickerSearch: "",
    connectionsFocus: null,
    view: "session",
    hint: null,
  });
});

describe("loadModels", () => {
  it("normalises the catalog, the auth map and the thinking levels", async () => {
    stubRequest();
    await useAppStore.getState().loadModels("tab-1");

    const state = useAppStore.getState();
    expect(state.modelCatalog["tab-1"]?.map((entry) => entry.key)).toEqual([
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5",
    ]);
    // The scoped wrapper's thinking level survives normalisation.
    expect(state.modelCatalog["tab-1"]?.[1]?.thinkingLevel).toBe("high");
    expect(state.providerAuth["tab-1"]?.["openai"]).toMatchObject({ configured: false });
    expect(state.thinkingLevels["tab-1"]).toEqual(["off", "low", "high"]);
    // The live scope is what the dialog's stars and the extension pickers use.
    expect(state.modelScope["tab-1"]).toEqual(["openai/gpt-5"]);
  });

  it("reports a host failure as a hint instead of throwing", async () => {
    const request = vi.fn(async () => {
      throw new Error("no session");
    });
    (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
    await useAppStore.getState().loadModels("tab-1");
    expect(useAppStore.getState().hint).toMatch(/no session/);
  });
});

describe("model scope", () => {
  it("writes one star toggle and refreshes the other session tabs", async () => {
    const request = stubRequest(async (input) => {
      if (input.method === "model.scope.toggle") {
        return { scoped: [{ model: { provider: "openai", id: "gpt-5" } }] };
      }
      if (input.method === "model.scope.apply") {
        return { scoped: [{ model: { provider: "anthropic", id: "claude" } }] };
      }
      return {};
    });
    useAppStore.setState({
      tabs: [tab(), { ...tab(), id: "tab-2" }],
      modelScope: { "tab-1": ["anthropic/claude"], "tab-2": ["anthropic/claude"] },
    });

    await useAppStore.getState().toggleModelScope("tab-1", "openai", "gpt-5");

    expect(request).toHaveBeenCalledWith({
      tabId: "tab-1",
      method: "model.scope.toggle",
      params: { provider: "openai", id: "gpt-5", enabled: true },
    });
    expect(request).toHaveBeenCalledWith({ tabId: "tab-2", method: "model.scope.apply" });
    const state = useAppStore.getState();
    expect(state.modelScope["tab-1"]).toEqual(["openai/gpt-5"]);
    expect(state.modelScope["tab-2"]).toEqual(["anthropic/claude"]);
    expect(state.modelScopeBusy["tab-1"]).toBeUndefined();
  });

  it("rolls the star back when the host refuses the write", async () => {
    stubRequest(async (input) => {
      if (input.method === "model.scope.toggle") throw new Error("settings write failed");
      return {};
    });
    useAppStore.setState({ modelScope: { "tab-1": ["anthropic/claude"] } });

    await useAppStore.getState().toggleModelScope("tab-1", "openai", "gpt-5");

    const state = useAppStore.getState();
    expect(state.modelScope["tab-1"]).toEqual(["anthropic/claude"]);
    expect(state.pickerError).toMatch(/settings write failed/);
    expect(state.hint).toMatch(/settings write failed/);
  });

  it("surfaces a stale host that lacks model scope as the existing banner", async () => {
    stubRequest(async (input) => {
      if (input.method === "model.scope.toggle") {
        throw new Error("unknown method: model.scope.toggle");
      }
      return {};
    });
    useAppStore.setState({ modelScope: { "tab-1": ["anthropic/claude"] } });

    await useAppStore.getState().toggleModelScope("tab-1", "openai", "gpt-5");

    const state = useAppStore.getState();
    expect(state.modelScope["tab-1"]).toEqual(["anthropic/claude"]);
    expect(state.staleHosts["tab-1"]).toBe(HOST_STALE_MESSAGE);
  });

  it("does not call the host when main predates model scope", async () => {
    const request = stubRequest();
    useAppStore.getState().setInfo(appInfoFixture({ hostMethods: [] }));
    useAppStore.setState({ modelScope: { "tab-1": ["anthropic/claude"] } });

    await useAppStore.getState().toggleModelScope("tab-1", "openai", "gpt-5");

    expect(request).not.toHaveBeenCalled();
    const state = useAppStore.getState();
    expect(state.modelScope["tab-1"]).toEqual(["anthropic/claude"]);
    expect(state.pickerError).toMatch(/newer than the app's main process/);
    expect(state.mainOutdated).toMatch(/Restart the app/);
  });

  it("opens the unified picker for /scoped-models without selecting a model", async () => {
    const request = stubRequest();

    const outcome = await useAppStore.getState().runCommandInput("tab-1", "/scoped-models gpt");

    expect(outcome).toEqual({ handled: true, sent: false });
    expect(useAppStore.getState().picker).toBe("model");
    expect(useAppStore.getState().pickerSearch).toBe("gpt");
    expect(request.mock.calls.some((call) => call[0]?.method === "model.set")).toBe(false);
  });

  it("marks main outdated from AppInfo and clears it for a current build", () => {
    useAppStore.getState().setInfo(appInfoFixture({ hostMethods: ["model.scope.apply"] }));
    expect(useAppStore.getState().mainOutdated).toMatch(/Restart the app/);

    useAppStore
      .getState()
      .setInfo(appInfoFixture({ hostMethods: ["model.scope.apply", "model.scope.toggle"] }));
    expect(useAppStore.getState().mainOutdated).toBeNull();
  });

  it("ignores a second star while a write is in flight", async () => {
    const request = stubRequest();
    useAppStore.setState({
      modelScope: { "tab-1": ["anthropic/claude"] },
      modelScopeBusy: { "tab-1": "openai/gpt-5" },
    });

    await useAppStore.getState().toggleModelScope("tab-1", "openai", "gpt-5");

    expect(request).not.toHaveBeenCalled();
    expect(useAppStore.getState().modelScope["tab-1"]).toEqual(["anthropic/claude"]);
  });

  it("applies the refresh to every other session tab and ignores a dead one", async () => {
    const request = stubRequest(async (input) => {
      if (input.method !== "model.scope.apply") return {};
      if (input.tabId === "tab-3") throw new Error("host gone");
      return { scoped: [{ model: { provider: "fake", id: "fake-2" } }] };
    });
    useAppStore.setState({
      tabs: [
        tab(),
        { ...tab(), id: "tab-2" },
        { ...tab(), id: "tab-3" },
        { ...tab(), id: "web-1", kind: "web" },
      ],
    });

    await useAppStore.getState().applyModelScopeToTabs("tab-1");

    const state = useAppStore.getState();
    expect(state.modelScope["tab-2"]).toEqual(["fake/fake-2"]);
    expect(state.modelScope["tab-3"]).toBeUndefined();
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ tabId: "tab-1" }));
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ tabId: "web-1" }));
  });

  it("fans out to office tabs but never to a web tab", async () => {
    const request = stubRequest(async (input) => {
      if (input.method !== "model.scope.apply") return {};
      return { scoped: [{ model: { provider: "fake", id: "fake-2" } }] };
    });
    useAppStore.setState({
      tabs: [
        tab(),
        { ...tab(), id: "office-1", kind: "office" },
        { ...tab(), id: "web-1", kind: "web" },
      ],
    });

    await useAppStore.getState().applyModelScopeToTabs("tab-1");

    expect(request).toHaveBeenCalledWith({ tabId: "office-1", method: "model.scope.apply" });
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ tabId: "web-1" }));
    expect(useAppStore.getState().modelScope["office-1"]).toEqual(["fake/fake-2"]);
  });

  it("re-applies the scope to open sessions after a Settings edit", async () => {
    const request = stubRequest(async (input) => {
      if (input.method === "model.scope.apply") return { scoped: [] };
      if (input.method === "settings.set") {
        return {
          settings: { global: { enabledModels: [] }, project: {} },
          errors: [],
          files: {
            global: { path: "/profile/settings.json", exists: true, mtimeMs: 1 },
            project: { path: "/work/app/.pi/settings.json", exists: false, mtimeMs: 0 },
          },
          projectTrusted: true,
        };
      }
      return {};
    });

    const ok = await useAppStore.getState().setSetting("enabledModels", [], "global");

    expect(ok).toBe(true);
    expect(request).toHaveBeenCalledWith({ tabId: "tab-1", method: "model.scope.apply" });
  });

  it("does not re-apply the scope for an unrelated setting", async () => {
    const request = stubRequest(async (input) => {
      if (input.method === "settings.set") {
        return {
          settings: { global: { theme: "light" }, project: {} },
          errors: [],
          files: {
            global: { path: "/profile/settings.json", exists: true, mtimeMs: 1 },
            project: { path: "/work/app/.pi/settings.json", exists: false, mtimeMs: 0 },
          },
          projectTrusted: true,
        };
      }
      return {};
    });

    await useAppStore.getState().setSetting("theme", "light", "global");
    expect(request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "model.scope.apply" }),
    );
  });
});

describe("applySessionState", () => {
  it("refreshes the thinking-level cache from a state frame", () => {
    useAppStore.setState({ thinkingLevels: { "tab-1": ["off", "low"] } });

    useAppStore.getState().applySessionState({
      tabId: "tab-1",
      state: { model: { provider: "openai", id: "gpt-5" }, thinkingLevels: ["off", "high"] },
    });

    expect(useAppStore.getState().thinkingLevels["tab-1"]).toEqual(["off", "high"]);
    expect(useAppStore.getState().sessionStates["tab-1"]).toMatchObject({
      model: { provider: "openai", id: "gpt-5" },
    });
  });

  it("keeps the cached list when the frame reports the same levels", () => {
    const levels = ["off", "low"];
    useAppStore.setState({ thinkingLevels: { "tab-1": levels } });

    useAppStore.getState().applySessionState({
      tabId: "tab-1",
      state: { thinkingLevels: ["off", "low"] },
    });

    // A new array on every `message_end` would re-render the thinking picker.
    expect(useAppStore.getState().thinkingLevels["tab-1"]).toBe(levels);
  });

  it("leaves the cache alone when the snapshot has no thinking levels", () => {
    const levels = ["off", "low"];
    useAppStore.setState({ thinkingLevels: { "tab-1": levels } });

    useAppStore.getState().applySessionState({
      tabId: "tab-1",
      state: { model: { provider: "openai", id: "gpt-5" } },
    });

    expect(useAppStore.getState().thinkingLevels["tab-1"]).toBe(levels);
  });
});

describe("setModel", () => {
  it("sends the raw model with the persist flag and closes the picker", async () => {
    const request = stubRequest();
    await useAppStore.getState().loadModels("tab-1");
    const entry = useAppStore.getState().modelCatalog["tab-1"]?.[1];
    expect(entry).toBeDefined();

    await useAppStore.getState().setModel("tab-1", entry!, { persist: true });

    const call = request.mock.calls.find((entryCall) => entryCall[0]?.method === "model.set");
    // The bare model object, not the scoped wrapper the catalog received.
    expect(call?.[0]?.params).toEqual({
      model: { id: "gpt-5", provider: "openai", name: "GPT-5" },
      persist: true,
    });
    expect(useAppStore.getState().picker).toBeNull();
  });

  it("refreshes settings only when the call asks Pi to persist the default", async () => {
    const request = stubRequest();
    const loadSettings = vi.fn(async () => undefined);
    useAppStore.setState({ loadSettings });
    const entry = { key: "openai/gpt-5", id: "gpt-5", provider: "openai", label: "GPT-5", raw: {} };

    await useAppStore.getState().setModel("tab-1", entry);
    expect(loadSettings).not.toHaveBeenCalled();

    await useAppStore.getState().setModel("tab-1", entry, { persist: true });
    expect(loadSettings).toHaveBeenCalledWith({ refresh: true });
    expect(request).toHaveBeenCalled();
  });

  it("re-reads thinking levels from the state the host returns", async () => {
    stubRequest();
    useAppStore.setState({ thinkingLevels: { "tab-1": ["off", "low", "high"] } });
    const entry = { key: "openai/gpt-5", id: "gpt-5", provider: "openai", label: "GPT-5", raw: {} };

    await useAppStore.getState().setModel("tab-1", entry);

    // A model change can remove levels, so the clamp is refreshed rather than reused.
    expect(useAppStore.getState().thinkingLevels["tab-1"]).toEqual(["off", "high"]);
  });

  it("applies the model.set response snapshot without waiting for a state event", async () => {
    stubRequest();
    const entry = { key: "openai/gpt-5", id: "gpt-5", provider: "openai", label: "GPT-5", raw: {} };

    await useAppStore.getState().setModel("tab-1", entry);

    expect(useAppStore.getState().sessionStates["tab-1"]).toMatchObject({
      model: { id: "gpt-5" },
    });
  });

  it("keeps the picker open and records the error when model.set is rejected", async () => {
    const request = vi.fn(async (input: { method: string }) => {
      if (input.method === "model.set") throw new Error("No API key for synthetic/other-model");
      return {};
    });
    (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
    useAppStore.setState({ picker: "model", pickerError: null });
    const entry = {
      key: "synthetic/other-model",
      id: "other-model",
      provider: "synthetic",
      label: "Other",
      raw: {},
    };

    await useAppStore.getState().setModel("tab-1", entry);

    expect(useAppStore.getState().picker).toBe("model");
    expect(useAppStore.getState().pickerError).toMatch(/No API key for synthetic\//);
  });
});

describe("setThinking", () => {
  it("sends the level and closes the picker", async () => {
    const request = stubRequest();
    await useAppStore.getState().setThinking("tab-1", "high", { persist: false });

    expect(request.mock.calls[0]?.[0]).toEqual({
      tabId: "tab-1",
      method: "thinking.set",
      params: { level: "high", persist: false },
    });
    expect(useAppStore.getState().picker).toBeNull();
  });
});

describe("built-in command arguments", () => {
  it("/model provider/id sets the exact model", async () => {
    const request = stubRequest();
    const outcome = await useAppStore.getState().runCommandInput("tab-1", "/model openai/gpt-5");

    expect(outcome).toEqual({ handled: true, sent: true });
    const call = request.mock.calls.find((entry) => entry[0]?.method === "model.set");
    expect(call?.[0]?.params).toMatchObject({ model: { provider: "openai", id: "gpt-5" } });
  });

  it("/model query opens the picker with the search prefilled", async () => {
    stubRequest();
    const outcome = await useAppStore.getState().runCommandInput("tab-1", "/model gpt");

    expect(outcome).toEqual({ handled: true, sent: false });
    expect(useAppStore.getState().picker).toBe("model");
    expect(useAppStore.getState().pickerSearch).toBe("gpt");
  });

  it("/thinking level sets an exact level", async () => {
    const request = stubRequest();
    useAppStore.setState({ thinkingLevels: { "tab-1": ["off", "low", "high"] } });
    const outcome = await useAppStore.getState().runCommandInput("tab-1", "/thinking HIGH");

    expect(outcome).toEqual({ handled: true, sent: true });
    const call = request.mock.calls.find((entry) => entry[0]?.method === "thinking.set");
    expect(call?.[0]?.params).toEqual({ level: "high", persist: false });
  });

  it("/thinking unknown reports the available levels", async () => {
    stubRequest();
    useAppStore.setState({ thinkingLevels: { "tab-1": ["off", "high"] }, hint: null });
    const outcome = await useAppStore.getState().runCommandInput("tab-1", "/thinking ultra");

    expect(outcome).toEqual({ handled: true, sent: false });
    expect(useAppStore.getState().hint).toMatch(/Unknown thinking level/);
    expect(useAppStore.getState().hint).toContain("off, high");
  });

  it("/login provider opens that provider's sheet", async () => {
    stubRequest(async (input) =>
      input.method === "providers.list"
        ? {
            providers: [
              {
                id: "anthropic",
                label: "Anthropic",
                authTypes: ["oauth"],
                subscription: true,
                configured: false,
                modelCount: 1,
                envVars: [],
                envAvailable: false,
              },
            ],
          }
        : {},
    );
    useAppStore.setState({ providers: [], providersLoaded: false, connectionsFocus: null });
    const outcome = await useAppStore.getState().runCommandInput("tab-1", "/login anthropic");

    expect(outcome).toEqual({ handled: true, sent: false });
    expect(useAppStore.getState().view).toBe("connections");
    expect(useAppStore.getState().connectionsFocus).toEqual({ providerId: "anthropic" });
  });

  it("/login unknown seeds the Connections search", async () => {
    stubRequest(async () => ({}));
    useAppStore.setState({ providers: [], providersLoaded: true, connectionsFocus: null });
    await useAppStore.getState().runCommandInput("tab-1", "/login without");

    expect(useAppStore.getState().connectionsFocus).toEqual({ query: "without" });
  });
});

describe("cycling", () => {
  it("maps the shortcut direction onto the host's direction", async () => {
    const request = stubRequest();
    await useAppStore.getState().cycleModel("tab-1", 1);
    await useAppStore.getState().cycleModel("tab-1", -1);

    expect(request.mock.calls[0]?.[0]?.params).toEqual({ direction: "forward", persist: false });
    expect(request.mock.calls[1]?.[0]?.params).toEqual({ direction: "backward", persist: false });
  });

  it("cycles the thinking level without persisting it", async () => {
    const request = stubRequest();
    await useAppStore.getState().cycleThinking("tab-1");
    expect(request.mock.calls[0]?.[0]).toEqual({
      tabId: "tab-1",
      method: "thinking.cycle",
      params: { persist: false },
    });
  });
});

describe("renameSession", () => {
  it("trims the name before sending it", async () => {
    const request = stubRequest();
    await useAppStore.getState().renameSession("tab-1", "  Renamed  ");
    expect(request.mock.calls[0]?.[0]?.params).toEqual({ name: "Renamed" });
  });

  it("does nothing for an empty name", async () => {
    const request = stubRequest();
    await useAppStore.getState().renameSession("tab-1", "   ");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("preferences", () => {
  it("persists the view mode per app, not per session", async () => {
    const set = vi.fn(async () => ({}));
    (window.pi as unknown as { prefs: { set: unknown } }).prefs.set = set;

    useAppStore.getState().setViewMode("verbose");

    expect(useAppStore.getState().prefs.viewMode).toBe("verbose");
    expect(set).toHaveBeenCalledWith({ viewMode: "verbose" });
  });
});
