/**
 * Quick-open (`Ctrl+P`) state.
 *
 * The file list comes from `workspace.listFiles` (the gitignore-aware flat
 * listing) and is cached per project for 30 s. The dialog itself only filters
 * the cached list with the completion stack's fuzzy matcher.
 */

import { create } from "zustand";

import { useAppStore } from "../state/app-store";
import { useEditorStore } from "../editor/editor-store";

const CACHE_TTL_MS = 30_000;

interface QuickOpenState {
  open: boolean;
  query: string;
  files: string[];
  projectPath: string | null;
  loading: boolean;
  error: string | null;
  loadedAt: number;
  openDialog(): void;
  close(): void;
  setQuery(query: string): void;
  load(projectPath: string, force?: boolean): Promise<void>;
}

export const useQuickOpen = create<QuickOpenState>((set, get) => ({
  open: false,
  query: "",
  files: [],
  projectPath: null,
  loading: false,
  error: null,
  loadedAt: 0,

  openDialog() {
    const app = useAppStore.getState();
    const projectPath =
      app.project?.path ?? app.tabs.find((tab) => tab.id === app.activeTabId)?.cwd ?? null;
    set({ open: true, query: "", error: null });
    if (projectPath) void get().load(projectPath);
    else set({ files: [], error: "Open a project first." });
  },

  close() {
    set({ open: false, query: "" });
  },

  setQuery(query) {
    set({ query });
  },

  async load(projectPath, force = false) {
    if (
      !force &&
      get().projectPath === projectPath &&
      get().files.length > 0 &&
      Date.now() - get().loadedAt < CACHE_TTL_MS
    ) {
      return;
    }
    const api = window.pi;
    if (!api?.workspace) {
      set({ error: "The preload bridge is unavailable.", files: [] });
      return;
    }
    set({ loading: true, error: null, projectPath });
    const result = await api.workspace.listFiles({ projectPath, limit: 20_000 });
    if (!result.ok) {
      set({ loading: false, error: result.error.message, files: [] });
      return;
    }
    set({
      loading: false,
      files: result.value.files,
      projectPath,
      loadedAt: Date.now(),
    });
  },
}));

export async function openQuickFile(path: string, projectPath: string): Promise<void> {
  useQuickOpen.getState().close();
  await useEditorStore.getState().openFileTab(projectPath, path);
}
