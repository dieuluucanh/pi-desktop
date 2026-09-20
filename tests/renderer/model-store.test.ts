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

  it("re-reads thinking levels from the state the host returns", async () => {
    stubRequest();
    useAppStore.setState({ thinkingLevels: { "tab-1": ["off", "low", "high"] } });
    const entry = { key: "openai/gpt-5", id: "gpt-5", provider: "openai", label: "GPT-5", raw: {} };

    await useAppStore.getState().setModel("tab-1", entry);

    // A model change can remove levels, so the clamp is refreshed rather than reused.
    expect(useAppStore.getState().thinkingLevels["tab-1"]).toEqual(["off", "high"]);
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
