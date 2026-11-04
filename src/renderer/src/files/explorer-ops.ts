/**
 * Explorer mutation actions.
 *
 * The toolbar and context menus call these functions; they own the small amount
 * of coordination the stores must not own themselves: mark the target project
 * busy, call the workspace bridge, retarget open editor tabs after a rename or
 * move, close tabs after a delete, and refresh only the affected directories.
 */

import { sameFolder } from "../../../shared/rail-scope";
import {
  isWorkspaceEntryName,
  isWorkspacePathWithin,
  workspaceAbsolutePath,
  workspaceDirname,
  workspaceDisplayRelativePath,
  workspaceJoin,
  type WorkspaceEntryKind,
  type WorkspaceResult,
} from "../../../shared/workspace";
import { useAppStore } from "../state/app-store";
import { useEditorStore } from "../editor/editor-store";
import { copyText } from "../ui/clipboard";
import { useExplorerStore } from "./explorer-store";
import { useFileClipboardStore } from "./file-clipboard-store";

function failureMessage(result: { ok: false; error: { message: string } }): string {
  return result.error.message;
}

function hint(message: string): void {
  useAppStore.getState().setHint(message);
}

function finish<T>(
  projectPath: string,
  result: WorkspaceResult<T>,
): result is { ok: true; value: T } {
  const explorer = useExplorerStore.getState();
  if (result.ok) {
    explorer.endMutation(projectPath, null);
    return true;
  }
  explorer.endMutation(projectPath, failureMessage(result));
  hint(failureMessage(result));
  return false;
}

function expand(projectPath: string, path: string): void {
  if (path.length === 0) return;
  const tree = useExplorerStore.getState().trees[projectPath];
  if (tree?.expanded[path]) return;
  useExplorerStore.getState().toggle(projectPath, path);
}

export async function createExplorerEntry(
  projectPath: string,
  parentPath: string,
  name: string,
  kind: WorkspaceEntryKind,
): Promise<boolean> {
  if (!isWorkspaceEntryName(name)) {
    hint("That name is not valid for a file or folder.");
    return false;
  }
  const explorer = useExplorerStore.getState();
  const api = window.pi;
  if (!api?.workspace) {
    hint("The preload bridge is unavailable.");
    return false;
  }
  const path = workspaceJoin(parentPath, name);
  explorer.beginMutation(projectPath);
  const result = await api.workspace.create({ projectPath, path, kind }).catch((error) => ({
    ok: false as const,
    error: { code: "unavailable" as const, message: String(error) },
  }));
  if (!finish(projectPath, result)) return false;

  expand(projectPath, parentPath);
  await useExplorerStore.getState().refreshPath(projectPath, parentPath);
  if (kind === "file") await useEditorStore.getState().openFileTab(projectPath, path);
  hint(kind === "file" ? `Created ${name}.` : `Created folder ${name}.`);
  return true;
}

export async function renameExplorerEntry(
  projectPath: string,
  path: string,
  newName: string,
): Promise<boolean> {
  if (!isWorkspaceEntryName(newName)) {
    hint("That name is not valid for a file or folder.");
    return false;
  }
  const toPath = workspaceJoin(workspaceDirname(path), newName);
  if (toPath === path) return true;
  const api = window.pi;
  if (!api?.workspace) {
    hint("The preload bridge is unavailable.");
    return false;
  }

  useExplorerStore.getState().beginMutation(projectPath);
  const result = await api.workspace.rename({ projectPath, path, toPath }).catch((error) => ({
    ok: false as const,
    error: { code: "unavailable" as const, message: String(error) },
  }));
  if (!finish(projectPath, result)) return false;

  const input = {
    fromProjectPath: projectPath,
    fromPath: path,
    toProjectPath: projectPath,
    toPath,
    kind: result.value.kind,
  };
  const envelope = await useAppStore.getState().retargetEditorTabs(input);
  if (envelope) useEditorStore.getState().retargetEditorPaths(input);

  useExplorerStore.getState().applyRename(projectPath, path, toPath);
  await useExplorerStore.getState().refreshPath(projectPath, workspaceDirname(toPath));
  useFileClipboardStore.getState().forgetPath(projectPath, path);
  hint(`Renamed to ${newName}.`);
  return true;
}

