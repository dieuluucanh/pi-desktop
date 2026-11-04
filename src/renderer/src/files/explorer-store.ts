/**
 * File explorer state.
 *
 * One lazy tree per project, loaded by directory. Expanding a folder fetches
 * only that folder; refreshing re-reads the root and the folders the user has
 * open. The view preferences (hidden/ignored/sort) live in app prefs, not here.
 *
 * Search is deliberately separate from the tree. The tree only knows the
 * folders the user has opened, so a query is answered by main's project-wide
 * file listing instead. Each project keeps its own query/results, the input is
 * debounced, and a request id guards against a slow response for an old query
 * landing after a newer one.
 */

import { create } from "zustand";

import type { WorkspaceEntry, WorkspaceSearchMatch } from "../../../shared/workspace";
import { useAppStore } from "../state/app-store";

export const EXPLORER_SEARCH_DEBOUNCE_MS = 180;
export const EXPLORER_SEARCH_LIMIT = 200;

export type ExplorerSearchStatus = "idle" | "loading" | "ready" | "error";

export interface ExplorerSearchState {
  query: string;
  status: ExplorerSearchStatus;
  results: WorkspaceSearchMatch[];
  truncated: boolean;
  scanned: number;
  error: string | null;
  /** Every query/refresh bump invalidates an in-flight response. */
  requestId: number;
}

export interface ExplorerTree {
  root: string;
  children: Record<string, WorkspaceEntry[]>;
  expanded: Record<string, true>;
  loading: Record<string, true>;
  /** Directory paths whose listing hit the per-directory cap. */
  truncated: Record<string, true>;
  error: string | null;
}

interface ExplorerStore {
  trees: Record<string, ExplorerTree>;
  searches: Record<string, ExplorerSearchState>;
  busy: Record<string, true>;
  lastError: Record<string, string | null>;
  ensure(projectPath: string): Promise<void>;
  toggle(projectPath: string, path: string): void;
  load(projectPath: string, path: string, force?: boolean): Promise<void>;
  refresh(projectPath: string): Promise<void>;
  refreshPath(projectPath: string, path: string): Promise<void>;
  setFilter(projectPath: string, query: string): void;
  clearFilter(projectPath: string): void;
  searchNow(projectPath: string): Promise<void>;
  cancelSearch(projectPath: string): void;
  beginMutation(projectPath: string): void;
  endMutation(projectPath: string, error?: string | null): void;
  forgetProject(projectPath: string): void;
  applyDelete(projectPath: string, paths: readonly string[]): void;
  applyRename(projectPath: string, fromPath: string, toPath: string): void;
}

const EMPTY_TREE = (root: string): ExplorerTree => ({
  root,
  children: {},
  expanded: {},
  loading: {},
  truncated: {},
  error: null,
});

const EMPTY_SEARCH = (): ExplorerSearchState => ({
  query: "",
  status: "idle",
  results: [],
  truncated: false,
  scanned: 0,
  error: null,
  requestId: 0,
});

const searchTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelSearchTimer(projectPath: string): void {
  const timer = searchTimers.get(projectPath);
  if (timer !== undefined) clearTimeout(timer);
  searchTimers.delete(projectPath);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useExplorerStore = create<ExplorerStore>((set, get) => ({
  trees: {},
  searches: {},
  busy: {},
  lastError: {},

  async ensure(projectPath) {
    if (get().trees[projectPath]) return;
    set((state) => ({ trees: { ...state.trees, [projectPath]: EMPTY_TREE(projectPath) } }));
    await get().load(projectPath, "", true);
  },

  toggle(projectPath, path) {
    const tree = get().trees[projectPath];
    if (!tree) return;
    const expanded = { ...tree.expanded };
    if (expanded[path]) {
      delete expanded[path];
      set((state) => ({
        trees: { ...state.trees, [projectPath]: { ...tree, expanded } },
      }));
      return;
    }
    expanded[path] = true;
    set((state) => ({ trees: { ...state.trees, [projectPath]: { ...tree, expanded } } }));
    if (!tree.children[path]) void get().load(projectPath, path);
  },

  async load(projectPath, path, force = false) {
    const tree = get().trees[projectPath];
    if (!tree) return;
    if (!force && tree.children[path]) return;
    const api = window.pi;
    if (!api?.workspace) {
      set((state) => ({
        trees: {
          ...state.trees,
          [projectPath]: { ...tree, error: "The preload bridge is unavailable." },
        },
      }));
      return;
    }
    set((state) => ({
      trees: {
        ...state.trees,
        [projectPath]: { ...tree, loading: { ...tree.loading, [path]: true }, error: null },
      },
    }));
    const result = await api.workspace.listDirectory({
      projectPath,
      path,
      sort: useAppStore.getState().prefs.explorer.sort,
    });
    const current = get().trees[projectPath] ?? tree;
    const loading = { ...current.loading };
    delete loading[path];
    const truncated = { ...current.truncated };
    if (result.ok) {
      if (result.value.truncated) truncated[path] = true;
      else delete truncated[path];
    }
    set((state) => ({
      trees: {
        ...state.trees,
        [projectPath]: result.ok
          ? {
              ...current,
              children: { ...current.children, [path]: result.value.entries },
              truncated,
              loading,
              error: null,
            }
          : { ...current, truncated, loading, error: result.error.message },
      },
    }));
  },

  async refresh(projectPath) {
    const tree = get().trees[projectPath];
    if (!tree) return;
    const paths = ["", ...Object.keys(tree.expanded)];
    await Promise.all(paths.map((path) => get().load(projectPath, path, true)));
    const search = get().searches[projectPath];
    if (search && search.query.trim().length > 0) await get().searchNow(projectPath);
  },

  async refreshPath(projectPath, path) {
    await get().load(projectPath, path, true);
  },

  beginMutation(projectPath) {
    set((state) => ({
      busy: { ...state.busy, [projectPath]: true },
      lastError: { ...state.lastError, [projectPath]: null },
    }));
  },

  endMutation(projectPath, error = null) {
    set((state) => {
      const busy = { ...state.busy };
      delete busy[projectPath];
      return {
        busy,
        lastError: { ...state.lastError, [projectPath]: error },
      };
    });
  },

  forgetProject(projectPath) {
    cancelSearchTimer(projectPath);
    set((state) => {
      const trees = { ...state.trees };
      const searches = { ...state.searches };
      const busy = { ...state.busy };
      const lastError = { ...state.lastError };
      delete trees[projectPath];
      delete searches[projectPath];
      delete busy[projectPath];
      delete lastError[projectPath];
      return { trees, searches, busy, lastError };
    });
  },

  applyDelete(projectPath, paths) {
    const tree = get().trees[projectPath];
    if (!tree) return;
    const removed = (key: string): boolean =>
      paths.some((path) => key === path || key.startsWith(`${path}/`));
    const prune = <T>(record: Record<string, T>): Record<string, T> =>
      Object.fromEntries(Object.entries(record).filter(([key]) => !removed(key)));
    set((state) => ({
      trees: {
        ...state.trees,
        [projectPath]: {
          ...tree,
          children: prune(tree.children),
          expanded: prune(tree.expanded),
          loading: prune(tree.loading),
          truncated: prune(tree.truncated),
        },
      },
    }));
  },

  applyRename(projectPath, fromPath, toPath) {
    const tree = get().trees[projectPath];
    if (!tree) return;
    const renameKey = (key: string): string => {
      if (key === fromPath) return toPath;
      if (key.startsWith(`${fromPath}/`)) return `${toPath}${key.slice(fromPath.length)}`;
      return key;
    };
    const remap = <T>(record: Record<string, T>): Record<string, T> =>
      Object.fromEntries(Object.entries(record).map(([key, value]) => [renameKey(key), value]));
    set((state) => ({
      trees: {
        ...state.trees,
        [projectPath]: {
          ...tree,
          children: remap(tree.children),
          expanded: remap(tree.expanded),
          loading: remap(tree.loading),
          truncated: remap(tree.truncated),
        },
      },
    }));
  },

  setFilter(projectPath, query) {
    cancelSearchTimer(projectPath);
    const current = get().searches[projectPath] ?? EMPTY_SEARCH();
    const requestId = current.requestId + 1;
    const empty = query.trim().length === 0;
    set((state) => ({
      searches: {
        ...state.searches,
        [projectPath]: {
          ...current,
          query,
          requestId,
          status: empty ? "idle" : current.status,
          results: empty ? [] : current.results,
          truncated: empty ? false : current.truncated,
          scanned: empty ? 0 : current.scanned,
          error: null,
        },
      },
    }));
    if (empty) return;

    const timer = setTimeout(() => {
      searchTimers.delete(projectPath);
      void get().searchNow(projectPath);
    }, EXPLORER_SEARCH_DEBOUNCE_MS);
    searchTimers.set(projectPath, timer);
  },

  clearFilter(projectPath) {
    get().setFilter(projectPath, "");
  },

  async searchNow(projectPath) {
    cancelSearchTimer(projectPath);
    const current = get().searches[projectPath];
    if (!current) return;
    const query = current.query;
    if (query.trim().length === 0) return;

    const requestId = current.requestId + 1;
    set((state) => ({
      searches: {
        ...state.searches,
        [projectPath]: {
          ...current,
          requestId,
          status: "loading",
          error: null,
        },
      },
    }));

    const api = window.pi;
    if (!api?.workspace?.searchFiles) {
      set((state) => ({
        searches: {
          ...state.searches,
          [projectPath]: {
            ...(state.searches[projectPath] ?? current),
            status: "error",
            error: "The preload bridge is unavailable.",
          },
        },
      }));
      return;
    }

    try {
      const prefs = useAppStore.getState().prefs.explorer;
      const result = await api.workspace.searchFiles({
        projectPath,
        query,
        includeHidden: prefs.showHidden,
        includeIgnored: prefs.showIgnored,
        limit: EXPLORER_SEARCH_LIMIT,
      });
      const latest = get().searches[projectPath];
      if (!latest || latest.requestId !== requestId || latest.query !== query) return;
      if (!result.ok) {
        set((state) => ({
          searches: {
            ...state.searches,
            [projectPath]: {
              ...latest,
              status: "error",
              results: [],
              truncated: false,
              scanned: 0,
              error: result.error.message,
            },
          },
        }));
        return;
      }
      set((state) => ({
        searches: {
          ...state.searches,
          [projectPath]: {
            ...latest,
            status: "ready",
            results: result.value.matches,
            truncated: result.value.truncated,
            scanned: result.value.scanned,
            error: null,
          },
        },
      }));
    } catch (error) {
      const latest = get().searches[projectPath];
      if (!latest || latest.requestId !== requestId || latest.query !== query) return;
      set((state) => ({
        searches: {
          ...state.searches,
          [projectPath]: {
            ...latest,
            status: "error",
            results: [],
            truncated: false,
            scanned: 0,
            error: errorMessage(error),
          },
        },
      }));
    }
  },

  cancelSearch(projectPath) {
    cancelSearchTimer(projectPath);
    const current = get().searches[projectPath];
    if (!current) return;
    set((state) => ({
      searches: {
        ...state.searches,
        [projectPath]: { ...current, requestId: current.requestId + 1 },
      },
    }));
  },
}));
