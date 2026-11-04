/**
 * The explorer's file clipboard.
 *
 * Copy/Cut put project-relative paths in this store; Paste asks the workspace
 * service to copy or move them. It is app-internal on purpose: the payload is
 * typed and can be validated against both projects, and Cut can clear only
 * after the move succeeded. Cross-project paste is allowed because the
 * workspace transfer engine resolves both roots through the project allowlist.
 */

import { create } from "zustand";

import { sameFolder } from "../../../shared/rail-scope";
import { isWorkspacePathWithin } from "../../../shared/workspace";

export type FileClipboardMode = "copy" | "cut";

export interface FileClipboardEntry {
  sourceProjectPath: string;
  paths: string[];
  mode: FileClipboardMode;
}

interface FileClipboardStore {
  clipboard: FileClipboardEntry | null;
  copy(projectPath: string, paths: readonly string[]): void;
  cut(projectPath: string, paths: readonly string[]): void;
  clear(): void;
  /** Clears the clipboard when one of its entries was renamed or deleted. */
  forgetPath(projectPath: string, path: string): void;
  /** Clears all entries from a removed project. */
  forgetProject(projectPath: string): void;
  canPaste(targetProjectPath: string): boolean;
}

export const useFileClipboardStore = create<FileClipboardStore>((set, get) => ({
  clipboard: null,

  copy(projectPath, paths) {
    if (paths.length === 0) return;
    set({ clipboard: { sourceProjectPath: projectPath, paths: [...paths], mode: "copy" } });
  },

  cut(projectPath, paths) {
    if (paths.length === 0) return;
    set({ clipboard: { sourceProjectPath: projectPath, paths: [...paths], mode: "cut" } });
  },

  clear() {
    set({ clipboard: null });
  },

  forgetPath(projectPath, path) {
    const clipboard = get().clipboard;
    if (!clipboard || !sameFolder(clipboard.sourceProjectPath, projectPath)) return;
    const affected = clipboard.paths.some(
      (entry) => entry === path || isWorkspacePathWithin(entry, path, "directory"),
    );
    if (affected) set({ clipboard: null });
  },

  forgetProject(projectPath) {
    const clipboard = get().clipboard;
    if (clipboard && sameFolder(clipboard.sourceProjectPath, projectPath)) {
      set({ clipboard: null });
    }
  },

  canPaste(targetProjectPath) {
    const clipboard = get().clipboard;
    if (!clipboard) return false;
    // Cross-project paste is intentionally allowed; the target project only has
    // to be open (the main-process allowlist is the final authority).
    return targetProjectPath.length > 0;
  },
}));
