import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  EXPLORER_SEARCH_DEBOUNCE_MS,
  EXPLORER_SEARCH_LIMIT,
  useExplorerStore,
} from "../../src/renderer/src/files/explorer-store";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

const PROJECT = "C:/work/app";

function waitForDebounce(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, EXPLORER_SEARCH_DEBOUNCE_MS + 30));
}

function searchResult(paths: readonly string[], truncated = false) {
  return {
    ok: true as const,
    value: {
      root: PROJECT,
      query: "",
      matches: paths.map((path) => ({
        path,
        name: path.slice(path.lastIndexOf("/") + 1),
        directory: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
      })),
      truncated,
      scanned: paths.length,
    },
  };
}

beforeEach(() => {
  installBridge();
  useExplorerStore.setState({ trees: {}, searches: {} });
  useAppStore.setState({
    prefs: {
      ...DEFAULT_PREFS,
      drafts: {},
      explorer: { showHidden: true, showIgnored: true, sort: "name" },
    },
  });
});

describe("explorer search store", () => {
  it("debounces keystrokes into one request", async () => {
    const searchFiles = vi.fn(async () => searchResult(["src/2026-11-01.md"]));
    window.pi.workspace.searchFiles = searchFiles;

    useExplorerStore.getState().setFilter(PROJECT, "20");
    useExplorerStore.getState().setFilter(PROJECT, "2026");
    useExplorerStore.getState().setFilter(PROJECT, "2026-11-01");

    expect(searchFiles).not.toHaveBeenCalled();
    await waitForDebounce();

    expect(searchFiles).toHaveBeenCalledTimes(1);
    expect(searchFiles).toHaveBeenCalledWith({
      projectPath: PROJECT,
      query: "2026-11-01",
      includeHidden: true,
      includeIgnored: true,
      limit: EXPLORER_SEARCH_LIMIT,
    });
    const search = useExplorerStore.getState().searches[PROJECT];
    expect(search?.status).toBe("ready");
    expect(search?.results.map((match) => match.path)).toEqual(["src/2026-11-01.md"]);
  });

  it("forwards the hidden and ignored preferences", async () => {
    useAppStore.setState({
      prefs: {
        ...useAppStore.getState().prefs,
        explorer: { showHidden: false, showIgnored: true, sort: "name" },
      },
    });
    const searchFiles = vi.fn(async () => searchResult([]));
    window.pi.workspace.searchFiles = searchFiles;

    useExplorerStore.getState().setFilter(PROJECT, "app");
    await waitForDebounce();

    expect(searchFiles).toHaveBeenCalledWith(
      expect.objectContaining({ includeHidden: false, includeIgnored: true }),
    );
  });

  it("ignores a slow response for an older query", async () => {
    let resolveFirst: (value: ReturnType<typeof searchResult>) => void = () => undefined;
    let resolveSecond: (value: ReturnType<typeof searchResult>) => void = () => undefined;
    const first = new Promise<ReturnType<typeof searchResult>>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<ReturnType<typeof searchResult>>((resolve) => {
      resolveSecond = resolve;
    });
    const searchFiles = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second);
    window.pi.workspace.searchFiles = searchFiles;

    useExplorerStore.getState().setFilter(PROJECT, "old");
    await waitForDebounce();
    useExplorerStore.getState().setFilter(PROJECT, "new");
    await waitForDebounce();

    // The newer request resolves first.
    resolveSecond(searchResult(["src/new.md"]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useExplorerStore.getState().searches[PROJECT]?.query).toBe("new");
    expect(useExplorerStore.getState().searches[PROJECT]?.results.map((item) => item.path)).toEqual(
      ["src/new.md"],
    );

    // The stale response must not overwrite it.
    resolveFirst(searchResult(["src/old.md"]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useExplorerStore.getState().searches[PROJECT]?.query).toBe("new");
    expect(useExplorerStore.getState().searches[PROJECT]?.results.map((item) => item.path)).toEqual(
      ["src/new.md"],
    );
  });

  it("clears the query and ignores a pending response", async () => {
    let resolveSearch: (value: ReturnType<typeof searchResult>) => void = () => undefined;
    window.pi.workspace.searchFiles = vi.fn(
      () =>
        new Promise<ReturnType<typeof searchResult>>((resolve) => {
          resolveSearch = resolve;
        }),
    );

    useExplorerStore.getState().setFilter(PROJECT, "2026");
    await waitForDebounce();
    useExplorerStore.getState().clearFilter(PROJECT);

    const cleared = useExplorerStore.getState().searches[PROJECT];
    expect(cleared?.query).toBe("");
    expect(cleared?.status).toBe("idle");
    expect(cleared?.results).toEqual([]);

    resolveSearch(searchResult(["src/2026-11-01.md"]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useExplorerStore.getState().searches[PROJECT]?.results).toEqual([]);
  });

  it("keeps each project's query and results separate", async () => {
    window.pi.workspace.searchFiles = vi.fn(async (input) =>
      searchResult([`${input.projectPath === PROJECT ? "a" : "b"}.md`]),
    );

    useExplorerStore.getState().setFilter(PROJECT, "a");
    useExplorerStore.getState().setFilter("C:/work/other", "b");
    await waitForDebounce();

    expect(useExplorerStore.getState().searches[PROJECT]?.results[0]?.path).toBe("a.md");
    expect(useExplorerStore.getState().searches["C:/work/other"]?.results[0]?.path).toBe("b.md");
  });

  it("stores an error without throwing", async () => {
    window.pi.workspace.searchFiles = vi.fn(async () => ({
      ok: false as const,
      error: { code: "unavailable" as const, message: "search is offline" },
    }));

    useExplorerStore.getState().setFilter(PROJECT, "2026");
    await waitForDebounce();

    const search = useExplorerStore.getState().searches[PROJECT];
    expect(search?.status).toBe("error");
    expect(search?.error).toBe("search is offline");
    expect(search?.results).toEqual([]);
  });

  it("re-runs an active search on refresh", async () => {
    const searchFiles = vi.fn(async () => searchResult([]));
    window.pi.workspace.searchFiles = searchFiles;
    window.pi.workspace.listDirectory = vi.fn(async () => ({
      ok: true as const,
      value: { root: PROJECT, path: "", entries: [], truncated: false },
    }));
    useExplorerStore.setState({
      trees: {
        [PROJECT]: {
          root: PROJECT,
          children: { "": [] },
          expanded: {},
          loading: {},
          truncated: {},
          error: null,
        },
      },
    });

    useExplorerStore.getState().setFilter(PROJECT, "2026");
    await waitForDebounce();
    expect(searchFiles).toHaveBeenCalledTimes(1);

    await useExplorerStore.getState().refresh(PROJECT);
    expect(searchFiles).toHaveBeenCalledTimes(2);
  });

  it("keeps the tree's truncation flag", async () => {
    window.pi.workspace.listDirectory = vi.fn(async () => ({
      ok: true as const,
      value: { root: PROJECT, path: "", entries: [], truncated: true },
    }));

    await useExplorerStore.getState().ensure(PROJECT);
    expect(useExplorerStore.getState().trees[PROJECT]?.truncated[""]).toBe(true);
  });
});

describe("explorer cache invalidation", () => {
  function seedTree() {
    useExplorerStore.setState({
      trees: {
        [PROJECT]: {
          root: PROJECT,
          children: { "": [], src: [], "src/nested": [] },
          expanded: { src: true, "src/nested": true },
          loading: {},
          truncated: { src: true },
          error: null,
        },
      },
      searches: {
        [PROJECT]: {
          query: "app",
          status: "ready",
          results: [],
          truncated: false,
          scanned: 0,
          error: null,
          requestId: 1,
        },
      },
    });
  }

  it("forgets a project's tree and search state", () => {
    seedTree();
    useExplorerStore.getState().forgetProject(PROJECT);
    expect(useExplorerStore.getState().trees[PROJECT]).toBeUndefined();
    expect(useExplorerStore.getState().searches[PROJECT]).toBeUndefined();
  });

  it("removes deleted paths and their descendants", () => {
    seedTree();
    useExplorerStore.getState().applyDelete(PROJECT, ["src"]);
    const tree = useExplorerStore.getState().trees[PROJECT];
    expect(tree?.children.src).toBeUndefined();
    expect(tree?.children["src/nested"]).toBeUndefined();
    expect(tree?.children[""]).toEqual([]);
    expect(tree?.expanded.src).toBeUndefined();
    expect(tree?.truncated.src).toBeUndefined();
  });

  it("remaps a renamed folder's expanded and child keys", () => {
    seedTree();
    useExplorerStore.getState().applyRename(PROJECT, "src", "lib");
    const tree = useExplorerStore.getState().trees[PROJECT];
    expect(tree?.children.lib).toEqual([]);
    expect(tree?.children["lib/nested"]).toEqual([]);
    expect(tree?.expanded.lib).toBe(true);
    expect(tree?.expanded["lib/nested"]).toBe(true);
    expect(tree?.truncated.lib).toBe(true);
  });

  it("forwards the explorer sort preference", async () => {
    const listDirectory = vi.fn(async () => ({
      ok: true as const,
      value: { root: PROJECT, path: "", entries: [], truncated: false },
    }));
    window.pi.workspace.listDirectory = listDirectory;
    useAppStore.setState({
      prefs: {
        ...DEFAULT_PREFS,
        explorer: { showHidden: true, showIgnored: true, sort: "modified" },
      },
    });

    await useExplorerStore.getState().ensure(PROJECT);

    expect(listDirectory).toHaveBeenCalledWith({
      projectPath: PROJECT,
      path: "",
      sort: "modified",
    });
  });
});
