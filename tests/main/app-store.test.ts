import { normalize } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  APP_STATE_VERSION,
  createAppStore,
  defaultAppState,
  normalizeAppState,
} from "../../src/main/app-store";
import { createMemoryFsPort, type MemoryFsPort } from "../../src/main/fs-port";

const STATE_FILE = "C:/user-data/app-state.json";
/** The in-memory fs normalises paths, exactly like a real filesystem does. */
const fsKey = (target: string): string => normalize(target);

function storedState(fs: MemoryFsPort): Record<string, unknown> {
  return JSON.parse(fs.files.get(fsKey(STATE_FILE)) ?? "{}") as Record<string, unknown>;
}

describe("normalizeAppState", () => {
  it("returns defaults for an empty document", () => {
    expect(normalizeAppState({})).toEqual(defaultAppState());
  });

  it("keeps valid fields and repairs invalid ones", () => {
    const state = normalizeAppState({
      version: 7,
      activeProject: "C:/projects/demo",
      projects: [
        { path: "C:/a", name: "a", addedAt: 1, lastOpenedAt: 2 },
        3,
        { path: "C:/b" },
        { path: "C:/a" },
      ],
      tabs: ["not really a tab"],
    });

    expect(state.version).toBe(7);
    expect(state.activeProject).toBe("C:/projects/demo");
    // Unusable entries are dropped and duplicates collapse to the first record.
    expect(state.projects.map((project) => project.path)).toEqual(["C:/a", "C:/b"]);
    expect(state.projects[1]?.name).toBe("b");
    // A tab without a cwd could never be restored, so it is dropped, not trusted.
    expect(state.tabs).toEqual([]);
    expect(state.activeTabId).toBeNull();
  });

  it("migrates the pre-step-10 recentProjects schema into project records", () => {
    const state = normalizeAppState({
      activeProject: "C:/projects/demo",
      recentProjects: ["C:/a", "C:/b"],
    });

    expect(state.projects).toEqual([
      { path: "C:/a", name: "a", addedAt: 0, lastOpenedAt: 0 },
      { path: "C:/b", name: "b", addedAt: 0, lastOpenedAt: 0 },
    ]);
  });

  it("keeps well-formed tabs and the active tab id (plan step 3)", () => {
    const state = normalizeAppState({
      tabs: [
        {
          id: "tab-1",
          cwd: "C:/work/app",
          title: "app",
          status: "running",
          sessionFile: "/profile/sessions/s1.jsonl",
        },
        { id: "tab-broken" },
      ],
      activeTabId: "tab-1",
    });

    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({
      id: "tab-1",
      kind: "session",
      title: "app",
      status: "running",
      sessionFile: "/profile/sessions/s1.jsonl",
    });
    expect(state.activeTabId).toBe("tab-1");
  });

  it("rejects wrong-typed scalars and non-array collections", () => {
    const state = normalizeAppState({
      version: "one",
      activeProject: 5,
      projects: "nope",
      tabs: null,
    });

    expect(state.version).toBe(APP_STATE_VERSION);
    expect(state.activeProject).toBeNull();
    expect(state.projects).toEqual([]);
    expect(state.tabs).toEqual([]);
  });
});

describe("createAppStore", () => {
  it("reads defaults on first run without writing anything", async () => {
    const fs = createMemoryFsPort();
    const store = createAppStore({ file: STATE_FILE, fs });

    expect(await store.read()).toEqual(defaultAppState());
    expect(fs.files.size).toBe(0);
  });

  it("merges an update, persists it atomically and keeps the cache in sync", async () => {
    const fs = createMemoryFsPort();
    const store = createAppStore({ file: STATE_FILE, fs });

    const next = await store.update({
      activeProject: "C:/projects/demo",
      projects: [{ path: "C:/projects/demo", name: "demo", addedAt: 1, lastOpenedAt: 2 }],
    });

    expect(next.activeProject).toBe("C:/projects/demo");
    expect(next.version).toBe(APP_STATE_VERSION);
    expect(fs.files.size).toBe(1);

    const written = storedState(fs);
    expect(written.activeProject).toBe("C:/projects/demo");
    expect(written.projects).toEqual([
      { path: "C:/projects/demo", name: "demo", addedAt: 1, lastOpenedAt: 2 },
    ]);

    // The atomic writer must not leave its temp file behind.
    expect([...fs.files.keys()]).toEqual([fsKey(STATE_FILE)]);
  });

  it("reads an existing state file back", async () => {
    const fs = createMemoryFsPort({
      files: {
        [STATE_FILE]: JSON.stringify({
          version: 1,
          activeProject: "C:/p",
          recentProjects: ["C:/p"],
          tabs: [],
        }),
      },
    });
    const store = createAppStore({ file: STATE_FILE, fs });

    expect((await store.read()).activeProject).toBe("C:/p");
  });

  it("reports a corrupt state file and falls back to defaults without rewriting it", async () => {
    const fs = createMemoryFsPort({ files: { [STATE_FILE]: "{ not json" } });
    const onError = vi.fn();
    const store = createAppStore({ file: STATE_FILE, fs, onError });

    expect(await store.read()).toEqual(defaultAppState());
    expect(onError).toHaveBeenCalledTimes(1);
    expect(fs.files.get(fsKey(STATE_FILE))).toBe("{ not json");
  });
});
