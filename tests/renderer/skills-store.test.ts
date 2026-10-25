import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { installBridge } from "./fixtures";

/**
 * Skills, themes and keybindings store actions (plan step 15). They decide
 * which host answers, how a theme activation becomes a `theme` settings edit,
 * and how `/skill:<name>` reaches the composer — the SDK and Pi own the files.
 */

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
    tabs: [],
    activeTabId: null,
    view: "welcome",
    hint: null,
    themesLoaded: false,
    themesError: null,
    keybindings: null,
    keybindingsLoaded: false,
    shortcutsLoaded: false,
    shortcutsError: null,
    shortcutsTabId: null,
    shortcutsHelpOpen: false,
    settings: null,
    settingsLoaded: false,
  });
}

const THEMES_PAYLOAD = {
  active: "dark",
  themes: [
    {
      name: "dark",
      scope: "builtin",
      active: true,
      variant: "dark",
      swatches: { accent: "#8abeb7", text: "#d4d4d4", canvas: "#18181e", surface: "#1e1e24" },
    },
    { name: "light", scope: "builtin", active: false, variant: "light", swatches: {} },
  ],
};

function settingsSetResult(theme: string) {
  return {
    settings: { global: { theme }, project: {} },
    errors: [],
    files: {
      global: { path: "g", exists: true, mtimeMs: 1 },
      project: { path: "p", exists: false, mtimeMs: null },
    },
    projectTrusted: true,
  };
}

const KEYBINDINGS_PAYLOAD = {
  path: "C:/profile/keybindings.json",
  user: {},
  exists: false,
  effective: { "app.exit": ["ctrl+d"] },
  definitions: [{ id: "app.exit", defaults: ["ctrl+d"], description: "Exit" }],
  unknownIds: [],
  issues: [],
  conflicts: [],
};

beforeEach(() => {
  resetStore();
});

describe("themes actions", () => {
  it("loads the catalogue and recolours the chrome", async () => {
    stubRequest(async (method) => {
      if (method === "themes.list") return THEMES_PAYLOAD;
      throw new Error(`unexpected ${method}`);
    });
    await useAppStore.getState().loadThemes();
    const state = useAppStore.getState();
    expect(state.themes.active).toBe("dark");
    expect(state.themes.themes).toHaveLength(2);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--color-accent")).toBe("#8abeb7");
  });

  it("activates a theme through the theme setting", async () => {
    const seen: Array<{ method: string; params?: unknown }> = [];
    stubRequest(async (method, params) => {
      seen.push({ method, params });
      if (method === "themes.list") return THEMES_PAYLOAD;
      if (method === "settings.get") {
        return {
          settings: { global: {}, project: {} },
          errors: [],
          files: {
            global: { path: "g", exists: true, mtimeMs: 1 },
            project: { path: "p", exists: false, mtimeMs: null },
          },
          projectTrusted: true,
        };
      }
      if (method === "settings.set") return settingsSetResult("light");
      throw new Error(`unexpected ${method}`);
    });
    await useAppStore.getState().loadThemes();
    const ok = await useAppStore.getState().setActiveTheme("light");
    expect(ok).toBe(true);
    expect(useAppStore.getState().themes.active).toBe("light");
    expect(seen.some((entry) => entry.method === "settings.set")).toBe(true);
  });

  it("imports a theme and selects it", async () => {
    stubRequest(async (method) => {
      if (method === "themes.import") return { name: "mine", path: "C:/t/mine.json" };
      if (method === "themes.list") return { ...THEMES_PAYLOAD, active: "mine" };
      if (method === "settings.get") {
        return {
          settings: { global: {}, project: {} },
          errors: [],
          files: {
            global: { path: "g", exists: true, mtimeMs: 1 },
            project: { path: "p", exists: false, mtimeMs: null },
          },
          projectTrusted: true,
        };
      }
      if (method === "settings.set") return settingsSetResult("mine");
      throw new Error(`unexpected ${method}`);
    });
    const ok = await useAppStore
      .getState()
      .importTheme("mine.json", JSON.stringify({ name: "mine", colors: {} }));
    expect(ok).toBe(true);
    expect(useAppStore.getState().themes.active).toBe("mine");
  });
});

describe("keybindings actions", () => {
  it("loads, saves and resets through the control host", async () => {
    const request = stubRequest(async (method) => {
      if (method === "keybindings.get") return KEYBINDINGS_PAYLOAD;
      if (method === "keybindings.set") return { ...KEYBINDINGS_PAYLOAD, exists: true };
      if (method === "keybindings.reset") return KEYBINDINGS_PAYLOAD;
      throw new Error(`unexpected ${method}`);
    });
    const state = useAppStore.getState();
    await state.loadKeybindings();
    expect(useAppStore.getState().keybindings?.path).toBe("C:/profile/keybindings.json");
    expect(await useAppStore.getState().saveKeybindings({ "app.exit": ["ctrl+q"] })).toBe(true);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: "keybindings.set" }));
    await useAppStore.getState().resetKeybindings();
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: "keybindings.reset" }));
  });
});

