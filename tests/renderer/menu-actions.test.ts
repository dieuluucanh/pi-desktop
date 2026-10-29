import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import {
  handleMenuCommand,
  newSessionAction,
  openProjectAction,
} from "../../src/renderer/src/menu-actions";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { documentsViewFixture, installBridge } from "./fixtures";

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
    projects: [],
    projectsLoaded: false,
    projectInspections: {},
    projectInspectionErrors: {},
    trustPrompt: null,
    trustBusy: false,
    sessionTrust: [],
    prefs: { ...DEFAULT_PREFS },
    paletteOpen: false,
    info: null,
    hint: null,
    tabs: [],
    activeTabId: null,
    transcripts: {},
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
    await useAppStore.getState().openProject("C:\\work\\pi-desktop");

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
    ];
    for (const [command, view] of cases) {
      handleMenuCommand(command);
      expect(useAppStore.getState().view, command).toBe(view);
    }
  });

  it("routes the Integrations menu item at the Extensions hub's Integrations card", () => {
    handleMenuCommand("view-office");
    // Pi for Office has no primary view any more (plan step 19): the menu item
    // opens the hub and marks the card for the focus scroll.
    expect(useAppStore.getState().view).toBe("extensions");
    expect(useAppStore.getState().extensionsFocus).toBe("integrations");
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

  it("opens each panel menu from the Go menu", () => {
    for (const [command, menu] of [
      ["view-source-control", "source-control"],
      ["view-checkpoints", "checkpoints"],
    ] as const) {
      useAppStore.setState({
        prefs: { ...DEFAULT_PREFS, rail: { ...DEFAULT_PREFS.rail, open: false } },
      });
      handleMenuCommand(command);
      expect(useAppStore.getState().prefs.rail, command).toMatchObject({
        open: true,
        activeMenu: menu,
      });
    }
  });

  it("toggles only the panel body", () => {
    useAppStore.setState({
      prefs: {
        ...DEFAULT_PREFS,
        rail: { ...DEFAULT_PREFS.rail, open: false, activeMenu: "checkpoints" },
      },
    });
    handleMenuCommand("toggle-rail");
    expect(useAppStore.getState().prefs.rail).toMatchObject({
      open: true,
      // A toggle does not reassign the menu the user was last on.
      activeMenu: "checkpoints",
    });
    handleMenuCommand("toggle-rail");
    expect(useAppStore.getState().prefs.rail.open).toBe(false);
  });

  it("opens Documents when Office is connected", () => {
    useAppStore.setState({
      officeDocuments: documentsViewFixture({ available: true, status: "ok", panes: [] }),
      prefs: { ...DEFAULT_PREFS, rail: { ...DEFAULT_PREFS.rail, open: false } },
      hint: null,
    });
    handleMenuCommand("view-documents");
    expect(useAppStore.getState().prefs.rail).toMatchObject({
      open: true,
      activeMenu: "documents",
    });
    expect(useAppStore.getState().hint).toBeNull();
  });

  it("explains Documents instead of opening an empty panel when Office is absent", () => {
    useAppStore.setState({
      officeDocuments: null,
      prefs: {
        ...DEFAULT_PREFS,
        rail: { ...DEFAULT_PREFS.rail, open: true, activeMenu: "source-control" },
      },
      hint: null,
    });
    handleMenuCommand("view-documents");
    expect(useAppStore.getState().hint).toMatch(/not connected/i);
    // The panel is left exactly where it was.
    expect(useAppStore.getState().prefs.rail).toMatchObject({
      open: true,
      activeMenu: "source-control",
    });
  });

  it("opens the shortcuts dialog on demand", () => {
    useAppStore.setState({ shortcutsHelpOpen: false });
    handleMenuCommand("shortcuts");
    expect(useAppStore.getState().shortcutsHelpOpen).toBe(true);
  });
});
