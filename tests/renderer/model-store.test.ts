import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import { installBridge } from "./fixtures";

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

function stubRequest(impl?: (input: { method: string; params?: unknown }) => Promise<unknown>) {
  const request = vi.fn(async (input: { method: string; params?: unknown }) => {
    if (input.method === "model.available") {
      return {
        models: [
          { id: "claude-sonnet-4-5", provider: "anthropic", name: "Sonnet 4.5" },
          { model: { id: "gpt-5", provider: "openai", name: "GPT-5" }, thinkingLevel: "high" },
        ],
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
    tabs: [tab()],
    activeTabId: "tab-1",
    sessionStates: {},
    modelCatalog: {},
    providerAuth: {},
    thinkingLevels: {},
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

  it("refreshes settings after a persisted pick, and not for a session-only one", async () => {
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
  it("keeps a favourite and persists the list", async () => {
    const set = vi.fn(async () => ({}));
    (window.pi as unknown as { prefs: { set: unknown } }).prefs.set = set;

    useAppStore.getState().toggleFavorite("anthropic/claude-sonnet-4-5");

    expect(useAppStore.getState().prefs.favoriteModels).toEqual(["anthropic/claude-sonnet-4-5"]);
    expect(set).toHaveBeenCalledWith({ favoriteModels: ["anthropic/claude-sonnet-4-5"] });

    // Toggling again removes it.
    useAppStore.getState().toggleFavorite("anthropic/claude-sonnet-4-5");
    expect(useAppStore.getState().prefs.favoriteModels).toEqual([]);
  });

  it("persists the view mode per app, not per session", async () => {
    const set = vi.fn(async () => ({}));
    (window.pi as unknown as { prefs: { set: unknown } }).prefs.set = set;

    useAppStore.getState().setViewMode("verbose");

    expect(useAppStore.getState().prefs.viewMode).toBe("verbose");
    expect(set).toHaveBeenCalledWith({ viewMode: "verbose" });
  });
});
