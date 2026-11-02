import { describe, expect, it } from "vitest";

import type { DirectoryEntry, FileListingIo } from "../../src/workspace/file-listing";
import { rankWorkspaceSearchMatches, searchWorkspaceFiles } from "../../src/workspace/file-search";

/** In-memory tree: keys are relative paths, values are file contents. */
function fakeIo(files: Record<string, string>, gitOutput?: string | null): FileListingIo {
  const directories = new Map<string, Map<string, boolean>>();
  const ensure = (dir: string): Map<string, boolean> => {
    let entry = directories.get(dir);
    if (!entry) {
      entry = new Map();
      directories.set(dir, entry);
    }
    return entry;
  };
  ensure("");
  for (const path of Object.keys(files)) {
    const segments = path.split("/");
    let prefix = "";
    segments.forEach((segment, index) => {
      const isFile = index === segments.length - 1;
      ensure(prefix).set(segment, !isFile);
      prefix = prefix.length === 0 ? segment : `${prefix}/${segment}`;
      if (!isFile) ensure(prefix);
    });
  }

  const relativeOf = (target: string): string =>
    target.replace(/^\/root\/?/, "").replace(/\/+$/, "");

  return {
    async readDirectory(directory: string): Promise<DirectoryEntry[]> {
      const entries = directories.get(relativeOf(directory));
      if (!entries) return [];
      return [...entries.entries()].map(([name, directoryFlag]) => ({
        name,
        directory: directoryFlag,
      }));
    },
    async readTextFile(target: string): Promise<string | null> {
      return files[relativeOf(target)] ?? null;
    },
    ...(gitOutput === undefined ? {} : { runGit: async () => gitOutput }),
  };
}

describe("searchWorkspaceFiles", () => {
  it("finds a deep file without loading its folders", async () => {
    const io = fakeIo({
      "src/deep/nested/2026-11-01-release.md": "",
      "src/app.ts": "",
      "README.md": "",
    });
    const result = await searchWorkspaceFiles(io, "/root", { query: "2026-11-01" });
    expect(result.scanned).toBe(3);
    expect(result.matches).toEqual([
      {
        path: "src/deep/nested/2026-11-01-release.md",
        name: "2026-11-01-release.md",
        directory: "src/deep/nested",
      },
    ]);
    expect(result.truncated).toBe(false);
  });

  it("finds git-ignored plan files only when includeIgnored is on", async () => {
    const io = fakeIo({
      ".gitignore": ".pi/\n",
      ".pi/plans/2026-11-01-note.md": "",
      "src/app.ts": "",
    });

    const tracked = await searchWorkspaceFiles(io, "/root", {
      query: "2026-11-01",
      includeIgnored: false,
    });
    expect(tracked.matches).toEqual([]);

    const all = await searchWorkspaceFiles(io, "/root", {
      query: "2026-11-01",
      includeIgnored: true,
    });
    expect(all.matches.map((match) => match.path)).toEqual([".pi/plans/2026-11-01-note.md"]);
  });

  it("respects includeHidden", async () => {
    const io = fakeIo({
      ".env": "",
      ".github/workflows/2026-11-01.yml": "",
      "src/2026-11-01.ts": "",
    });
    const visible = await searchWorkspaceFiles(io, "/root", {
      query: "2026-11-01",
      includeHidden: false,
    });
    expect(visible.matches.map((match) => match.path)).toEqual(["src/2026-11-01.ts"]);

    const all = await searchWorkspaceFiles(io, "/root", {
      query: "2026-11-01",
      includeHidden: true,
    });
    expect(all.matches.map((match) => match.path)).toEqual([
      "src/2026-11-01.ts",
      ".github/workflows/2026-11-01.yml",
    ]);
  });

  it("matches every whitespace-separated term", async () => {
    const io = fakeIo({
      ".pi/plans/2026-11-01-note.md": "",
      ".pi/plans/other.md": "",
      "src/2026-11-01.ts": "",
    });
    const result = await searchWorkspaceFiles(io, "/root", {
      query: "plans 2026",
      includeIgnored: true,
    });
    expect(result.matches.map((match) => match.path)).toEqual([".pi/plans/2026-11-01-note.md"]);
  });

  it("returns nothing for an empty query without scanning", async () => {
    const ios = fakeIo({ "src/app.ts": "" });
    expect(await searchWorkspaceFiles(ios, "/root", { query: "   " })).toEqual({
      matches: [],
      truncated: false,
      scanned: 0,
    });
  });

  it("caps matches and reports truncation", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 10; index += 1) files[`src/2026-11-01-${index}.ts`] = "";
    const result = await searchWorkspaceFiles(fakeIo(files), "/root", {
      query: "2026-11-01",
      limit: 3,
    });
    expect(result.matches).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("never searches .git or node_modules", async () => {
    const io = fakeIo({
      ".git/config": "",
      "node_modules/dep/2026-11-01.js": "",
      "src/2026-11-01.ts": "",
    });
    const result = await searchWorkspaceFiles(io, "/root", {
      query: "2026-11-01",
      includeIgnored: true,
    });
    expect(result.matches.map((match) => match.path)).toEqual(["src/2026-11-01.ts"]);
  });

  it("works from the git fast path too", async () => {
    const io = fakeIo({}, "src/2026-11-01-git.ts\0src/other.ts\0");
    const result = await searchWorkspaceFiles(io, "/root", { query: "git" });
    expect(result.matches.map((match) => match.path)).toEqual(["src/2026-11-01-git.ts"]);
  });
});

describe("rankWorkspaceSearchMatches", () => {
  const files = [
    "src/renderer/2026-11-01-notes.md",
    "2026-11-01.md",
    "docs/2026-11-01/readme.md",
    "src/2026-11-01.md",
    "unrelated.ts",
  ];

  it("puts an exact basename first, then prefixes, then path matches", () => {
    const result = rankWorkspaceSearchMatches(files, "2026-11-01", 10);
    expect(result.matches.map((match) => match.path)).toEqual([
      "2026-11-01.md",
      "src/2026-11-01.md",
      "src/renderer/2026-11-01-notes.md",
      "docs/2026-11-01/readme.md",
    ]);
    expect(result.total).toBe(4);
  });

  it("is case-insensitive and derives name/directory", () => {
    const result = rankWorkspaceSearchMatches(["SRC/App.TSX"], "app", 10);
    expect(result.matches[0]).toEqual({
      path: "SRC/App.TSX",
      name: "App.TSX",
      directory: "SRC",
    });
  });

  it("limits the list but keeps the total", () => {
    const result = rankWorkspaceSearchMatches(files, "2026", 2);
    expect(result.matches).toHaveLength(2);
    expect(result.total).toBe(4);
  });

  it("returns an empty result for an empty query", () => {
    expect(rankWorkspaceSearchMatches(files, "  ", 10)).toEqual({ matches: [], total: 0 });
  });
});
