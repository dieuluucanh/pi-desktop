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