describe("shortcuts actions", () => {
  it("loads from the live session and invokes through it", async () => {
    useAppStore.setState({
      tabs: [{ id: "tab-1", kind: "session", cwd: "C:/work", title: "s" } as never],
      activeTabId: "tab-1",
    });
    const request = stubRequest(async (method) => {
      if (method === "shortcuts.list") {
        return {
          shortcuts: [{ key: "ctrl+g", extensionPath: "C:/x/ext", source: "ext" }],
          diagnostics: [],
          loadedAt: 1,
        };
      }
      if (method === "shortcuts.invoke") return { invoked: "ctrl+g" };
      throw new Error(`unexpected ${method}`);
    });
    await useAppStore.getState().loadShortcuts();
    expect(useAppStore.getState().shortcuts.shortcuts).toHaveLength(1);
    expect(await useAppStore.getState().invokeShortcut("ctrl+g")).toBe(true);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "shortcuts.invoke", tabId: "tab-1" }),
    );
  });

  it("refuses to invoke without a session tab", async () => {
    const request = stubRequest(async () => ({}));
    expect(await useAppStore.getState().invokeShortcut("ctrl+g")).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  // The composer's Tab mode cycle (2026-10-19) needs the list at boot, so the
  // loader became tab-scoped and idempotent: one request per tab, refetched only
  // on an explicit refresh. These cases pin that contract.
  it("lists once per tab and reuses the list for the same tab", async () => {
    useAppStore.setState({
      tabs: [{ id: "tab-1", kind: "session", cwd: "C:/work", title: "s" } as never],
      activeTabId: "tab-1",
    });
    const request = stubRequest(async () => ({
      shortcuts: [{ key: "tab", extensionPath: "C:/x/workflow", source: "workflow" }],
      diagnostics: [],
      loadedAt: 1,
    }));
    await useAppStore.getState().loadShortcuts();
    await useAppStore.getState().loadShortcuts();
    expect(request).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().shortcutsTabId).toBe("tab-1");
    expect(useAppStore.getState().shortcuts.shortcuts[0]?.key).toBe("tab");
  });

  it("refetches on an explicit refresh", async () => {
    useAppStore.setState({
      tabs: [{ id: "tab-1", kind: "session", cwd: "C:/work", title: "s" } as never],
      activeTabId: "tab-1",
    });
    const request = stubRequest(async () => ({ shortcuts: [], diagnostics: [], loadedAt: 1 }));
    await useAppStore.getState().loadShortcuts();
    await useAppStore.getState().loadShortcuts({ refresh: true });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("refetches when the active session tab changes", async () => {
    const request = stubRequest(async () => ({ shortcuts: [], diagnostics: [], loadedAt: 1 }));
    useAppStore.setState({
      tabs: [{ id: "tab-1", kind: "session", cwd: "C:/work", title: "s" } as never],
      activeTabId: "tab-1",
    });
    await useAppStore.getState().loadShortcuts();
    useAppStore.setState({
      tabs: [
        { id: "tab-1", kind: "session", cwd: "C:/work", title: "s" } as never,
        { id: "tab-2", kind: "session", cwd: "C:/other", title: "s2" } as never,
      ],
      activeTabId: "tab-2",
    });
    await useAppStore.getState().loadShortcuts();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ tabId: "tab-2" }));
  });

  it("does not ask the control host for a list it cannot serve", async () => {
    const request = stubRequest(async () => {
      throw new Error("shortcuts are not available in this host");
    });
    await useAppStore.getState().loadShortcuts();
    expect(request).not.toHaveBeenCalled();
    expect(useAppStore.getState().shortcutsError).toBeNull();
  });

  it("retries a failed list on the next load instead of latching the empty list (2026-10-20 startup race)", async () => {
    useAppStore.setState({
      tabs: [{ id: "tab-1", kind: "session", cwd: "C:/work", title: "s" } as never],
      activeTabId: "tab-1",
    });
    let attempts = 0;
    const request = stubRequest(async (method) => {
      if (method === "shortcuts.list") {
        attempts += 1;
        // The boot-time attempt races the session open and fails the way a
        // session-less host fails it; the retry (host ready) succeeds.
        if (attempts === 1) throw new Error("shortcuts are not available in this host");
        return {
          shortcuts: [{ key: "tab", extensionPath: "C:/x/workflow", source: "workflow" }],
          diagnostics: [],
          loadedAt: 2,
        };
      }
      throw new Error(`unexpected ${method}`);
    });
    await useAppStore.getState().loadShortcuts();
    expect(useAppStore.getState().shortcutsError).toMatch(/not available/);
    expect(useAppStore.getState().shortcuts.shortcuts).toHaveLength(0);

    // The composer's Tab fallback (`onRequestShortcuts`) and the SessionView
    // readiness effect both funnel through here for the same tab.
    await useAppStore.getState().loadShortcuts();
    expect(request).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().shortcutsError).toBeNull();
    expect(useAppStore.getState().shortcuts.shortcuts[0]?.key).toBe("tab");
  });

  it("reloads the list when a tab's host is restarted", async () => {
    useAppStore.setState({
      tabs: [{ id: "tab-1", kind: "session", cwd: "C:/work", title: "s" } as never],
      activeTabId: "tab-1",
    });
    const request = stubRequest(async (method) => {
      if (method === "shortcuts.list") return { shortcuts: [], diagnostics: [], loadedAt: 1 };
      return {};
    });
    await useAppStore.getState().loadShortcuts();
    await useAppStore.getState().restartTab("tab-1");
    // The restart rebinds extensions, so the list is refetched (once for the
    // initial load, once for the restart).
    const listCalls = request.mock.calls.filter(([input]) => input.method === "shortcuts.list");
    expect(listCalls).toHaveLength(2);
  });

  it("does not latch a successful empty list, so the Tab fallback can retry", async () => {
    useAppStore.setState({
      tabs: [{ id: "tab-1", kind: "session", cwd: "C:/work", title: "s" } as never],
      activeTabId: "tab-1",
    });
    let attempts = 0;
    const request = stubRequest(async (method) => {
      if (method !== "shortcuts.list") return {};
      attempts += 1;
      return attempts === 1
        ? { shortcuts: [], diagnostics: [], loadedAt: 1 }
        : {
            shortcuts: [{ key: "tab", extensionPath: "C:/x/workflow", source: "workflow" }],
            diagnostics: [],
            loadedAt: 2,
          };
    });

    await useAppStore.getState().loadShortcuts();
    expect(useAppStore.getState().shortcuts.shortcuts).toHaveLength(0);

    // The composer's `onRequestShortcuts` path must not be a no-op after a
    // successful-but-empty response (2026-10-24 idle-session plan).
    await useAppStore.getState().loadShortcuts();
    expect(request.mock.calls.filter(([input]) => input.method === "shortcuts.list")).toHaveLength(
      2,
    );
    expect(useAppStore.getState().shortcuts.shortcuts[0]?.key).toBe("tab");
  });

  it("wakes a stopped tab, loads its shortcuts, and coalesces concurrent wakes", async () => {
    const tab = {
      id: "tab-1",
      kind: "session",
      cwd: "C:/work",
      title: "s",
      sessionFile: "C:/sessions/s1.jsonl",
      status: "stopped",
      createdAt: 1,
      lastActiveAt: 1,
      model: null,
    };
    useAppStore.setState({
      tabs: [tab as never],
      activeTabId: "tab-1",
      completionCommands: { "tab-1": [] },
    });
    const request = stubRequest(async (method) => {
      if (method === "shortcuts.list") {
        return {
          shortcuts: [{ key: "tab", extensionPath: "C:/x/workflow", source: "workflow" }],
          diagnostics: [],
          loadedAt: 1,
        };
      }
      return {};
    });
    const activate = vi.fn(async () => ({
      tabs: [{ ...tab, status: "idle" } as never],
      activeTabId: "tab-1",
    }));
    (window.pi as unknown as { sessions: { activate: unknown } }).sessions.activate = activate;

    await Promise.all([
      useAppStore.getState().wakeSession("tab-1"),
      useAppStore.getState().wakeSession("tab-1"),
    ]);

    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith("tab-1");
    expect(request.mock.calls.some(([input]) => input.method === "shortcuts.list")).toBe(true);
    expect(useAppStore.getState().shortcuts.shortcuts[0]?.key).toBe("tab");
    expect(useAppStore.getState().completionCommands["tab-1"]).toBeUndefined();
  });

  it("does not wake an idle or crashed tab", async () => {
    useAppStore.setState({
      tabs: [{ id: "tab-1", kind: "session", cwd: "C:/work", title: "s", status: "idle" } as never],
      activeTabId: "tab-1",
    });
    const activate = vi.fn();
    (window.pi as unknown as { sessions: { activate: unknown } }).sessions.activate = activate;

    await useAppStore.getState().wakeSession("tab-1");
    expect(activate).not.toHaveBeenCalled();

    useAppStore.setState({
      tabs: [
        { id: "tab-1", kind: "session", cwd: "C:/work", title: "s", status: "crashed" } as never,
      ],
    });
    await useAppStore.getState().wakeSession("tab-1");
    expect(activate).not.toHaveBeenCalled();
  });
});

describe("runSkill", () => {
  it("inserts /skill:<name> into the active session's composer", () => {
    useAppStore.setState({
      tabs: [{ id: "tab-1", kind: "session", cwd: "C:/work", title: "s" } as never],
      activeTabId: "tab-1",
      transcripts: {},
    } as never);
    useAppStore.getState().runSkill("review");
    expect(useAppStore.getState().view).toBe("session");
  });

  it("routes to the skills view when no session is open", () => {
    useAppStore.getState().runSkill("review");
    expect(useAppStore.getState().view).toBe("skills");
    expect(useAppStore.getState().hint).toMatch(/skill:review/);
  });

  it("toggles the shortcuts help dialog", () => {
    useAppStore.getState().setShortcutsHelpOpen(true);
    expect(useAppStore.getState().shortcutsHelpOpen).toBe(true);
    useAppStore.getState().setShortcutsHelpOpen(false);
    expect(useAppStore.getState().shortcutsHelpOpen).toBe(false);
  });
});
