/**
 * The remembered project list (plan step 10).
 *
 * `app-state.json` is the single writer of the project list (the same store the
 * tab table uses); this service turns a validated mutation into a new snapshot
 * and returns it, so the renderer never has to guess what the store did.
 *
 * It is Electron-free: the store is injected, and `now` is a port so ordering is
 * testable without a clock.
 */

import {
  MAX_PROJECT_PATH,
  addProject,
  findProject,
  isProjectAction,
  removeProject,
  reorderProject,
  sanitizeProjects,
  updateProject,
  type CloneProjectInput,
  type CreateProjectInput,
  type ProjectActionInput,
  type ProjectConfigPatch,
  type ProjectMutation,
  type ProjectRecord,
  type ProjectsSnapshot,
} from "../shared/projects";

export interface ProjectStoreLike {
  read(): Promise<{ activeProject: unknown; projects: unknown }>;
  update(patch: { projects?: ProjectRecord[]; activeProject?: string | null }): Promise<unknown>;
}

export interface ProjectsServiceDeps {
  store: ProjectStoreLike;
  now?: () => number;
}

export interface ProjectsService {
  snapshot(): Promise<ProjectsSnapshot>;
  mutate(mutation: ProjectMutation): Promise<ProjectsSnapshot>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function requireString(value: unknown, label: string, max = MAX_PROJECT_PATH): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`projects: ${label} is required`);
  }
  if (value.length > max) throw new Error(`projects: ${label} is too long`);
  return value.trim();
}

/** A nullable config value: `undefined` keeps it, `null` clears it, a string sets it. */
function parseConfigPatch(value: unknown): ProjectConfigPatch {
  const record = asRecord(value);
  const patch: ProjectConfigPatch = {};
  if (record.useProjectSettings !== undefined) {
    if (typeof record.useProjectSettings !== "boolean") {
      throw new Error("projects: useProjectSettings must be a boolean");
    }
    patch.useProjectSettings = record.useProjectSettings;
  }
  return patch;
}

/** Validates one raw mutation from the renderer; unknown shapes are rejected. */
export function parseProjectMutation(value: unknown): ProjectMutation {
  const record = asRecord(value);
  const action = record.action;
  if (action === "add" || action === "remove") {
    return { action, path: requireString(record.path, "path") };
  }
  if (action === "reorder") {
    const toIndex = record.toIndex;
    if (typeof toIndex !== "number" || !Number.isFinite(toIndex)) {
      throw new Error("projects: reorder requires a numeric toIndex");
    }
    return { action, path: requireString(record.path, "path"), toIndex };
  }
  if (action === "activate") {
    if (record.path === null) return { action, path: null };
    return { action, path: requireString(record.path, "path") };
  }
  if (action === "update") {
    return {
      action,
      path: requireString(record.path, "path"),
      patch: parseConfigPatch(record.patch),
    };
  }
  throw new Error(`projects: unknown mutation ${String(action)}`);
}

export function parseCreateProjectInput(value: unknown): CreateProjectInput {
  const record = asRecord(value);
  const input: CreateProjectInput = {
    parentDir: requireString(record.parentDir, "parentDir"),
    name: requireString(record.name, "name", 200),
  };
  if (record.gitInit !== undefined) {
    if (typeof record.gitInit !== "boolean") throw new Error("projects: gitInit must be a boolean");
    input.gitInit = record.gitInit;
  }
  return input;
}

export function parseCloneProjectInput(value: unknown): CloneProjectInput {
  const record = asRecord(value);
  const input: CloneProjectInput = {
    parentDir: requireString(record.parentDir, "parentDir"),
    url: requireString(record.url, "url", 2048),
  };
  if (record.name !== undefined) input.name = requireString(record.name, "name", 200);
  return input;
}

export function parseProjectActionInput(value: unknown): ProjectActionInput {
  const record = asRecord(value);
  if (!isProjectAction(record.action)) {
    throw new Error(`projects: unknown action ${String(record.action)}`);
  }
  return { path: requireString(record.path, "path"), action: record.action };
}

export function createProjectsService(deps: ProjectsServiceDeps): ProjectsService {
  const now = deps.now ?? ((): number => Date.now());

  const snapshot = async (): Promise<ProjectsSnapshot> => {
    const state = await deps.store.read();
    const projects = sanitizeProjects(state.projects);
    const activeProject =
      typeof state.activeProject === "string" && findProject(projects, state.activeProject)
        ? state.activeProject
        : null;
    return { projects, activeProject };
  };

  return {
    snapshot,

    async mutate(mutation) {
      const current = await snapshot();
      let projects = current.projects;
      let activeProject = current.activeProject;

      switch (mutation.action) {
        case "add":
          projects = addProject(projects, mutation.path, now());
          activeProject = findProject(projects, mutation.path)?.path ?? activeProject;
          break;
        case "remove":
          projects = removeProject(projects, mutation.path);
          if (activeProject && !findProject(projects, activeProject)) {
            activeProject = projects[0]?.path ?? null;
          }
          break;
        case "reorder":
          projects = reorderProject(projects, mutation.path, mutation.toIndex);
          break;
        case "activate": {
          if (mutation.path === null) {
            activeProject = null;
            break;
          }
          const record = findProject(projects, mutation.path);
          if (!record) throw new Error(`projects: unknown project ${mutation.path}`);
          activeProject = record.path;
          break;
        }
        case "update": {
          if (!findProject(projects, mutation.path)) {
            throw new Error(`projects: unknown project ${mutation.path}`);
          }
          projects = updateProject(projects, mutation.path, mutation.patch);
          break;
        }
      }

      await deps.store.update({ projects, activeProject });
      return { projects, activeProject };
    },
  };
}
