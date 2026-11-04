import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { useEditorStore } from "../../src/renderer/src/editor/editor-store";
import { useExplorerStore } from "../../src/renderer/src/files/explorer-store";
import { ExplorerSection } from "../../src/renderer/src/rail/ExplorerSection";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { WorkspaceEntry, WorkspaceSearchRequest } from "../../src/shared/workspace";
import { WORKSPACE_PATH_DRAG_MIME, parseWorkspaceDrag } from "../../src/shared/workspace-drag";
import { installBridge } from "./fixtures";

const PROJECT = "C:/work/app";

function entry(
  path: string,
  kind: WorkspaceEntry["kind"] = "file",
  overrides: Partial<WorkspaceEntry> = {},
): WorkspaceEntry {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return {
    name,
    path,
    kind,
    size: kind === "file" ? 12 : null,
    mtimeMs: kind === "file" ? 1 : null,
    hidden: name.startsWith("."),
    ignored: false,
    symlink: false,
    outside: false,
    ...overrides,
  };
}

const ROOT_ENTRIES = [
  entry("src", "directory"),
  entry(".env"),
  entry("dist", "directory", { ignored: true }),
  entry("README.md"),
];

const SRC_ENTRIES = [entry("src/app.ts")];

class FakeTransfer {
  readonly data = new Map<string, string>();
  readonly types: string[] = [];
  effectAllowed = "none";

  setData(type: string, value: string): void {
    this.data.set(type, value);
    if (!this.types.includes(type)) this.types.push(type);
  }

