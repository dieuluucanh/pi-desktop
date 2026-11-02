/**
 * The main-process workspace service.
 *
 * The renderer talks to this through `workspace:*` IPC. Every method takes an
 * already-resolved absolute project path (the IPC layer applies the open-project
 * allowlist) and a project-relative POSIX path. The service applies the pure
 * engines from `src/workspace` and maps their errors to the shared
 * `WorkspaceResult` envelope so the renderer can distinguish "changed on disk"
 * from "forbidden" after crossing Electron's IPC boundary.
 *
 * No Electron import: the shell reveal is an injected port. No direct
 * filesystem access: the IO adapter is injected, which is what makes the whole
 * service testable with an in-memory tree.
 */

import { join } from "node:path";

import {
  MAX_DIRECTORY_ENTRIES,
  MAX_QUICK_OPEN_FILES,
  isWorkspaceRelativePath,
  workspaceFailure,
  workspaceOk,
  type EditorBackup,
  type ResolvedEditorConfig,
  type WorkspaceFileContent,
  type WorkspaceFileList,
  type WorkspaceListing,
  type WorkspaceResult,
  type WorkspaceSearchRequest,
  type WorkspaceSearchResult,
  type WorkspaceStat,
  type WorkspaceWriteInput,
  type WorkspaceWriteResult,
} from "../shared/workspace";
import {
  isSafeBackupTabId,
  isEditorBackupExpired,
  backupFileName,
  parseEditorBackup,
  serializeEditorBackup,
} from "../workspace/backup";
import { resolveEditorConfig } from "../workspace/editorconfig";
import {
  FileContentError,
  readWorkspaceContent,
  statWorkspaceFile,
  writeWorkspaceContent,
} from "../workspace/file-content";
import { listWorkspaceFiles } from "../workspace/file-listing";
import { searchWorkspaceFiles } from "../workspace/file-search";
import { resolveInsideRoot } from "../workspace/path-guard";
import { listWorkspaceDirectory, WorkspaceTreeError } from "../workspace/tree";
import type { WorkspaceNodeIo } from "./workspace-io";

export interface WorkspaceService {
  listDirectory(input: {
    projectPath: string;
    path: string;
  }): Promise<WorkspaceResult<WorkspaceListing>>;
  listFiles(input: {
    projectPath: string;
    limit?: number;
  }): Promise<WorkspaceResult<WorkspaceFileList>>;
  searchFiles(input: WorkspaceSearchRequest): Promise<WorkspaceResult<WorkspaceSearchResult>>;
  readFile(input: {
    projectPath: string;
    path: string;
  }): Promise<WorkspaceResult<WorkspaceFileContent>>;
  stat(input: { projectPath: string; path: string }): Promise<WorkspaceResult<WorkspaceStat>>;
  writeFile(input: WorkspaceWriteInput): Promise<WorkspaceResult<WorkspaceWriteResult>>;
  reveal(input: { projectPath: string; path: string }): Promise<WorkspaceResult<boolean>>;
  editorConfig(input: {
    projectPath: string;
    path: string;
  }): Promise<WorkspaceResult<ResolvedEditorConfig>>;
  readBackup(tabId: string): Promise<WorkspaceResult<EditorBackup | null>>;
  writeBackup(backup: EditorBackup): Promise<WorkspaceResult<boolean>>;
  deleteBackup(tabId: string): Promise<WorkspaceResult<boolean>>;
  pruneBackups(validTabIds: readonly string[]): Promise<WorkspaceResult<number>>;
}

export interface WorkspaceServiceDeps {
  io: WorkspaceNodeIo;
  /** `<userData>/editor-backups`. Created lazily on the first write. */
  backupsDir: string;
  now?: () => number;
  /** Electron's `shell.showItemInFolder`, injected by `src/main/index.ts`. */
  reveal?: (absolutePath: string) => Promise<boolean> | boolean;
}

function toFailure(error: unknown): WorkspaceResult<never> {
  if (error instanceof WorkspaceTreeError) {
    return workspaceFailure(error.code, error.message);
  }
  if (error instanceof FileContentError) {
    return workspaceFailure(error.code, error.message, error.current);
  }
  return workspaceFailure("unavailable", error instanceof Error ? error.message : String(error));
}

function backupPath(backupsDir: string, tabId: string): string {
  return join(backupsDir, backupFileName(tabId));
}

