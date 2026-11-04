import { resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

import {
  WorkspaceTreeError,
  listWorkspaceDirectory,
  type TreeDirectoryEntry,
  type TreeStat,
  type WorkspaceTreeIo,
} from "../../src/workspace/tree";

interface FakeNode {
  kind: "file" | "directory";
  text?: string;
  mtimeMs?: number;
  size?: number;
  symlink?: boolean;
  /** Symlink target, absolute. */
  link?: string;
}

function fakeIo(
  nodes: Record<string, FakeNode>,
  options: { ignored?: Set<string> | null; noCheckIgnore?: boolean } = {},
): WorkspaceTreeIo {
  // The engine uses `node:path` through the realpath guard, so tests must use
  // platform-resolved keys even though the project-relative wire paths are POSIX.
  const normalize = (target: string): string => resolve(target);
  const byKey = new Map(Object.entries(nodes).map(([path, node]) => [normalize(path), node]));
  return {
    async realpath(target) {
      const node = byKey.get(normalize(target));
      if (!node) return null;
      return node.symlink && node.link ? normalize(node.link) : normalize(target);
    },
    async readDirectory(directory): Promise<TreeDirectoryEntry[]> {
      const base = normalize(directory);
      const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
      const entries: TreeDirectoryEntry[] = [];
      for (const [key, node] of byKey) {
        if (!key.startsWith(prefix)) continue;
        const name = key.slice(prefix.length);
        if (name.includes(sep)) continue;
        entries.push({
          name,
          directory: node.kind === "directory",
          symlink: node.symlink === true,
        });
      }
      return entries;
    },
    async stat(target): Promise<TreeStat | null> {
      const node = byKey.get(normalize(target));
      if (!node) return null;
      return {
        kind: node.kind,
        size: node.size ?? node.text?.length ?? 0,
        mtimeMs: node.mtimeMs ?? 0,
        symlink: node.symlink === true,
      };
    },
    async readTextFile(target) {
      return byKey.get(normalize(target))?.text ?? null;
    },
    ...(options.noCheckIgnore
      ? {}
      : {
          async checkIgnored() {
            return options.ignored ?? new Set<string>();
          },
        }),
  };
}

describe("listWorkspaceDirectory", () => {
  it("lists a directory, excludes .git, and flags hidden entries", async () => {
    const io = fakeIo({
      "/project": { kind: "directory" },
      "/project/src": { kind: "directory" },
      "/project/src/app.ts": { kind: "file", size: 12, mtimeMs: 5 },
      "/project/.env": { kind: "file", size: 3 },
      "/project/README.md": { kind: "file", size: 9 },
      "/project/.git": { kind: "directory" },
      "/project/.git/config": { kind: "file" },
    });
    const result = await listWorkspaceDirectory(io, "/project", "");
    expect(result.path).toBe("");
    expect(result.entries.map((entry) => entry.name)).toEqual(["src", ".env", "README.md"]);
    expect(result.entries.find((entry) => entry.name === ".env")?.hidden).toBe(true);
    expect(result.entries.find((entry) => entry.name === "src")?.kind).toBe("directory");
    expect(result.entries.find((entry) => entry.name === "src")?.size).toBeNull();
    expect(result.entries.find((entry) => entry.name === "app.ts")).toBeUndefined();
  });

  it("lists a nested directory with project-relative paths", async () => {
    const io = fakeIo({
      "/project": { kind: "directory" },
      "/project/src": { kind: "directory" },
      "/project/src/lib": { kind: "directory" },
      "/project/src/lib/app.ts": { kind: "file", size: 1, mtimeMs: 2 },
    });
    const result = await listWorkspaceDirectory(io, "/project", "src");
    expect(result.path).toBe("src");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.path).toBe("src/lib");
    expect(result.entries[0]?.kind).toBe("directory");
  });

  it("marks git-ignored entries from the batched checker", async () => {
    const io = fakeIo(
      {
        "/project": { kind: "directory" },
        "/project/dist": { kind: "directory" },
        "/project/dist/app.js": { kind: "file" },
        "/project/src": { kind: "directory" },
        "/project/src/app.ts": { kind: "file" },
      },
      { ignored: new Set(["dist", "dist/app.js"]) },
    );
    const result = await listWorkspaceDirectory(io, "/project", "");
    expect(result.entries.find((entry) => entry.name === "dist")?.ignored).toBe(true);
    expect(result.entries.find((entry) => entry.name === "src")?.ignored).toBe(false);
  });

  it("falls back to .gitignore when git is unavailable", async () => {
    const io = fakeIo(
      {
        "/project": {
          kind: "directory",
          text: "",
        },
        "/project/.gitignore": { kind: "file", text: "dist/\n*.log\n" },
        "/project/dist": { kind: "directory" },
        "/project/keep.log": { kind: "file" },
        "/project/app.ts": { kind: "file" },
      },
      { noCheckIgnore: true },
    );
    const result = await listWorkspaceDirectory(io, "/project", "");
    expect(result.entries.find((entry) => entry.name === "dist")?.ignored).toBe(true);
    expect(result.entries.find((entry) => entry.name === "keep.log")?.ignored).toBe(true);
    expect(result.entries.find((entry) => entry.name === "app.ts")?.ignored).toBe(false);
  });

  it("applies a nested .gitignore inside its directory", async () => {
    const io = fakeIo(
      {
        "/project": { kind: "directory" },
        "/project/src": { kind: "directory", text: "" },
        "/project/src/.gitignore": { kind: "file", text: "generated/\n" },
        "/project/src/generated": { kind: "directory" },
        "/project/src/real.ts": { kind: "file" },
        "/project/other": { kind: "directory" },
        "/project/other/generated": { kind: "directory" },
      },
      { noCheckIgnore: true },
    );
    const result = await listWorkspaceDirectory(io, "/project", "src");
    expect(result.entries.find((entry) => entry.name === "generated")?.ignored).toBe(true);
    expect(result.entries.find((entry) => entry.name === "real.ts")?.ignored).toBe(false);
  });

  it("caps entries and reports truncation", async () => {
    const nodes: Record<string, FakeNode> = { "/project": { kind: "directory" } };
    for (let index = 0; index < 10; index += 1) {
      nodes[`/project/file${index}.ts`] = { kind: "file" };
    }
    const result = await listWorkspaceDirectory(fakeIo(nodes), "/project", "", { limit: 3 });
    expect(result.entries).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("sorts directories first and by the requested order", async () => {
    const io = fakeIo({
      "/project": { kind: "directory" },
      "/project/b.ts": { kind: "file", mtimeMs: 10 },
      "/project/a.ts": { kind: "file", mtimeMs: 20 },
      "/project/dir": { kind: "directory" },
    });
    expect(
      (await listWorkspaceDirectory(io, "/project", "")).entries.map((entry) => entry.name),
    ).toEqual(["dir", "a.ts", "b.ts"]);
    expect(
      (await listWorkspaceDirectory(io, "/project", "", { sort: "modified" })).entries.map(
        (entry) => entry.name,
      ),
    ).toEqual(["dir", "a.ts", "b.ts"]);
  });

  it("marks symlinks and refuses to follow one outside the project", async () => {
    const io = fakeIo({
      "/project": { kind: "directory" },
      "/project/link-out": { kind: "file", symlink: true, link: "/outside/secret" },
      "/project/link-in": { kind: "file", symlink: true, link: "/project/src/app.ts" },
      "/project/src": { kind: "directory" },
      "/project/src/app.ts": { kind: "file" },
      "/outside/secret": { kind: "file" },
    });
    const result = await listWorkspaceDirectory(io, "/project", "");
    const outside = result.entries.find((entry) => entry.name === "link-out");
    const inside = result.entries.find((entry) => entry.name === "link-in");
    expect(outside?.symlink).toBe(true);
    expect(outside?.outside).toBe(true);
    expect(inside?.symlink).toBe(true);
    expect(inside?.outside).toBe(false);
  });

  it("rejects escapes, missing paths, and files", async () => {
    const io = fakeIo({
      "/project": { kind: "directory" },
      "/project/app.ts": { kind: "file" },
      "/outside": { kind: "directory" },
    });
    await expect(listWorkspaceDirectory(io, "/project", "../outside")).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(listWorkspaceDirectory(io, "/project", "/etc")).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(listWorkspaceDirectory(io, "/project", "missing")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(listWorkspaceDirectory(io, "/project", "app.ts")).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(listWorkspaceDirectory(io, "/project", 42)).rejects.toBeInstanceOf(
      WorkspaceTreeError,
    );
  });
});
