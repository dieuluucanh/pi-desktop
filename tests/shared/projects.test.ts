import { describe, expect, it } from "vitest";
import {
  MAX_PROJECTS,
  MAX_PROJECT_SETTINGS_SNAPSHOT_CHARS,
  addProject,
  encodeSessionDirName,
  findProject,
  normalizeProjectPath,
  projectNameOf,
  removeProject,
  reorderProject,
  sanitizeProjectRecord,
  sanitizeProjectSettingsSnapshots,
  sanitizeProjects,
  updateProject,
  type ProjectRecord,
} from "../../src/shared/projects";

function record(path: string, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return { path, name: projectNameOf(path), addedAt: 1, lastOpenedAt: 1, ...overrides };
}

describe("projectNameOf / normalizeProjectPath", () => {
  it("takes the last path segment for both separators and trailing slashes", () => {
    expect(projectNameOf("/home/me/app")).toBe("app");
    expect(projectNameOf("C:\\work\\pi-desktop\\")).toBe("pi-desktop");
    // A bare root has no last segment; the caller keeps the path itself as the label.
    expect(projectNameOf("/")).toBe("");
  });

  it("drops trailing separators but keeps a root path", () => {
    expect(normalizeProjectPath("C:/work/app/")).toBe("C:/work/app");
    expect(normalizeProjectPath("/home/me/app//")).toBe("/home/me/app");
    expect(normalizeProjectPath("  C:/work/app  ")).toBe("C:/work/app");
    expect(normalizeProjectPath("/")).toBe("/");
  });
});

describe("sanitizeProjects", () => {
  it("drops unusable entries and dedupes by path", () => {
    const projects = sanitizeProjects([
      record("C:/a"),
      null,
      42,
      { path: "" },
      record("C:/b", { name: "bee" }),
      record("C:/a"),
    ]);

    expect(projects.map((project) => project.path)).toEqual(["C:/a", "C:/b"]);
    expect(projects[1]?.name).toBe("bee");
  });

  it("accepts a bare legacy recent-project path string", () => {
    expect(sanitizeProjectRecord("C:/work/app")).toEqual({
      path: "C:/work/app",
      name: "app",
      addedAt: 0,
      lastOpenedAt: 0,
    });
  });

  it("keeps the project settings toggle only when true", () => {
    expect(sanitizeProjectRecord({ path: "C:/a", useProjectSettings: true })).toMatchObject({
      useProjectSettings: true,
    });
    expect(
      sanitizeProjectRecord({ path: "C:/a", useProjectSettings: "yes" })?.useProjectSettings,
    ).toBeUndefined();
  });

  it("drops the retired app-state default fields", () => {
    expect(
      sanitizeProjectRecord({
        path: "C:/a",
        defaultModel: "anthropic/claude-sonnet-4",
        defaultThinking: "high",
      }),
    ).toEqual({ path: "C:/a", name: "a", addedAt: 0, lastOpenedAt: 0 });
  });

  it("sanitizes project settings snapshots", () => {
    const good = JSON.stringify({ enabledModels: ["fake/fake-1"] });
    const snapshots = sanitizeProjectSettingsSnapshots({
      "C:/a": { json: good, savedAt: 1 },
      "C:/bad-json": { json: "{", savedAt: 1 },
      "C:/array": { json: "[]", savedAt: 1 },
      "C:/negative-time": { json: good, savedAt: -1 },
      "C:/too-large": {
        json: JSON.stringify({ value: "x".repeat(MAX_PROJECT_SETTINGS_SNAPSHOT_CHARS) }),
        savedAt: 1,
      },
    });

    expect(snapshots).toEqual({ "C:/a": { json: good, savedAt: 1 } });
  });

  it("enforces the project cap", () => {
    const many = Array.from({ length: MAX_PROJECTS + 5 }, (_, index) => record(`C:/p${index}`));
    expect(sanitizeProjects(many)).toHaveLength(MAX_PROJECTS);
  });
});

describe("addProject", () => {
  it("puts a new project first and stamps both times", () => {
    const list = addProject([record("C:/a")], "C:/b", 100);

    expect(list.map((project) => project.path)).toEqual(["C:/b", "C:/a"]);
    expect(list[0]).toMatchObject({ addedAt: 100, lastOpenedAt: 100, name: "b" });
  });

  it("moves an existing project to the front and keeps its addedAt", () => {
    const list = addProject([record("C:/a", { addedAt: 5 }), record("C:/b")], "C:/a", 100);

    expect(list.map((project) => project.path)).toEqual(["C:/a", "C:/b"]);
    expect(list[0]).toMatchObject({ addedAt: 5, lastOpenedAt: 100 });
  });

  it("ignores an empty path", () => {
    const list = [record("C:/a")];
    expect(addProject(list, "", 1)).toEqual(list);
  });
});

describe("removeProject / reorderProject", () => {
  it("removes by normalized path", () => {
    const list = [record("C:/a"), record("C:/b")];
    expect(removeProject(list, "C:/a/").map((project) => project.path)).toEqual(["C:/b"]);
  });

  it("moves a project to a clamped index", () => {
    const list = [record("C:/a"), record("C:/b"), record("C:/c")];
    expect(reorderProject(list, "C:/c", 0).map((project) => project.path)).toEqual([
      "C:/c",
      "C:/a",
      "C:/b",
    ]);
    expect(reorderProject(list, "C:/a", 99).map((project) => project.path)).toEqual([
      "C:/b",
      "C:/c",
      "C:/a",
    ]);
  });

  it("leaves an unknown path alone", () => {
    const list = [record("C:/a")];
    expect(reorderProject(list, "C:/zzz", 0)).toEqual(list);
  });
});

describe("updateProject", () => {
  it("turns the project settings toggle on and off", () => {
    const on = updateProject([record("C:/a")], "C:/a", { useProjectSettings: true });
    expect(on[0]?.useProjectSettings).toBe(true);

    const unchanged = updateProject(on, "C:/a", { useProjectSettings: undefined });
    expect(unchanged[0]?.useProjectSettings).toBe(true);

    const off = updateProject(on, "C:/a", { useProjectSettings: false });
    expect(off[0]?.useProjectSettings).toBeUndefined();
  });

  it("does not touch other projects", () => {
    const list = [record("C:/a"), record("C:/b")];
    const next = updateProject(list, "C:/b", { useProjectSettings: true });
    expect(next[0]?.useProjectSettings).toBeUndefined();
    expect(next[1]?.useProjectSettings).toBe(true);
  });
});

describe("findProject", () => {
  it("matches a normalized path and tolerates null", () => {
    const list = [record("C:/a")];
    expect(findProject(list, "C:/a/")?.path).toBe("C:/a");
    expect(findProject(list, null)).toBeNull();
    expect(findProject(list, "C:/b")).toBeNull();
  });
});

describe("encodeSessionDirName", () => {
  it("mirrors Pi's session-directory encoding", () => {
    expect(encodeSessionDirName("/home/me/app")).toBe("--home-me-app--");
    expect(encodeSessionDirName("C:\\work\\pi-desktop")).toBe("--C--work-pi-desktop--");
    expect(encodeSessionDirName("/home/me/app/")).toBe("--home-me-app--");
  });
});
