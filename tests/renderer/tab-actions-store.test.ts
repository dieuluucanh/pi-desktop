import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import { installBridge } from "./fixtures";

const WORK = "C:\\work\\pi-desktop";

function tab(overrides: Partial<TabRecord> = {}): TabRecord {
  return {
    id: "tab-1",
    kind: "session",
    cwd: WORK,
    title: "pi-desktop",
    sessionFile: `${WORK}\\sessions\\s1.jsonl`,
    status: "idle",
    createdAt: 1,
    lastActiveAt: 1,
    model: null,
    ...overrides,
  };
}

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    view: "session",
    project: { path: WORK, name: "pi-desktop" },
    projects: [],
    projectsLoaded: true,
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    hint: null,
    tabs: [],
    activeTabId: null,
    projectInspections: {},
    projectInspectionErrors: {},
    sessionTrust: [],
  });
});

describe("tab primitives", () => {
  it("closes all tabs of a kind through the bridge", async () => {
    const { bridge } = installBridge();
    const closeAll = vi.fn(async () => ({ tabs: [tab()], activeTabId: "tab-1" }));
    (bridge.sessions as unknown as { closeAll: unknown }).closeAll = closeAll;
    useAppStore.setState({
      tabs: [tab(), tab({ id: "editor-1", kind: "editor", filePath: "a.ts" })],
      activeTabId: "tab-1",
    });

    await useAppStore.getState().closeAllTabs("editor");

    expect(closeAll).toHaveBeenCalledWith("editor");
    expect(useAppStore.getState().tabs.map((entry) => entry.id)).toEqual(["tab-1"]);
  });

  it("pins and retargets through the bridge", async () => {
    const { bridge } = installBridge();
    const setPinned = vi.fn(async () => ({ tabs: [tab({ pinned: true })], activeTabId: "tab-1" }));
    const retarget = vi.fn(async () => ({
      tabs: [tab({ id: "editor-1", kind: "editor", filePath: "lib/a.ts" })],
      activeTabId: "editor-1",
    }));
    (bridge.sessions as unknown as { setPinned: unknown }).setPinned = setPinned;
    (bridge.sessions as unknown as { retargetEditorTabs: unknown }).retargetEditorTabs = retarget;
    useAppStore.setState({
      tabs: [tab({ id: "editor-1", kind: "editor", filePath: "src/a.ts" })],
      activeTabId: "editor-1",
    });

    await useAppStore.getState().setTabPinned("editor-1", true);
    expect(setPinned).toHaveBeenCalledWith("editor-1", true);
    expect(useAppStore.getState().tabs[0]?.pinned).toBe(true);

    const envelope = await useAppStore.getState().retargetEditorTabs({
      fromProjectPath: WORK,
      fromPath: "src",
      toProjectPath: WORK,
      toPath: "lib",
      kind: "directory",
    });
    expect(retarget).toHaveBeenCalled();
    expect(envelope?.tabs[0]?.filePath).toBe("lib/a.ts");
  });
});

describe("addWorkspaceMention", () => {
  it("appends the mention to the active session in the same project", async () => {
    useAppStore.setState({
      tabs: [tab()],
      activeTabId: "tab-1",
      prefs: { ...DEFAULT_PREFS, drafts: { "tab-1": "Please review" } },
    });

    await expect(
      useAppStore.getState().addWorkspaceMention(WORK, "src/app.ts", "file"),
    ).resolves.toBe(true);

    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("Please review @src/app.ts ");
    expect(useAppStore.getState().hint).toBe("Added to chat.");
  });

  it("does not duplicate an existing mention", async () => {
    useAppStore.setState({
      tabs: [tab()],
      activeTabId: "tab-1",
      prefs: { ...DEFAULT_PREFS, drafts: { "tab-1": "@src/app.ts " } },
    });

    await useAppStore.getState().addWorkspaceMention(WORK, "src/app.ts", "file");

    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("@src/app.ts ");
  });

  it("hints instead of creating a session when none exists", async () => {
    await expect(
      useAppStore.getState().addWorkspaceMention(WORK, "src/app.ts", "file"),
    ).resolves.toBe(false);
    expect(useAppStore.getState().hint).toMatch(/Open a session/);
  });
});

describe("removeProject", () => {
  it("closes the project tabs before removing it and purges caches", async () => {
    const { bridge } = installBridge({ projects: [], activeProject: null });
    const closeProject = vi.fn(async () => ({
      tabs: [tab({ id: "other", cwd: "C:\\work\\other" })],
      activeTabId: "other",
    }));
    (bridge.sessions as unknown as { closeProject: unknown }).closeProject = closeProject;
    const mutate = vi.spyOn(bridge.projects, "mutate");
    useAppStore.setState({
      projects: [{ path: WORK, name: "pi-desktop", addedAt: 1, lastOpenedAt: 1 }],
      project: { path: WORK, name: "pi-desktop" },
      projectInspections: { [WORK]: {} as never, "C:\\work\\other": {} as never },
      projectInspectionErrors: { [WORK]: "old" },
      sessionTrust: [WORK, "C:\\work\\other"],
      tabs: [tab(), tab({ id: "editor-1", kind: "editor", filePath: "a.ts" })],
      activeTabId: "tab-1",
    });

    await expect(useAppStore.getState().removeProject(WORK)).resolves.toBe(true);

    expect(closeProject).toHaveBeenCalledWith(WORK);
    expect(mutate).toHaveBeenCalledWith({ action: "remove", path: WORK });
    expect(useAppStore.getState().tabs.map((entry) => entry.id)).toEqual(["other"]);
    expect(useAppStore.getState().projectInspections[WORK]).toBeUndefined();
    expect(useAppStore.getState().projectInspectionErrors[WORK]).toBeUndefined();
    expect(useAppStore.getState().sessionTrust).toEqual(["C:\\work\\other"]);
  });

  it("keeps the project when closing its tabs fails", async () => {
    const { bridge } = installBridge({
      projects: [{ path: WORK, name: "pi-desktop", addedAt: 1, lastOpenedAt: 1 }],
      activeProject: WORK,
    });
    (bridge.sessions as unknown as { closeProject: unknown }).closeProject = vi.fn(async () => {
      throw new Error("host refused to stop");
    });
    const mutate = vi.spyOn(bridge.projects, "mutate");
    useAppStore.setState({
      projects: [{ path: WORK, name: "pi-desktop", addedAt: 1, lastOpenedAt: 1 }],
      project: { path: WORK, name: "pi-desktop" },
      tabs: [tab()],
      activeTabId: "tab-1",
    });

    await expect(useAppStore.getState().removeProject(WORK)).resolves.toBe(false);
    expect(mutate).not.toHaveBeenCalled();
    expect(useAppStore.getState().tabs).toHaveLength(1);
  });
});
