import { describe, expect, it } from "vitest";
import {
  createProjectsService,
  parseCloneProjectInput,
  parseCreateProjectInput,
  parseProjectActionInput,
  parseProjectMutation,
} from "../../src/main/projects-service";
import type { ProjectRecord } from "../../src/shared/projects";

const A = "C:/work/a";
const B = "C:/work/b";

function record(path: string, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    addedAt: 1,
    lastOpenedAt: 1,
    ...overrides,
  };
}

function store(initial: { activeProject?: string | null; projects?: unknown } = {}) {
  let state = {
    activeProject: initial.activeProject ?? null,
    projects: initial.projects ?? [],
  };
  return {
    read: async () => ({ activeProject: state.activeProject, projects: state.projects }),
    update: async (patch: { projects?: ProjectRecord[]; activeProject?: string | null }) => {
      state = { ...state, ...patch };
      return state;
    },
    current: () => ({ ...state }),
  };
}

describe("parseProjectMutation", () => {
  it("accepts every supported mutation", () => {
    expect(parseProjectMutation({ action: "add", path: A })).toEqual({ action: "add", path: A });
    expect(parseProjectMutation({ action: "remove", path: A })).toEqual({
      action: "remove",
      path: A,
    });
    expect(parseProjectMutation({ action: "reorder", path: A, toIndex: 2 })).toEqual({
      action: "reorder",
      path: A,
      toIndex: 2,
    });
    expect(parseProjectMutation({ action: "activate", path: null })).toEqual({
      action: "activate",
      path: null,
    });
    expect(
      parseProjectMutation({
        action: "update",
        path: A,
        patch: { useProjectSettings: true },
      }),
    ).toEqual({ action: "update", path: A, patch: { useProjectSettings: true } });
  });

  it("rejects unknown actions, missing paths and malformed fields", () => {
    expect(() => parseProjectMutation({ action: "explode" })).toThrow(/unknown mutation/);
    expect(() => parseProjectMutation({ action: "add" })).toThrow(/path is required/);
    expect(() => parseProjectMutation({ action: "reorder", path: A })).toThrow(/toIndex/);
    expect(() =>
      parseProjectMutation({
        action: "update",
        path: A,
        patch: { useProjectSettings: "yes" },
      }),
    ).toThrow(/boolean/);
    expect(() => parseProjectMutation({ action: "activate", path: 7 })).toThrow(/path is required/);
  });
});

describe("input parsers", () => {
  it("parses a create input and validates gitInit", () => {
    expect(parseCreateProjectInput({ parentDir: "C:/work", name: "app", gitInit: true })).toEqual({
      parentDir: "C:/work",
      name: "app",
      gitInit: true,
    });
    expect(() => parseCreateProjectInput({ parentDir: "C:/work" })).toThrow(/name is required/);
    expect(() =>
      parseCreateProjectInput({ parentDir: "C:/work", name: "app", gitInit: "yes" }),
    ).toThrow(/boolean/);
  });

  it("parses a clone input with an optional name", () => {
    expect(parseCloneProjectInput({ parentDir: "C:/work", url: "https://x/y.git" })).toEqual({
      parentDir: "C:/work",
      url: "https://x/y.git",
    });
    expect(
      parseCloneProjectInput({ parentDir: "C:/work", url: "https://x/y.git", name: "z" }),
    ).toMatchObject({ name: "z" });
  });

  it("parses an action input and rejects an unknown action", () => {
    expect(parseProjectActionInput({ path: A, action: "reveal" })).toEqual({
      path: A,
      action: "reveal",
    });
    expect(() => parseProjectActionInput({ path: A, action: "delete" })).toThrow(/unknown action/);
  });
});

describe("createProjectsService", () => {
  it("adds a project, activates it and returns the snapshot", async () => {
    const backing = store({ projects: [record(B)] });
    const service = createProjectsService({ store: backing, now: () => 42 });

    const snapshot = await service.mutate({ action: "add", path: A });

    expect(snapshot.projects.map((project) => project.path)).toEqual([A, B]);
    expect(snapshot.activeProject).toBe(A);
    expect(snapshot.projects[0]).toMatchObject({ addedAt: 42, lastOpenedAt: 42 });
    expect(backing.current().activeProject).toBe(A);
  });

  it("removes a project and moves the active pointer to the next one", async () => {
    const backing = store({ activeProject: A, projects: [record(A), record(B)] });
    const service = createProjectsService({ store: backing });

    const snapshot = await service.mutate({ action: "remove", path: A });

    expect(snapshot.projects.map((project) => project.path)).toEqual([B]);
    expect(snapshot.activeProject).toBe(B);
  });

  it("reorders projects", async () => {
    const backing = store({ projects: [record(A), record(B)] });
    const service = createProjectsService({ store: backing });

    const snapshot = await service.mutate({ action: "reorder", path: B, toIndex: 0 });
    expect(snapshot.projects.map((project) => project.path)).toEqual([B, A]);
  });

  it("activates a known project and clears the active project", async () => {
    const backing = store({ projects: [record(A), record(B)] });
    const service = createProjectsService({ store: backing });

    expect((await service.mutate({ action: "activate", path: B })).activeProject).toBe(B);
    expect((await service.mutate({ action: "activate", path: null })).activeProject).toBeNull();
    await expect(service.mutate({ action: "activate", path: "C:/nope" })).rejects.toThrow(
      /unknown project/,
    );
  });

  it("sets and clears the project settings toggle", async () => {
    const backing = store({ projects: [record(A)] });
    const service = createProjectsService({ store: backing });

    const set = await service.mutate({
      action: "update",
      path: A,
      patch: { useProjectSettings: true },
    });
    expect(set.projects[0]?.useProjectSettings).toBe(true);

    const cleared = await service.mutate({
      action: "update",
      path: A,
      patch: { useProjectSettings: false },
    });
    expect(cleared.projects[0]?.useProjectSettings).toBeUndefined();

    await expect(service.mutate({ action: "update", path: "C:/nope", patch: {} })).rejects.toThrow(
      /unknown project/,
    );
  });

  it("sanitizes a corrupted store and drops an active path that is not remembered", async () => {
    const backing = store({
      activeProject: "C:/gone",
      projects: [record(A), null, 7, { path: "" }],
    });
    const service = createProjectsService({ store: backing });

    const snapshot = await service.snapshot();
    expect(snapshot.projects.map((project) => project.path)).toEqual([A]);
    expect(snapshot.activeProject).toBeNull();
  });
});
