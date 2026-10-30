import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { ProjectRecord } from "../../src/shared/projects";
import type { TabRecord } from "../../src/shared/session-ipc";
import { installBridge, type BridgeHandles } from "./fixtures";

/**
 * Project ↔ session selection (2026-10-30 project-scoped rail plan).
 *
 * The rail is project-scoped, so the two selections the user has — the sidebar's
 * project and the tab strip's session — must move together:
 *
 *  - clicking a **project** jumps to its most recently active *open* tab, or
 *    clears the active tab when the folder has none (main never resumes a saved
 *    session on its own);
 *  - clicking a **session** selects that session's project.
 */

const APP = "C:/work/app";
const OTHER = "C:/work/other";

function record(path: string): ProjectRecord {
  return {
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    addedAt: 1,
    lastOpenedAt: 1,
  };
}

function tab(
  id: string,
  cwd: string,
  lastActiveAt: number,
  kind: TabRecord["kind"] = "session",
): TabRecord {
  return {
    id,
    kind,
    cwd,
    title: id,
    sessionFile: null,
    status: "idle",
    createdAt: 1,
    lastActiveAt,
    model: null,
  };
}

function resetStore(): void {
  useAppStore.setState({
    view: "session",
    project: null,
    projects: [],
    projectsLoaded: true,
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
    extensionUi: {},
    tuiSurfaces: {},
    picker: null,
  });
}

/** The fake session bridge, so a test can watch `activate`/`deactivate`. */
function sessionCalls(handles: BridgeHandles): { activate: string[]; deactivate: number } {
  const sessions = handles.bridge.sessions as unknown as {
    activate: (id: string) => Promise<unknown>;
    deactivate: () => Promise<unknown>;
  };
  const calls = { activate: [] as string[], deactivate: 0 };
  sessions.activate = async (id: string) => {
    calls.activate.push(id);
    return {
      tabs: useAppStore.getState().tabs,
      activeTabId: id,
    };
  };
  sessions.deactivate = async () => {
    calls.deactivate += 1;
    return { tabs: useAppStore.getState().tabs, activeTabId: null };
  };
  return calls;
}

beforeEach(() => {
  resetStore();
});

describe("selecting a project", () => {
  it("jumps to the most recently active open tab in that project", async () => {
    const handles = installBridge({ projects: [record(APP), record(OTHER)], activeProject: APP });
    const calls = sessionCalls(handles);
    useAppStore.setState({
      tabs: [tab("a-old", APP, 10), tab("a-new", APP, 50), tab("b", OTHER, 99)],
      activeTabId: "b",
    });

    await useAppStore.getState().activateProject(APP);

    expect(calls.activate).toEqual(["a-new"]);
    expect(useAppStore.getState().activeTabId).toBe("a-new");
    expect(useAppStore.getState().project?.path).toBe(APP);
  });

  it("never picks a web tab, even when it is the most recent", async () => {
    const handles = installBridge({ projects: [record(APP)], activeProject: APP });
    const calls = sessionCalls(handles);
    useAppStore.setState({
      tabs: [tab("s", APP, 10), tab("w", APP, 500, "web")],
      activeTabId: "w",
    });

    await useAppStore.getState().activateProject(APP);

    expect(calls.activate).toEqual(["s"]);
  });

  it("clears the active tab when the project has no open session", async () => {
    const handles = installBridge({ projects: [record(APP), record(OTHER)], activeProject: OTHER });
    const calls = sessionCalls(handles);
    useAppStore.setState({ tabs: [tab("b", OTHER, 5)], activeTabId: "b" });

    await useAppStore.getState().activateProject(APP);

    expect(calls.deactivate).toBe(1);
    expect(useAppStore.getState().activeTabId).toBeNull();
    // The rail keeps the project, so the session column's Welcome state does not
    // strand the panel.
    expect(useAppStore.getState().project?.path).toBe(APP);
    expect(useAppStore.getState().view).toBe("session");
  });

  it("does not clear or activate anything when focusSession is false", async () => {
    const handles = installBridge({ projects: [record(APP)], activeProject: APP });
    const calls = sessionCalls(handles);
    useAppStore.setState({ tabs: [tab("b", OTHER, 5)], activeTabId: "b" });

    await useAppStore.getState().activateProject(APP, { focusSession: false });

    expect(calls.activate).toEqual([]);
    expect(calls.deactivate).toBe(0);
    expect(useAppStore.getState().activeTabId).toBe("b");
    expect(useAppStore.getState().project?.path).toBe(APP);
  });

  it("tolerates a differently spelled folder when matching tabs", async () => {
    const handles = installBridge({
      projects: [record("C:\\work\\app")],
      activeProject: "C:\\work\\app",
    });
    const calls = sessionCalls(handles);
    useAppStore.setState({ tabs: [tab("a", APP, 5)], activeTabId: null });

    await useAppStore.getState().activateProject("C:\\work\\app");

    expect(calls.activate).toEqual(["a"]);
  });
});

describe("selecting a session", () => {
  it("selects the session's remembered project", async () => {
    const handles = installBridge({ projects: [record(APP), record(OTHER)], activeProject: OTHER });
    const mutate = vi.spyOn(handles.bridge.projects, "mutate");
    useAppStore.setState({
      projects: [record(APP), record(OTHER)],
      project: { path: OTHER, name: "other" },
      tabs: [tab("a", APP, 5), tab("b", OTHER, 6)],
      activeTabId: "b",
    });

    await useAppStore.getState().activateTab("a");
    await vi.waitFor(() => expect(useAppStore.getState().project?.path).toBe(APP));

    expect(mutate).toHaveBeenCalledWith({ action: "activate", path: APP });
  });

  it("keeps a cwd that is not a saved project local, without persisting it", async () => {
    const handles = installBridge({ projects: [record(OTHER)], activeProject: OTHER });
    const mutate = vi.spyOn(handles.bridge.projects, "mutate");
    useAppStore.setState({
      projects: [record(OTHER)],
      project: { path: OTHER, name: "other" },
      tabs: [tab("x", "C:/work/scratch", 5)],
      activeTabId: "b",
    });

    await useAppStore.getState().activateTab("x");
    await vi.waitFor(() => expect(useAppStore.getState().project?.path).toBe("C:/work/scratch"));

    expect(mutate).not.toHaveBeenCalled();
  });

  it("does not write the project again when the session is already in it", async () => {
    const handles = installBridge({ projects: [record(APP)], activeProject: APP });
    const mutate = vi.spyOn(handles.bridge.projects, "mutate");
    useAppStore.setState({
      projects: [record(APP)],
      project: { path: APP, name: "app" },
      tabs: [tab("a", APP, 5), tab("a2", APP + "/", 6)],
      activeTabId: "a",
    });

    await useAppStore.getState().activateTab("a2");
    await Promise.resolve();

    expect(mutate).not.toHaveBeenCalled();
  });
});

describe("clearing the selection", () => {
  it("is a no-op when nothing is active", async () => {
    const handles = installBridge();
    const calls = sessionCalls(handles);
    useAppStore.setState({ activeTabId: null });

    await useAppStore.getState().clearActiveTab();

    expect(calls.deactivate).toBe(0);
  });
});