export function createWorkspaceService(deps: WorkspaceServiceDeps): WorkspaceService {
  const now = deps.now ?? ((): number => Date.now());

  return {
    async listDirectory(input) {
      try {
        const listing = await listWorkspaceDirectory(deps.io, input.projectPath, input.path, {
          limit: MAX_DIRECTORY_ENTRIES,
        });
        return workspaceOk(listing);
      } catch (error) {
        return toFailure(error);
      }
    },

    async listFiles(input) {
      try {
        const requested = input.limit ?? MAX_QUICK_OPEN_FILES;
        const limit = Number.isFinite(requested)
          ? Math.min(MAX_QUICK_OPEN_FILES, Math.max(1, Math.floor(requested)))
          : MAX_QUICK_OPEN_FILES;
        const listing = await listWorkspaceFiles(deps.io, input.projectPath, { limit });
        return workspaceOk({
          root: input.projectPath,
          files: listing.files,
          truncated: listing.truncated,
        });
      } catch (error) {
        return toFailure(error);
      }
    },

    async readFile(input) {
      try {
        return workspaceOk(await readWorkspaceContent(deps.io, input.projectPath, input.path));
      } catch (error) {
        return toFailure(error);
      }
    },

    async searchFiles(input) {
      try {
        const result = await searchWorkspaceFiles(deps.io, input.projectPath, {
          query: input.query,
          includeHidden: input.includeHidden ?? true,
          includeIgnored: input.includeIgnored ?? false,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        });
        return workspaceOk({
          root: input.projectPath,
          query: input.query,
          ...result,
        });
      } catch (error) {
        return toFailure(error);
      }
    },
    async stat(input) {
      try {
        return workspaceOk(await statWorkspaceFile(deps.io, input.projectPath, input.path));
      } catch (error) {
        return toFailure(error);
      }
    },

    async writeFile(input) {
      try {
        const { projectPath, ...file } = input;
        return workspaceOk(await writeWorkspaceContent(deps.io, projectPath, file));
      } catch (error) {
        return toFailure(error);
      }
    },

    async reveal(input) {
      try {
        if (!deps.reveal) {
          return workspaceFailure("unavailable", "revealing files is not available");
        }
        const target = await resolveInsideRoot(deps.io, input.projectPath, input.path);
        if (target === null) {
          return workspaceFailure("forbidden", "that path is outside the project");
        }
        return workspaceOk(await deps.reveal(target));
      } catch (error) {
        return toFailure(error);
      }
    },

    async editorConfig(input) {
      try {
        if (!isWorkspaceRelativePath(input.path)) {
          return workspaceFailure("forbidden", "that path is not inside the project");
        }
        return workspaceOk(await resolveEditorConfig(deps.io, input.projectPath, input.path));
      } catch (error) {
        return toFailure(error);
      }
    },

    async readBackup(tabId) {
      if (!isSafeBackupTabId(tabId)) {
        return workspaceFailure("bad_request", "invalid editor tab id");
      }
      const text = await deps.io.readTextFile(backupPath(deps.backupsDir, tabId));
      const backup = parseEditorBackup(text);
      return workspaceOk(backup && backup.tabId === tabId ? backup : null);
    },

    async writeBackup(backup) {
      if (!isSafeBackupTabId(backup.tabId)) {
        return workspaceFailure("bad_request", "invalid editor tab id");
      }
      const json = serializeEditorBackup({ ...backup, updatedAt: backup.updatedAt || now() });
      if (json === null) {
        return workspaceFailure("too_large", "the editor backup is too large to keep");
      }
      try {
        await deps.io.ensureDir(deps.backupsDir);
        await deps.io.writeAtomic(backupPath(deps.backupsDir, backup.tabId), json, 0o600);
        return workspaceOk(true);
      } catch (error) {
        return toFailure(error);
      }
    },

    async deleteBackup(tabId) {
      if (!isSafeBackupTabId(tabId)) {
        return workspaceFailure("bad_request", "invalid editor tab id");
      }
      return workspaceOk(await deps.io.remove(backupPath(deps.backupsDir, tabId)));
    },

    async pruneBackups(validTabIds) {
      const valid = new Set(validTabIds.filter(isSafeBackupTabId));
      let removed = 0;
      for (const name of await deps.io.listDirectoryNames(deps.backupsDir)) {
        if (!name.endsWith(".json")) continue;
        const tabId = name.slice(0, -".json".length);
        if (!isSafeBackupTabId(tabId)) {
          if (await deps.io.remove(join(deps.backupsDir, name))) removed += 1;
          continue;
        }
        const backup = parseEditorBackup(await deps.io.readTextFile(join(deps.backupsDir, name)));
        if (backup === null || !valid.has(tabId) || isEditorBackupExpired(backup, now())) {
          if (await deps.io.remove(join(deps.backupsDir, name))) removed += 1;
        }
      }
      return workspaceOk(removed);
    },
  };
}