  getData(type: string): string {
    return this.data.get(type) ?? "";
  }
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

let openFileTab: Mock<(projectPath: string, path: string) => Promise<boolean>>;

beforeEach(() => {
  useExplorerStore.getState().cancelSearch(PROJECT);
  installBridge();
  useExplorerStore.setState({ trees: {}, searches: {} });
  useAppStore.setState({
    prefs: {
      ...DEFAULT_PREFS,
      drafts: {},
      explorer: { showHidden: true, showIgnored: true, sort: "name" },
    },
  });

  window.pi.workspace.listDirectory = vi.fn(async ({ path }) => ({
    ok: true as const,
    value: {
      root: PROJECT,
      path,
      entries: path === "" ? ROOT_ENTRIES : path === "src" ? SRC_ENTRIES : [],
      truncated: false,
    },
  }));
  window.pi.workspace.searchFiles = vi.fn(async () => searchResult([]));
  openFileTab = vi.fn(async () => true) as Mock<
    (projectPath: string, path: string) => Promise<boolean>
  >;
  useEditorStore.setState({ openFileTab });
});

async function renderExplorer(): Promise<void> {
  render(<ExplorerSection projectPath={PROJECT} />);
  await screen.findByText("README.md");
}

async function typeSearch(query: string): Promise<HTMLElement> {
  const input = screen.getByTestId("explorer-filter");
  fireEvent.change(input, { target: { value: query } });
  return input;
}

describe("ExplorerSection tree", () => {
  it("renders root entries and marks hidden and ignored rows", async () => {
    await renderExplorer();
    expect(screen.getByText("src")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.getByText(".env").closest("[data-testid='explorer-row']")).toHaveAttribute(
      "data-hidden",
      "true",
    );
    expect(screen.getByText("dist").closest("[data-testid='explorer-row']")).toHaveAttribute(
      "data-ignored",
      "true",
    );
  });

  it("expands a directory lazily and opens a file", async () => {
    await renderExplorer();
    expect(screen.queryByText("app.ts")).toBeNull();

    await userEvent.click(screen.getByText("src"));
    expect(await screen.findByText("app.ts")).toBeInTheDocument();

    await userEvent.click(screen.getByText("app.ts"));
    expect(openFileTab).toHaveBeenCalledWith(PROJECT, "src/app.ts");
  });

  it("shows a truncation footer for a capped root", async () => {
    window.pi.workspace.listDirectory = vi.fn(async () => ({
      ok: true as const,
      value: { root: PROJECT, path: "", entries: ROOT_ENTRIES, truncated: true },
    }));
    await renderExplorer();
    expect(screen.getByText(/Showing the first 2000 entries/)).toBeInTheDocument();
  });
});

describe("ExplorerSection search", () => {
  it("finds a deep file in an unloaded folder and opens it", async () => {
    window.pi.workspace.searchFiles = vi.fn(async () =>
      searchResult(["src/deep/2026-11-01-note.md"]),
    );
    await renderExplorer();

    await typeSearch("2026-11-01");
    const result = await screen.findByTestId("explorer-result");

    expect(window.pi.workspace.searchFiles).toHaveBeenCalledWith({
      projectPath: PROJECT,
      query: "2026-11-01",
      includeHidden: true,
      includeIgnored: true,
      limit: 200,
    });
    expect(screen.queryByText("README.md")).toBeNull();
    expect(result).toHaveAttribute("data-path", "src/deep/2026-11-01-note.md");

    await userEvent.click(result);
    expect(openFileTab).toHaveBeenCalledWith(PROJECT, "src/deep/2026-11-01-note.md");
  });

  it("clears with the x button and restores the tree", async () => {
    await renderExplorer();
    await typeSearch("2026-11-01");
    expect(await screen.findByTestId("explorer-clear")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("explorer-clear"));
    expect(screen.getByTestId("explorer-filter")).toHaveValue("");
    expect(await screen.findByText("README.md")).toBeInTheDocument();
    expect(screen.queryByTestId("explorer-result")).toBeNull();
  });

  it("clears with Escape", async () => {
    await renderExplorer();
    const input = await typeSearch("2026-11-01");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("");
    expect(await screen.findByText("README.md")).toBeInTheDocument();
  });

  it("re-runs the search when the ignored toggle changes", async () => {
    const searchFiles = vi.fn(async (_input: WorkspaceSearchRequest) => searchResult([]));
    window.pi.workspace.searchFiles = searchFiles;
    await renderExplorer();

    await typeSearch("2026-11-01");
    await waitFor(() => expect(searchFiles).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByTestId("explorer-show-ignored"));
    expect(useAppStore.getState().prefs.explorer.showIgnored).toBe(false);
    await waitFor(() => expect(searchFiles).toHaveBeenCalledTimes(2));
    expect(searchFiles.mock.calls[1]?.[0]).toMatchObject({ includeIgnored: false });
  });

  it("shows a searching state while the request is in flight", async () => {
    let resolveSearch: (value: ReturnType<typeof searchResult>) => void = () => undefined;
    window.pi.workspace.searchFiles = vi.fn(
      () =>
        new Promise<ReturnType<typeof searchResult>>((resolve) => {
          resolveSearch = resolve;
        }),
    );
    await renderExplorer();
    await typeSearch("2026-11-01");
    await waitFor(() => expect(window.pi.workspace.searchFiles).toHaveBeenCalled());
    expect(await screen.findByText("Searching…")).toBeInTheDocument();

    resolveSearch(searchResult(["src/2026-11-01.md"]));
    expect(await screen.findByTestId("explorer-result")).toBeInTheDocument();
  });

  it("shows empty, error and truncated states", async () => {
    window.pi.workspace.searchFiles = vi.fn(async () => searchResult([]));
    await renderExplorer();
    await typeSearch("nothing");
    expect(await screen.findByText(/No files match/)).toBeInTheDocument();

    await typeSearch("broken");
    window.pi.workspace.searchFiles = vi.fn(async () => ({
      ok: false as const,
      error: { code: "unavailable" as const, message: "search is offline" },
    }));
    await typeSearch("broken again");
    expect(await screen.findByText("search is offline")).toBeInTheDocument();

    window.pi.workspace.searchFiles = vi.fn(async () => searchResult(["src/a.ts"], true));
    await typeSearch("a");
    expect(await screen.findByTestId("explorer-result")).toBeInTheDocument();
    expect(screen.getByText(/Showing the first 1 matches/)).toBeInTheDocument();
  });
});

describe("ExplorerSection drag source", () => {
  it("writes a typed payload for a tree file", async () => {
    await renderExplorer();
    const row = screen.getByText("README.md").closest("[data-testid='explorer-row']");
    expect(row).not.toBeNull();
    const transfer = new FakeTransfer();

    fireEvent.dragStart(row!, { dataTransfer: transfer });

    expect(parseWorkspaceDrag(transfer.getData(WORKSPACE_PATH_DRAG_MIME))).toEqual({
      version: 1,
      projectPath: PROJECT,
      path: "README.md",
      kind: "file",
    });
    expect(transfer.getData("text/plain")).toBe("README.md");
    expect(transfer.effectAllowed).toBe("copy");
  });

  it("writes a directory payload for a folder", async () => {
    await renderExplorer();
    const row = screen.getByText("src").closest("[data-testid='explorer-row']");
    const transfer = new FakeTransfer();

    fireEvent.dragStart(row!, { dataTransfer: transfer });

    expect(parseWorkspaceDrag(transfer.getData(WORKSPACE_PATH_DRAG_MIME))).toMatchObject({
      path: "src",
      kind: "directory",
    });
  });

  it("does not make an outside symlink draggable", async () => {
    window.pi.workspace.listDirectory = vi.fn(async () => ({
      ok: true as const,
      value: {
        root: PROJECT,
        path: "",
        entries: [entry("link.ts", "file", { outside: true })],
        truncated: false,
      },
    }));
    render(<ExplorerSection projectPath={PROJECT} />);
    const row = (await screen.findByText("link.ts")).closest(
      "[data-testid='explorer-row']",
    ) as HTMLElement;
    expect(row.draggable).toBe(false);
  });

  it("writes the same payload from a search result", async () => {
    window.pi.workspace.searchFiles = vi.fn(async () =>
      searchResult(["src/deep/2026-11-01-note.md"]),
    );
    await renderExplorer();
    await typeSearch("2026-11-01");
    const result = await screen.findByTestId("explorer-result");
    const transfer = new FakeTransfer();

    fireEvent.dragStart(result, { dataTransfer: transfer });

    expect(parseWorkspaceDrag(transfer.getData(WORKSPACE_PATH_DRAG_MIME))).toMatchObject({
      path: "src/deep/2026-11-01-note.md",
      kind: "file",
    });
  });
});
