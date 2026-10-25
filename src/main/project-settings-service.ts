/**
 * The project-settings toggle transaction (main process).
 *
 * One per-project switch decides whether the app uses the shared global
 * settings or `<project>/.pi/settings.json`. Pi always merges a project document
 * over global, so "off" cannot be a read-only flag: the document must be saved
 * and emptied. The snapshot lives in app state; enabling restores it when the
 * project file is still empty, and otherwise keeps whatever is there (the user
 * asked for that conflict rule).
 *
 * Filesystem access goes through the injected `FsPort`; the atomic helpers are
 * the same ones the Office/bridge code uses. A malformed document is never
 * overwritten, matching the app's settings rule.
 */

import { join } from "node:path";
import type { FsPort } from "./fs-port";
import type { AppStore } from "./app-store";
import {
  MAX_PROJECT_SETTINGS_SNAPSHOT_CHARS,
  findProject,
  sanitizeProjects,
  updateProject,
  type ProjectSettingsSnapshot,
  type ProjectSettingsToggleInput,
  type ProjectSettingsToggleResult,
  type ProjectSettingsSnapshot as Snapshot,
} from "../shared/projects";
import {
  readSettingsDocument,
  serializeSettingsDocument,
  writeSettingsDocument,
  type SettingsDocument,
} from "./packages/settings";

const CONFIG_DIR = ".pi";

export type ProjectSettingsErrorCode =
  "unknown_project" | "untrusted" | "too_large" | "invalid_snapshot";

export class ProjectSettingsError extends Error {
  readonly code: ProjectSettingsErrorCode;

  constructor(message: string, code: ProjectSettingsErrorCode) {
    super(message);
    this.name = "ProjectSettingsError";
    this.code = code;
  }
}

export interface ProjectSettingsService {
  /** Enables/disables project settings for one project. */
  setEnabled(input: ProjectSettingsToggleInput): Promise<ProjectSettingsToggleResult>;
  /**
   * One-time default-off migration: snapshot/empty existing project documents,
   * drop retired app-state defaults and set the migration marker. Safe to call
   * on every launch; it returns immediately once marked complete.
   */
  migrate(): Promise<{ migrated: boolean; errors: string[] }>;
}

export interface ProjectSettingsServiceOptions {
  fs: FsPort;
  store: AppStore;
  isProjectTrusted(path: string): boolean | Promise<boolean>;
  now?: () => number;
}

export function projectSettingsPath(projectPath: string): string {
  return join(projectPath, CONFIG_DIR, "settings.json");
}

function hasKeys(document: SettingsDocument): boolean {
  return Object.keys(document).length > 0;
}

