import { normalize } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeAppState, type AppState, type AppStore } from "../../src/main/app-store";
import { createMemoryFsPort, type MemoryFsPort } from "../../src/main/fs-port";
import {
  createProjectSettingsService,
  projectSettingsPath,
} from "../../src/main/project-settings-service";
import { readSettingsDocument } from "../../src/main/packages/settings";
import type { ProjectRecord } from "../../src/shared/projects";

const PROJECT = "C:/work/app";
const OTHER = "C:/work/other";

function record(path: string, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return { path, name: path.split("/").pop() ?? path, addedAt: 1, lastOpenedAt: 1, ...overrides };
}

function fakeStore(initial: Partial<AppState> = {}): AppStore & { state: AppState } {
  let current = normalizeAppState({
    version: 1,
    projects: [record(PROJECT), record(OTHER)],
    ...initial,
  });
  return {
    get state() {
      return current;
    },
    read: async () => current,
    update: async (patch) => {
      current = normalizeAppState({ ...current, ...patch });
      return current;
    },
    updatePrefs: async () => current.prefs,
  };
}

function makeFs(initialFiles: Record<string, string> = {}): MemoryFsPort {
  return createMemoryFsPort({
    dirs: [PROJECT, OTHER],
    files: Object.fromEntries(
      Object.entries(initialFiles).map(([path, contents]) => [normalize(path), contents]),
    ),
  });
}

function settingsJson(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

describe("createProjectSettingsService", () => {
  it("snapshots and empties a non-empty project document when disabled", async () => {
    const fs = makeFs({
      [`${PROJECT}/.pi/settings.json`]: settingsJson({
        enabledModels: ["fake/fake-1"],
        packages: ["npm:fake"],
      }),
    });
    const store = fakeStore();
    const service = createProjectSettingsService({
      fs,
      store,
      isProjectTrusted: () => true,
      now: () => 42,
    });

    const result = await service.setEnabled({ path: PROJECT, enabled: false });

    expect(result).toMatchObject({ enabled: false, saved: true, restored: false });
    expect(await readSettingsDocument(fs, projectSettingsPath(PROJECT))).toEqual({});
    expect(store.state.projectSettingsSnapshots[PROJECT]?.savedAt).toBe(42);
    expect(JSON.parse(store.state.projectSettingsSnapshots[PROJECT]?.json ?? "{}")).toEqual({
      enabledModels: ["fake/fake-1"],
      packages: ["npm:fake"],
    });
    expect(
      store.state.projects.find((p) => p.path === PROJECT)?.useProjectSettings,
    ).toBeUndefined();
  });

  it("restores the snapshot on enable when the current file is empty", async () => {
    const fs = makeFs({
      [`${PROJECT}/.pi/settings.json`]: settingsJson({ enabledModels: ["fake/fake-1"] }),
    });
    const store = fakeStore();
    const service = createProjectSettingsService({
      fs,
      store,
      isProjectTrusted: () => true,
      now: () => 42,
    });
    await service.setEnabled({ path: PROJECT, enabled: false });

    const result = await service.setEnabled({ path: PROJECT, enabled: true });

    expect(result).toMatchObject({ enabled: true, restored: true, keptCurrent: false });
    expect(await readSettingsDocument(fs, projectSettingsPath(PROJECT))).toEqual({
      enabledModels: ["fake/fake-1"],
    });
    expect(store.state.projects.find((p) => p.path === PROJECT)?.useProjectSettings).toBe(true);
  });

  it("keeps a non-empty current file on enable and reports it", async () => {
    const fs = makeFs({
      [`${PROJECT}/.pi/settings.json`]: settingsJson({ enabledModels: ["fake/fake-1"] }),
    });
    const store = fakeStore();
    const service = createProjectSettingsService({
      fs,
      store,
      isProjectTrusted: () => true,
      now: () => 42,
    });
    await service.setEnabled({ path: PROJECT, enabled: false });
    await fs.writeTextFile(
      projectSettingsPath(PROJECT),
      settingsJson({ enabledModels: ["fake/fake-2"] }),
    );

    const result = await service.setEnabled({ path: PROJECT, enabled: true });

    expect(result).toMatchObject({ enabled: true, restored: false, keptCurrent: true });
    expect(await readSettingsDocument(fs, projectSettingsPath(PROJECT))).toEqual({
      enabledModels: ["fake/fake-2"],
    });
  });

  it("refuses an untrusted project", async () => {
    const fs = makeFs({
      [`${PROJECT}/.pi/settings.json`]: settingsJson({ enabledModels: ["fake/fake-1"] }),
    });
    const store = fakeStore();
    const service = createProjectSettingsService({
      fs,
      store,
      isProjectTrusted: () => false,
    });

    await expect(service.setEnabled({ path: PROJECT, enabled: false })).rejects.toThrow(
      /not trusted/i,
    );
    expect(store.state.projectSettingsMigrated).toBe(false);
  });

  it("never overwrites a malformed project document", async () => {
    const fs = makeFs({ [`${PROJECT}/.pi/settings.json`]: "{ not json" });
    const store = fakeStore();
    const service = createProjectSettingsService({
      fs,
      store,
      isProjectTrusted: () => true,
    });

    await expect(service.setEnabled({ path: PROJECT, enabled: false })).rejects.toThrow(
      /Invalid JSON/i,
    );
    expect(await fs.readTextFile(projectSettingsPath(PROJECT))).toBe("{ not json");
  });

  it("rolls the record back when emptying the file fails", async () => {
    const base = makeFs({
      [`${PROJECT}/.pi/settings.json`]: settingsJson({ enabledModels: ["fake/fake-1"] }),
    });
    const fs: MemoryFsPort = {
      ...base,
      writeTextFile: async (target, contents) => {
        if (target.includes(".pi")) throw new Error("disk full");
        return base.writeTextFile(target, contents);
      },
    };
    const store = fakeStore();
    const service = createProjectSettingsService({
      fs,
      store,
      isProjectTrusted: () => true,
    });

    await expect(service.setEnabled({ path: PROJECT, enabled: false })).rejects.toThrow(
      /disk full/,
    );
    expect(store.state.projects.find((p) => p.path === PROJECT)?.useProjectSettings).toBe(true);
    expect(store.state.projectSettingsSnapshots[PROJECT]).toBeDefined();
  });

  it("migrates every unset project to off and snapshots existing documents once", async () => {
    const fs = makeFs({
      [`${PROJECT}/.pi/settings.json`]: settingsJson({ enabledModels: ["fake/fake-1"] }),
    });
    const store = fakeStore();
    const service = createProjectSettingsService({
      fs,
      store,
      isProjectTrusted: () => true,
      now: () => 7,
    });

    const first = await service.migrate();
    expect(first.migrated).toBe(true);
    expect(store.state.projectSettingsMigrated).toBe(true);
    expect(store.state.projectSettingsSnapshots[PROJECT]?.savedAt).toBe(7);
    expect(await readSettingsDocument(fs, projectSettingsPath(PROJECT))).toEqual({});
    expect(store.state.projects.every((p) => p.useProjectSettings === undefined)).toBe(true);

    const second = await service.migrate();
    expect(second).toEqual({ migrated: true, errors: [] });
  });
});
