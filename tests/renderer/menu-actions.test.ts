import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import {
  handleMenuCommand,
  newSessionAction,
  openProjectAction,
  SESSION_TABS_HINT,
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
  });
});

describe("new session", () => {
  it("asks for a project first when none is open", () => {
    newSessionAction();
    expect(useAppStore.getState().hint).toMatch(/choose a project first/i);
  });

  it("names the step that adds session tabs once a project is open", () => {
    useAppStore.getState().openProject("C:\\work\\pi-desktop");
    newSessionAction();
    expect(useAppStore.getState().hint).toBe(SESSION_TABS_HINT);
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

  it("explains commands that belong to a later step", () => {
    for (const command of ["close-session", "next-tab", "previous-tab"] as const) {
      useAppStore.setState({ hint: null });
      handleMenuCommand(command);
      expect(useAppStore.getState().hint, command).toMatch(/step 11/);
    }
  });

  it("shows the shortcut list on demand", () => {
    handleMenuCommand("shortcuts");
    expect(useAppStore.getState().hint).toMatch(/palette/i);
  });
});
