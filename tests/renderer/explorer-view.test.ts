import { describe, expect, it } from "vitest";

import type { WorkspaceEntry } from "../../src/shared/workspace";
import {
  flattenExplorerRows,
  isExplorerTreeEmpty,
  type ExplorerTreeView,
} from "../../src/renderer/src/rail/explorer-view";

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
    size: kind === "file" ? 1 : null,
    mtimeMs: kind === "file" ? 1 : null,
    hidden: name.startsWith("."),
    ignored: false,
    symlink: false,
    outside: false,
    ...overrides,
  };
}

function tree(overrides: Partial<ExplorerTreeView> = {}): ExplorerTreeView {
  return {
    children: {
      "": [entry("src", "directory", { hidden: false }), entry(".env"), entry("README.md")],
      src: [entry("src/app.ts"), entry("src/deep", "directory")],
      "src/deep": [entry("src/deep/2026-11-01.md")],
    },
    expanded: { src: true },
    ...overrides,
  };
}

const all = { showHidden: true, showIgnored: true };

describe("flattenExplorerRows", () => {
  it("walks the root and expanded directories with depth", () => {
    expect(
      flattenExplorerRows(tree(), all).map((row) => [row.entry.path, row.depth, row.expanded]),
    ).toEqual([
      ["src", 0, true],
      ["src/app.ts", 1, false],
      ["src/deep", 1, false],
      [".env", 0, false],
      ["README.md", 0, false],
    ]);
  });

  it("includes an expanded directory's children only when it is expanded", () => {
    const collapsed = tree({ expanded: {} });
    expect(flattenExplorerRows(collapsed, all).map((row) => row.entry.path)).toEqual([
      "src",
      ".env",
      "README.md",
    ]);
  });

  it("keeps a directory whose children have not been fetched", () => {
    const missing: ExplorerTreeView = {
      children: { "": [entry("empty", "directory")] },
      expanded: { empty: true },
    };
    expect(flattenExplorerRows(missing, all)).toEqual([
      { entry: expect.objectContaining({ path: "empty" }), depth: 0, expanded: true },
    ]);
  });

  it("filters hidden and ignored entries", () => {
    const view: ExplorerTreeView = {
      children: {
        "": [
          entry(".env"),
          entry("dist", "directory", { ignored: true }),
          entry("src", "directory"),
        ],
        src: [entry("src/app.ts"), entry("src/secret.ts", "file", { ignored: true })],
      },
      expanded: { src: true },
    };
    expect(
      flattenExplorerRows(view, { showHidden: false, showIgnored: true }).map(
        (row) => row.entry.path,
      ),
    ).toEqual(["dist", "src", "src/app.ts", "src/secret.ts"]);
    expect(
      flattenExplorerRows(view, { showHidden: true, showIgnored: false }).map(
        (row) => row.entry.path,
      ),
    ).toEqual([".env", "src", "src/app.ts"]);
  });

  it("does not loop on duplicated paths", () => {
    const view: ExplorerTreeView = {
      children: { "": [entry("src", "directory")], src: [entry("src", "directory")] },
      expanded: { src: true },
    };
    expect(flattenExplorerRows(view, all).map((row) => row.entry.path)).toEqual(["src"]);
  });

  it("handles a missing tree", () => {
    expect(flattenExplorerRows(undefined, all)).toEqual([]);
    expect(flattenExplorerRows(null, all)).toEqual([]);
  });
});

describe("isExplorerTreeEmpty", () => {
  it("only treats a missing root slice as empty", () => {
    expect(isExplorerTreeEmpty(undefined)).toBe(true);
    expect(isExplorerTreeEmpty({ children: {}, expanded: {} })).toBe(true);
    expect(isExplorerTreeEmpty({ children: { "": [entry("a.ts")] }, expanded: {} })).toBe(false);
  });
});
