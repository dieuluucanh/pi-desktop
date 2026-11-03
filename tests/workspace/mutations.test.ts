import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  WorkspaceMutationError,
  createWorkspaceEntry,
  deleteWorkspaceEntry,
  renameWorkspaceEntry,
  transferWorkspaceEntries,
  type WorkspaceMutationIo,
} from "../../src/workspace/mutations";
import type { TreeDirectoryEntry, TreeStat } from "../../src/workspace/tree";

interface FakeNode {
  kind: "file" | "directory";
  text: string;
  mtimeMs: number;
  mode: number;
}

interface FakeIo extends WorkspaceMutationIo {
  nodes: Map<string, FakeNode>;
  links: Map<string, string>;
  trashed: string[];
  copied: Array<{ source: string; target: string }>;
}

function key(target: string): string {
  return resolve(target);
}

function fakeIo(): FakeIo {
  const nodes = new Map<string, FakeNode>();
  const links = new Map<string, string>();
  const trashed: string[] = [];
  const copied: Array<{ source: string; target: string }> = [];

  const children = (directory: string): string[] => {
    const base = key(directory);
    const prefix = `${base}\\`;
    return [...nodes.keys(), ...links.keys()]
      .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("\\"))
      .map((path) => path.slice(prefix.length));
  };

  const follow = (target: string): FakeNode | null => {
    let current = key(target);
    for (let depth = 0; depth < 16; depth += 1) {
      const link = links.get(current);
      if (!link) return nodes.get(current) ?? null;
      current = key(link);
    }
    return null;
  };

  const removeTree = (target: string): void => {
    const base = key(target);
    for (const path of [...nodes.keys()]) {
      if (path === base || path.startsWith(`${base}\\`)) nodes.delete(path);
    }
    for (const path of [...links.keys()]) {
      if (path === base || path.startsWith(`${base}\\`)) links.delete(path);
    }
  };

  const copyTree = (source: string, target: string): void => {
    const sourceKey = key(source);
    const targetKey = key(target);
    copied.push({ source: sourceKey, target: targetKey });

    const link = links.get(sourceKey);
    if (link) {
      links.set(targetKey, link);
      return;
    }
    const node = nodes.get(sourceKey);
    if (!node) throw new Error(`missing copy source ${sourceKey}`);
    if (node.kind === "file") {
      nodes.set(targetKey, { ...node });
      return;
    }
    nodes.set(targetKey, { ...node });
    for (const child of children(sourceKey)) {
      copyTree(`${sourceKey}/${child}`, `${targetKey}/${child}`);
    }
  };

  const io: FakeIo = {
    nodes,
    links,
    trashed,
    copied,
    async realpath(target) {
      const current = key(target);
      const link = links.get(current);
      if (link) return key(link);
      return nodes.has(current) ? current : null;
    },
    async readDirectory(directory): Promise<TreeDirectoryEntry[]> {
      return children(directory).map((name) => {
        const absolute = key(`${key(directory)}/${name}`);
        return {
          name,
          directory: follow(absolute)?.kind === "directory",
          symlink: links.has(absolute),
        };
      });
    },
    async stat(target): Promise<TreeStat | null> {
      const current = key(target);
      const symlink = links.has(current);
      const node = follow(current);
      if (!node) return null;
      return {
        kind: node.kind,
        size: node.kind === "file" ? Buffer.byteLength(node.text, "utf8") : 0,
        mtimeMs: node.mtimeMs,
        symlink,
      };
    },
    async statFile(target) {
      const node = follow(target);
      if (!node) return null;
      return {
        kind: node.kind,
        size: Buffer.byteLength(node.text, "utf8"),
        mtimeMs: node.mtimeMs,
        mode: node.mode,
      };
    },
    async readBytes(target, maxBytes) {
      const node = follow(target);
      if (!node || node.kind !== "file") return null;
      const bytes = Buffer.from(node.text, "utf8");
      return { bytes: bytes.subarray(0, maxBytes), truncated: bytes.byteLength > maxBytes };
    },
    async readTextFile(target) {
      const node = follow(target);
      return node?.kind === "file" ? node.text : null;
    },
    async writeAtomic(target, text, mode) {
      const current = key(target);
      nodes.set(current, {
        kind: "file",
        text,
        mtimeMs: (nodes.get(current)?.mtimeMs ?? 0) + 1,
        mode: mode ?? nodes.get(current)?.mode ?? 0o644,
      });
    },
    async ensureDir(target) {
      let current = key(target);
      const missing: string[] = [];
      while (!nodes.has(current)) {
        missing.push(current);
        const parent = resolve(current, "..");
        if (parent === current) break;
        current = parent;
      }
      for (const path of missing.reverse()) {
        nodes.set(path, { kind: "directory", text: "", mtimeMs: 1, mode: 0o755 });
      }
    },
    async mkdir(target) {
      const current = key(target);
      if (nodes.has(current) || links.has(current)) {
        const error = new Error("exists");
        (error as { code?: string }).code = "EEXIST";
        throw error;
      }
      nodes.set(current, { kind: "directory", text: "", mtimeMs: 1, mode: 0o755 });
    },
    async rename(source, target) {
      const sourceKey = key(source);
      const targetKey = key(target);
      if (nodes.has(targetKey) || links.has(targetKey)) throw new Error("exists");
      const prefix = `${sourceKey}\\`;
      for (const path of [...nodes.keys()]) {
        if (path !== sourceKey && !path.startsWith(prefix)) continue;
        const suffix = path.slice(sourceKey.length);
        const node = nodes.get(path);
        if (!node) continue;
        nodes.delete(path);
        nodes.set(`${targetKey}${suffix}`, node);
      }
      for (const path of [...links.keys()]) {
        if (path !== sourceKey && !path.startsWith(prefix)) continue;
        const suffix = path.slice(sourceKey.length);
        const link = links.get(path);
        if (!link) continue;
        links.delete(path);
        links.set(`${targetKey}${suffix}`, link);
      }
    },
    async copy(source, target) {
      if (nodes.has(key(target)) || links.has(key(target))) throw new Error("exists");
      copyTree(source, target);
    },
    async trash(target) {
      const current = key(target);
      if (!nodes.has(current) && !links.has(current)) return false;
      trashed.push(current);
      removeTree(current);
      return true;
    },
    async remove(target) {
      removeTree(target);
      return true;
    },
  };

  nodes.set(resolve("/project"), { kind: "directory", text: "", mtimeMs: 1, mode: 0o755 });
  nodes.set(resolve("/target"), { kind: "directory", text: "", mtimeMs: 1, mode: 0o755 });
  nodes.set(resolve("/outside"), { kind: "directory", text: "", mtimeMs: 1, mode: 0o755 });
  return io;
}

