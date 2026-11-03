/**
 * Remove-project orchestration.
 *
 * The app store owns the tab table and the project list; the editor store owns
 * dirty buffers; the explorer and clipboard stores keep per-project renderer
 * caches. This wrapper is the one place that combines them so a removal cannot
 * discard an unsaved edit or leave stale cache entries behind.
 */

import { sameFolder } from "../../../shared/rail-scope";
import { useEditorStore } from "../editor/editor-store";
import { useExplorerStore } from "../files/explorer-store";
import { useFileClipboardStore } from "../files/file-clipboard-store";
import { useAppStore } from "../state/app-store";

export async function removeProjectWithPrompt(path: string): Promise<boolean> {
  const tabs = useAppStore.getState().tabs.filter((tab) => sameFolder(tab.cwd, path));
  const editorIds = tabs.filter((tab) => tab.kind === "editor").map((tab) => tab.id);

  if (!(await useEditorStore.getState().resolveDirtyTabs(editorIds, "remove-project"))) {
    return false;
  }
  if (!(await useAppStore.getState().removeProject(path))) return false;

  useExplorerStore.getState().forgetProject(path);
  useFileClipboardStore.getState().forgetProject(path);
  return true;
}