export function createProjectSettingsService(
  options: ProjectSettingsServiceOptions,
): ProjectSettingsService {
  const now = options.now ?? ((): number => Date.now());

  const readSettings = (projectPath: string): Promise<SettingsDocument> =>
    readSettingsDocument(options.fs, projectSettingsPath(projectPath));

  const trusted = async (projectPath: string): Promise<boolean> => {
    try {
      return await options.isProjectTrusted(projectPath);
    } catch {
      return false;
    }
  };

  const result = async (
    enabled: boolean,
    flags: { saved: boolean; restored: boolean; keptCurrent: boolean },
    settingsPath: string,
  ): Promise<ProjectSettingsToggleResult> => {
    const state = await options.store.read();
    return {
      projects: sanitizeProjects(state.projects),
      activeProject: state.activeProject,
      enabled,
      ...flags,
      settingsPath,
    };
  };

  return {
    async setEnabled(input) {
      const state = await options.store.read();
      const projects = sanitizeProjects(state.projects);
      const project = findProject(projects, input.path);
      if (!project) {
        throw new ProjectSettingsError(
          `projects: unknown project ${input.path}`,
          "unknown_project",
        );
      }
      if (!(await trusted(project.path))) {
        throw new ProjectSettingsError(
          "the project is not trusted; refusing to change project settings",
          "untrusted",
        );
      }

      const path = projectSettingsPath(project.path);
      const current = await readSettings(project.path);
      const snapshots: Record<string, ProjectSettingsSnapshot> = {
        ...state.projectSettingsSnapshots,
      };

      if (!input.enabled) {
        const saved = hasKeys(current);
        if (saved) {
          const json = serializeSettingsDocument(current);
          if (json.length > MAX_PROJECT_SETTINGS_SNAPSHOT_CHARS) {
            throw new ProjectSettingsError(
              "the project settings document is too large to snapshot; trim it first",
              "too_large",
            );
          }
          snapshots[project.path] = { json, savedAt: now() };
        }

        const off = updateProject(projects, project.path, { useProjectSettings: false });
        // Write the snapshot/record first: a crash after the file is emptied
        // cannot lose the only copy.
        await options.store.update({
          projects: off,
          projectSettingsSnapshots: snapshots,
        });
        if (saved) {
          try {
            await writeSettingsDocument(options.fs, path, {});
          } catch (error) {
            // Keep the record on: the file still has the old values, so the
            // effective settings and the toggle stay consistent.
            await options.store
              .update({
                projects: updateProject(projects, project.path, { useProjectSettings: true }),
                projectSettingsSnapshots: snapshots,
              })
              .catch(() => undefined);
            throw error;
          }
        }
        return result(false, { saved, restored: false, keptCurrent: false }, path);
      }

      const snapshot: Snapshot | undefined = snapshots[project.path];
      let restored = false;
      const keptCurrent = hasKeys(current);
      if (!keptCurrent && snapshot) {
        let document: SettingsDocument;
        try {
          const parsed: unknown = JSON.parse(snapshot.json);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("snapshot is not a JSON object");
          }
          document = parsed as SettingsDocument;
        } catch (error) {
          throw new ProjectSettingsError(
            `the saved project settings snapshot is invalid: ${
              error instanceof Error ? error.message : String(error)
            }`,
            "invalid_snapshot",
          );
        }
        if (hasKeys(document)) {
          await writeSettingsDocument(options.fs, path, document);
          restored = true;
        }
      }

      try {
        await options.store.update({
          projects: updateProject(projects, project.path, { useProjectSettings: true }),
          projectSettingsSnapshots: snapshots,
        });
      } catch (error) {
        if (restored) {
          await writeSettingsDocument(options.fs, path, {}).catch(() => undefined);
        }
        throw error;
      }

      return result(true, { saved: false, restored, keptCurrent }, path);
    },

    async migrate() {
      const state = await options.store.read();
      if (state.projectSettingsMigrated) return { migrated: true, errors: [] };

      let projects = sanitizeProjects(state.projects);
      let snapshots: Record<string, ProjectSettingsSnapshot> = {
        ...state.projectSettingsSnapshots,
      };
      const errors: string[] = [];
      let failed = false;

      for (const project of projects) {
        if (project.useProjectSettings !== undefined) continue;
        if (!(await trusted(project.path))) {
          // Pi ignores an untrusted project's settings already. Leave the file
          // untouched; the project-panel warning offers to snapshot it later.
          projects = updateProject(projects, project.path, { useProjectSettings: false });
          continue;
        }
        try {
          const current = await readSettings(project.path);
          if (hasKeys(current)) {
            const json = serializeSettingsDocument(current);
            if (json.length > MAX_PROJECT_SETTINGS_SNAPSHOT_CHARS) {
              throw new Error("project settings are too large to snapshot");
            }
            snapshots[project.path] = { json, savedAt: now() };
            await writeSettingsDocument(options.fs, projectSettingsPath(project.path), {});
          }
          projects = updateProject(projects, project.path, { useProjectSettings: false });
        } catch (error) {
          failed = true;
          errors.push(`${project.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const known = new Set(projects.map((project) => project.path));
      snapshots = Object.fromEntries(
        Object.entries(snapshots).filter(([projectPath]) => known.has(projectPath)),
      );
      await options.store.update({
        projects,
        projectSettingsSnapshots: snapshots,
        projectSettingsMigrated: !failed,
      });
      return { migrated: !failed, errors };
    },
  };
}
