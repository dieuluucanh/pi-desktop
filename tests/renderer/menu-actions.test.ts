import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import {
  handleMenuCommand,
  newSessionAction,
  openProjectAction,
} from "../../src/renderer/src/menu-actions";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import { useEditorStore } from "../../src/renderer/src/editor/editor-store";
import { documentsViewFixture, installBridge } from "./fixtures";

/**
 * Menu commands are the app's command surface (plan step 1). The regression
 * these tests pin is the user-visible one: "New session" must never fail
 * silently — with no project it explains what to do first.
 */

beforeEach(() => {
  installBridge();
  // Editor metadata and the non-reactive buffer registry outlive a test; clear
  // both so a save/format test cannot see the previous case's file.
  useEditorStore.getState().clearExcept(new Set());
  useEditorStore.setState({ pendingClose: null });
  useAppStore.setState({
    view: "welcome",
    settingsFocus: null,
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

  it("does not ask for trust when a create fails for another reason", async () => {
    const create = vi.fn(async () => {
      throw new Error(
        "Pi Desktop reached its memory-derived ceiling of 8 host processes. Wait for a running session to finish or close a session that is no longer running.",
      );
    });
    (window.pi as unknown as { sessions: { create: unknown } }).sessions.create = create;
    await useAppStore.getState().openProject("C:\\work\\pi-desktop");
    const prompt = vi.spyOn(useAppStore.getState(), "openTrustPrompt").mockResolvedValue(false);

    await useAppStore.getState().createSessionTab();

    expect(prompt).not.toHaveBeenCalled();
    expect(useAppStore.getState().hint).toMatch(/memory-derived ceiling/);
  });

  it("still asks for trust when the failure is trust-related", async () => {
    const create = vi.fn(async () => {
      throw new Error("trust required for this project");
    });
    (window.pi as unknown as { sessions: { create: unknown } }).sessions.create = create;
    await useAppStore.getState().openProject("C:\\work\\pi-desktop");
    const prompt = vi.spyOn(useAppStore.getState(), "openTrustPrompt").mockResolvedValue(false);

    await useAppStore.getState().createSessionTab();

    expect(prompt).toHaveBeenCalledWith("C:\\work\\pi-desktop");
  });

  it("strips Electron's IPC wrapper from the hint", async () => {
    const create = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'session:create': Error: the project folder is missing",
      );
    });
    (window.pi as unknown as { sessions: { create: unknown } }).sessions.create = create;
    await useAppStore.getState().openProject("C:\\work\\pi-desktop");

    await useAppStore.getState().createSessionTab();

    expect(useAppStore.getState().hint).toBe("the project folder is missing");
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

  it("routes Help's update and About items at the About & updates card", () => {
    handleMenuCommand("view-about");
    expect(useAppStore.getState().view).toBe("settings");
    expect(useAppStore.getState().settingsFocus).toBe("updates");

    handleMenuCommand("check-updates");
    expect(useAppStore.getState().view).toBe("settings");
    expect(useAppStore.getState().settingsFocus).toBe("updates");
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

  it("changes the display zoom from the View menu", () => {
    useAppStore.getState().zoomReset();

    handleMenuCommand("zoom-in");
    expect(useAppStore.getState().prefs.zoomFactor).toBe(1.1);

    handleMenuCommand("zoom-out");
    expect(useAppStore.getState().prefs.zoomFactor).toBe(1);

    handleMenuCommand("zoom-in");
    handleMenuCommand("zoom-in");
    handleMenuCommand("zoom-reset");
    expect(useAppStore.getState().prefs.zoomFactor).toBe(1);
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
    expect(useAppStore.getState().hint).toMatch(/not installed/i);
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

/**
 * Editor menu commands (2026-11-02 plan step 2). Save/Format are editor-local
 * chords plus no-accelerator menu items; the handler must act on the active
 * editor tab and explain the requirement when a session tab is on screen.
 */
const WORK = "C:\\work\\pi-desktop";

function editorTab(): TabRecord {
  return {
    id: "editor-1",
    kind: "editor",
    cwd: WORK,
    title: "a.ts",
    sessionFile: null,
    status: "idle",
    createdAt: 1,
    lastActiveAt: 1,
    model: null,
    filePath: "a.ts",
  };
}

describe("editor menu commands", () => {
  async function seedEditor(): Promise<{
    writeFile: ReturnType<typeof vi.fn>;
    format: ReturnType<typeof vi.fn>;
  }> {
    const { bridge } = installBridge();
    const writeFile = vi.fn(async () => ({
      ok: true as const,
      value: { path: `${WORK}\\a.ts`, relativePath: "a.ts", size: 8, mtimeMs: 2, bytes: 8 },
    }));
    const format = vi.fn(async () => ({ ok: true as const, value: { text: "let a = 1;\n" } }));
    const readFile = vi.fn(async () => ({
      ok: true as const,
      value: {
        path: `${WORK}\\a.ts`,
        relativePath: "a.ts",
        kind: "text" as const,
        text: "let a=1;",
        bytes: 8,
        size: 8,
        mtimeMs: 1,
        truncated: false,
        eol: "lf" as const,
        bom: false,
        encoding: "utf8" as const,
      },
    }));
    (bridge.workspace as unknown as { readFile: unknown }).readFile = readFile;
    (bridge.workspace as unknown as { writeFile: unknown }).writeFile = writeFile;
    (bridge.workspace as unknown as { format: unknown }).format = format;
    useAppStore.setState({ tabs: [editorTab()], activeTabId: "editor-1", hint: null });
    await useEditorStore.getState().load("editor-1");
    return { writeFile, format };
  }

  it("saves the active editor tab", async () => {
    const { writeFile } = await seedEditor();
    handleMenuCommand("save-editor");
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1));
  });

  it("formats the active editor tab", async () => {
    const { format } = await seedEditor();
    handleMenuCommand("format-editor");
    await vi.waitFor(() => expect(format).toHaveBeenCalledTimes(1));
  });

  it("explains the requirement when no editor is active", () => {
    useAppStore.setState({ tabs: [], activeTabId: null, hint: null });
    handleMenuCommand("save-editor");
    expect(useAppStore.getState().hint).toMatch(/open a file/i);
    useAppStore.setState({ hint: null });
    handleMenuCommand("format-editor");
    expect(useAppStore.getState().hint).toMatch(/open a file/i);
  });
});