export async function deleteExplorerEntry(
  projectPath: string,
  path: string,
  kind: WorkspaceEntryKind,
): Promise<boolean> {
  const app = useAppStore.getState();
  const affected = app.tabs.filter(
    (tab) =>
      tab.kind === "editor" &&
      sameFolder(tab.cwd, projectPath) &&
      typeof tab.filePath === "string" &&
      isWorkspacePathWithin(tab.filePath, path, kind),
  );
  const resolved = await useEditorStore.getState().resolveDirtyTabs(
    affected.map((tab) => tab.id),
    "delete",
  );
  if (!resolved) return false;

  const api = window.pi;
  if (!api?.workspace) {
    hint("The preload bridge is unavailable.");
    return false;
  }
  useExplorerStore.getState().beginMutation(projectPath);
  const result = await api.workspace.delete({ projectPath, path }).catch((error) => ({
    ok: false as const,
    error: { code: "unavailable" as const, message: String(error) },
  }));
  if (!finish(projectPath, result)) return false;

  for (const tab of affected) await useAppStore.getState().closeTab(tab.id);
  useExplorerStore.getState().applyDelete(projectPath, [path]);
  await useExplorerStore.getState().refreshPath(projectPath, workspaceDirname(path));
  useFileClipboardStore.getState().forgetPath(projectPath, path);
  hint("Moved to the Recycle Bin.");
  return true;
}

export async function pasteExplorerEntries(
  targetProjectPath: string,
  targetDirectory: string,
): Promise<boolean> {
  const clipboard = useFileClipboardStore.getState().clipboard;
  if (!clipboard) {
    hint("Copy or cut a file first.");
    return false;
  }
  const api = window.pi;
  if (!api?.workspace) {
    hint("The preload bridge is unavailable.");
    return false;
  }

  useExplorerStore.getState().beginMutation(targetProjectPath);
  const result = await api.workspace
    .transfer({
      sourceProjectPath: clipboard.sourceProjectPath,
      targetProjectPath,
      sources: clipboard.paths,
      targetDirectory,
      operation: clipboard.mode === "cut" ? "move" : "copy",
    })
    .catch((error) => ({
      ok: false as const,
      error: { code: "unavailable" as const, message: String(error) },
    }));
  if (!finish(targetProjectPath, result)) return false;

  if (clipboard.mode === "cut") {
    for (const item of result.value.transferred) {
      const input = {
        fromProjectPath: clipboard.sourceProjectPath,
        fromPath: item.sourcePath,
        toProjectPath: targetProjectPath,
        toPath: item.targetPath,
        kind: item.kind,
      };
      const envelope = await useAppStore.getState().retargetEditorTabs(input);
      if (envelope) useEditorStore.getState().retargetEditorPaths(input);
    }
    useFileClipboardStore.getState().clear();
  }

  await useExplorerStore.getState().refresh(clipboard.sourceProjectPath);
  if (!sameFolder(clipboard.sourceProjectPath, targetProjectPath)) {
    await useExplorerStore.getState().refresh(targetProjectPath);
  } else {
    await useExplorerStore.getState().refreshPath(targetProjectPath, targetDirectory);
  }
  hint(
    clipboard.mode === "cut"
      ? `Moved ${result.value.transferred.length} entr${result.value.transferred.length === 1 ? "y" : "ies"}.`
      : `Copied ${result.value.transferred.length} entr${result.value.transferred.length === 1 ? "y" : "ies"}.`,
  );
  return true;
}

export async function copyExplorerPath(
  projectPath: string,
  path: string,
  mode: "absolute" | "relative",
): Promise<boolean> {
  const value =
    mode === "absolute"
      ? workspaceAbsolutePath(projectPath, path)
      : workspaceDisplayRelativePath(projectPath, path);
  const copied = await copyText(value);
  hint(copied ? "Path copied." : "Could not copy the path.");
  return copied;
}

export async function revealExplorerPath(projectPath: string, path: string): Promise<boolean> {
  const api = window.pi;
  if (!api?.workspace) return false;
  const result = await api.workspace.reveal({ projectPath, path });
  if (!result.ok) hint(result.error.message);
  return result.ok && result.value;
}

export async function addExplorerPathToChat(
  projectPath: string,
  path: string,
  kind: WorkspaceEntryKind,
): Promise<boolean> {
  return useAppStore.getState().addWorkspaceMention(projectPath, path, kind);
}