function file(io: FakeIo, path: string, text = "x"): void {
  io.nodes.set(key(path), { kind: "file", text, mtimeMs: 1, mode: 0o644 });
}

function dir(io: FakeIo, path: string): void {
  io.nodes.set(key(path), { kind: "directory", text: "", mtimeMs: 1, mode: 0o755 });
}

function relative(path: string): string {
  return path.slice(1).replace(/\\/g, "/");
}

describe("createWorkspaceEntry", () => {
  it("creates a file and a directory without overwriting", async () => {
    const io = fakeIo();
    dir(io, "/project/src");

    const created = await createWorkspaceEntry(io, resolve("/project"), {
      path: "src/app.ts",
      kind: "file",
    });
    expect(created.kind).toBe("file");
    expect(io.nodes.has(key("/project/src/app.ts"))).toBe(true);

    const folder = await createWorkspaceEntry(io, resolve("/project"), {
      path: "src/components",
      kind: "directory",
    });
    expect(folder.kind).toBe("directory");

    await expect(
      createWorkspaceEntry(io, resolve("/project"), { path: "src/app.ts", kind: "file" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      createWorkspaceEntry(io, resolve("/project"), { path: "src/components", kind: "directory" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects traversal, reserved names and a missing parent", async () => {
    const io = fakeIo();
    for (const path of ["../x", ".git/config", "src/CON.txt"]) {
      await expect(
        createWorkspaceEntry(io, resolve("/project"), { path, kind: "file" }),
      ).rejects.toBeInstanceOf(WorkspaceMutationError);
    }
    await expect(
      createWorkspaceEntry(io, resolve("/project"), { path: "missing/a.ts", kind: "file" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("renameWorkspaceEntry", () => {
  it("renames files and directories in place", async () => {
    const io = fakeIo();
    file(io, "/project/a.ts");
    dir(io, "/project/src");
    file(io, "/project/src/b.ts");

    const renamed = await renameWorkspaceEntry(io, resolve("/project"), {
      path: "a.ts",
      toPath: "renamed.ts",
    });
    expect(renamed.path).toBe("renamed.ts");
    expect(io.nodes.has(key("/project/renamed.ts"))).toBe(true);

    await renameWorkspaceEntry(io, resolve("/project"), {
      path: "src",
      toPath: "source",
    });
    expect(io.nodes.has(key("/project/source/b.ts"))).toBe(true);
  });

  it("refuses a collision, a parent change and a missing source", async () => {
    const io = fakeIo();
    file(io, "/project/a.ts");
    file(io, "/project/b.ts");

    await expect(
      renameWorkspaceEntry(io, resolve("/project"), { path: "a.ts", toPath: "b.ts" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      renameWorkspaceEntry(io, resolve("/project"), { path: "a.ts", toPath: "src/a.ts" }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      renameWorkspaceEntry(io, resolve("/project"), { path: "missing.ts", toPath: "x.ts" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("deleteWorkspaceEntry", () => {
  it("trashes files, directories and outside-pointing links", async () => {
    const io = fakeIo();
    file(io, "/project/a.ts");
    dir(io, "/project/src");
    file(io, "/project/src/b.ts");
    file(io, "/outside/secret.ts");
    io.links.set(key("/project/link.ts"), key("/outside/secret.ts"));

    await deleteWorkspaceEntry(io, resolve("/project"), { path: "a.ts" });
    await deleteWorkspaceEntry(io, resolve("/project"), { path: "src" });
    await deleteWorkspaceEntry(io, resolve("/project"), { path: "link.ts" });

    expect(io.trashed).toEqual([
      key("/project/a.ts"),
      key("/project/src"),
      key("/project/link.ts"),
    ]);
    // Deleting the link never deletes its target.
    expect(io.nodes.has(key("/outside/secret.ts"))).toBe(true);
  });

  it("refuses .git and reports an unavailable trash", async () => {
    const io = fakeIo();
    file(io, "/project/.git/config");
    await expect(
      deleteWorkspaceEntry(io, resolve("/project"), { path: ".git/config" }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const broken = fakeIo();
    file(broken, "/project/a.ts");
    broken.trash = async () => false;
    await expect(
      deleteWorkspaceEntry(broken, resolve("/project"), { path: "a.ts" }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("transferWorkspaceEntries", () => {
  it("copies a file and a directory into another project", async () => {
    const io = fakeIo();
    file(io, "/project/a.ts", "a");
    dir(io, "/project/src");
    dir(io, "/project/src/nested");
    file(io, "/project/src/nested/b.ts", "b");

    const result = await transferWorkspaceEntries(io, {
      sourceProjectPath: resolve("/project"),
      targetProjectPath: resolve("/target"),
      sources: ["a.ts", "src"],
      targetDirectory: "",
      operation: "copy",
    });

    expect(result.transferred.map((item) => item.targetPath)).toEqual(["a.ts", "src"]);
    expect(io.nodes.has(key("/target/a.ts"))).toBe(true);
    expect(io.nodes.has(key("/target/src/nested/b.ts"))).toBe(true);
    expect(io.nodes.has(key("/project/a.ts"))).toBe(true);
  });

  it("moves by rename and crosses projects", async () => {
    const io = fakeIo();
    file(io, "/project/a.ts", "a");
    dir(io, "/target/sub");

    const result = await transferWorkspaceEntries(io, {
      sourceProjectPath: resolve("/project"),
      targetProjectPath: resolve("/target"),
      sources: ["a.ts"],
      targetDirectory: "sub",
      operation: "move",
    });

    expect(result.transferred).toEqual([
      { sourcePath: "a.ts", targetPath: "sub/a.ts", kind: "file" },
    ]);
    expect(io.nodes.has(key("/project/a.ts"))).toBe(false);
    expect(io.nodes.has(key("/target/sub/a.ts"))).toBe(true);
  });

  it("refuses collisions, folder-into-itself and outside links", async () => {
    const io = fakeIo();
    file(io, "/project/a.ts", "a");
    file(io, "/target/a.ts", "existing");
    dir(io, "/project/src");
    dir(io, "/project/src/inside");
    file(io, "/outside/secret.ts");
    io.links.set(key("/project/out.ts"), key("/outside/secret.ts"));

    await expect(
      transferWorkspaceEntries(io, {
        sourceProjectPath: resolve("/project"),
        targetProjectPath: resolve("/target"),
        sources: ["a.ts"],
        targetDirectory: "",
        operation: "copy",
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    await expect(
      transferWorkspaceEntries(io, {
        sourceProjectPath: resolve("/project"),
        targetProjectPath: resolve("/project"),
        sources: ["src"],
        targetDirectory: "src/inside",
        operation: "copy",
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    await expect(
      transferWorkspaceEntries(io, {
        sourceProjectPath: resolve("/project"),
        targetProjectPath: resolve("/target"),
        sources: ["out.ts"],
        targetDirectory: "",
        operation: "copy",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("cleans a staged copy when the copy fails", async () => {
    const io = fakeIo();
    file(io, "/project/a.ts", "a");
    io.copy = async () => {
      throw new Error("disk full");
    };

    await expect(
      transferWorkspaceEntries(io, {
        sourceProjectPath: resolve("/project"),
        targetProjectPath: resolve("/target"),
        sources: ["a.ts"],
        targetDirectory: "",
        operation: "copy",
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect([...io.nodes.keys()].some((path) => path.includes(".pi-transfer-"))).toBe(false);
  });
});

void relative;
