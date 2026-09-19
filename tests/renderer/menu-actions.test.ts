import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import {
  handleMenuCommand,
  newSessionAction,
  openProjectAction,
} from "../../src/renderer/src/menu-actions";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * Menu commands are the app's command surface (plan step 1). The regression
 * these tests pin is the user-visible one: "New session" must never fail
 * silently — with no project it explains what to do first.
 */

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    view: "welcome",
    project: null,
    prefs: { ...DEFAULT_PREFS },
    paletteOpen: false,
    info: null,
    hint: null,
    tabs: [],
    activeTabId: null,
    sessionEvents: {},
    sessionStates: {},
  });
});

describe("new session", () => {
  it("asks for a project first when none is open", () => {
    newSessionAction();
    expect(useAppStore.getState().hint).toMatch(/choose a project first/i);
  });

  it("asks for a project first when none is open", () => {
    newSessionAction();
    expect(useAppStore.getState().hint).toMatch(/choose a project first/i);
  });

  it("creates a session tab for the open project (plan step 3)", async () => {
    const create = vi.fn(async () => ({ tabs: [], activeTabId: null }));
    (window.pi as unknown as { sessions: { create: unknown } }).sessions.create = create;
    useAppStore.getState().openProject("C:\\work\\pi-desktop");

    await useAppStore.getState().createSessionTab();

    expect(create).toHaveBeenCalledWith({ cwd: "C:\\work\\pi-desktop" });
    expect(useAppStore.getState().view).toBe("session");
  });
});

describe("open project", () => {
  it("opens the picked folder and titles the window after it", async () => {
    const setTitle = vi.fn(async () => true);
    (window.pi as unknown as { setTitle: typeof setTitle }).setTitle = setTitle;

    await openProjectAction({ pickDirectory: async () => "C:\\work\\pi-desktop" });

    const state = useAppStore.getState();
    expect(state.project).toEqual({ path: "C:\\work\\pi-desktop", name: "pi-desktop" });
    expect(state.view).toBe("session");
    expect(setTitle).toHaveBeenCalledWith("Pi Desktop — pi-desktop");
  });

  it("changes nothing when the picker is cancelled", async () => {
    await openProjectAction({ pickDirectory: async () => null });
    expect(useAppStore.getState().project).toBeNull();
    expect(useAppStore.getState().view).toBe("welcome");
  });
});

describe("handleMenuCommand", () => {
  it("routes every navigation command to its view", () => {
    const cases: readonly [Parameters<typeof handleMenuCommand>[0], string][] = [
      ["view-settings", "settings"],
      ["view-extensions", "extensions"],
      ["view-connections", "connections"],
      ["view-skills", "skills"],
      ["view-diagnostics", "diagnostics"],
      ["view-office", "office"],
    ];
    for (const [command, view] of cases) {
      handleMenuCommand(command);
      expect(useAppStore.getState().view, command).toBe(view);
    }
  });

  it("toggles the palette and the sidebar", () => {
    handleMenuCommand("command-palette");
    expect(useAppStore.getState().paletteOpen).toBe(true);
    handleMenuCommand("command-palette");
    expect(useAppStore.getState().paletteOpen).toBe(false);

    handleMenuCommand("toggle-sidebar");
    expect(useAppStore.getState().prefs.sidebarCollapsed).toBe(true);
  });

  it("routes close and tab cycling at the tab table instead of a hint", () => {
    for (const command of ["close-session", "next-tab", "previous-tab"] as const) {
      useAppStore.setState({ hint: null, tabs: [], activeTabId: null });
      handleMenuCommand(command);
      expect(useAppStore.getState().hint, command).toBeNull();
    }
  });

  it("shows the shortcut list on demand", () => {
    handleMenuCommand("shortcuts");
    expect(useAppStore.getState().hint).toMatch(/palette/i);
  });
});
