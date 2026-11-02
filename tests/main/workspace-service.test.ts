import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { WorkspaceNodeIo } from "../../src/main/workspace-io";
import { createWorkspaceService } from "../../src/main/workspace-service";
import type { EditorBackup } from "../../src/shared/workspace";

interface FakeNode {
  kind: "file" | "directory";
  text: string;
  mtimeMs: number;
  mode: number;
}

function fakeIo(initial: Record<string, FakeNode> = {}): WorkspaceNodeIo & {
  nodes: Map<string, FakeNode>;
  revealed: string[];
} {
  const normalize = (target: string): string => resolve(target);
  const nodes = new Map(Object.entries(initial).map(([path, node]) => [normalize(path), node]));
  const revealed: string[] = [];

  // Synthesize missing parent directories so walkers can descend.
  for (const path of [...nodes.keys()]) {
    let current = path;
    for (;;) {
      const parent = resolve(current, "..");
      if (parent === current) break;
      if (!nodes.has(parent)) {
        nodes.set(parent, { kind: "directory", text: "", mtimeMs: 1, mode: 0o755 });
      }
      current = parent;
    }
  }

  const children = (directory: string): string[] => {
    const base = normalize(directory);
    const prefix = `${base}\\`;
    return [...nodes.keys()]
      .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("\\"))
      .map((path) => path.slice(prefix.length));
  };

  return {
    nodes,
    revealed,
    async realpath(target) {
      const key = normalize(target);
      const exists =
        nodes.has(key) || [...nodes.keys()].some((path) => path.startsWith(`${key}\\`));
      return exists ? key : null;
    },
    async readDirectory(directory) {
      return children(directory).map((name) => {
        const node = nodes.get(normalize(`${directory}/${name}`));
        return { name, directory: node?.kind === "directory", symlink: false };
      });
    },
    async stat(target) {
      const node = nodes.get(normalize(target));
      if (!node) return null;
      return { kind: node.kind, size: node.text.length, mtimeMs: node.mtimeMs, symlink: false };
    },
    async statFile(target) {
      const node = nodes.get(normalize(target));
      if (!node) return null;
      return { kind: node.kind, size: node.text.length, mtimeMs: node.mtimeMs, mode: node.mode };
    },
    async readBytes(target, maxBytes) {
      const node = nodes.get(normalize(target));
      if (!node || node.kind !== "file") return null;
      const bytes = Buffer.from(node.text, "utf8");
      return { bytes: bytes.subarray(0, maxBytes), truncated: bytes.length > maxBytes };
    },
    async readTextFile(target) {
      return nodes.get(normalize(target))?.text ?? null;
    },
    async writeAtomic(target, text, mode) {
      const key = normalize(target);
      const existing = nodes.get(key);
      nodes.set(key, {
        kind: "file",
        text,
        mtimeMs: (existing?.mtimeMs ?? 0) + 1,
        mode: mode ?? existing?.mode ?? 0o600,
      });
    },
    async remove(target) {
      const key = normalize(target);
      for (const path of [...nodes.keys()]) {
        if (path === key || path.startsWith(`${key}\\`)) nodes.delete(path);
      }
      return true;
    },
    async ensureDir(target) {
      nodes.set(normalize(target), { kind: "directory", text: "", mtimeMs: 1, mode: 0o755 });
    },
    async listDirectoryNames(target) {
      return children(target);
    },
    async runGit() {
      return null;
    },
    async checkIgnored() {
      return new Set<string>();
    },
  };
}

function backup(overrides: Partial<EditorBackup> = {}): EditorBackup {
  return {
    version: 1,
    tabId: "tab-1",
    projectPath: "/project",
    path: "src/app.ts",
    text: "const x = 1;\n",
    updatedAt: 1_000,
    baselineMtimeMs: 1,
    eol: "lf",
    bom: false,
    ...overrides,
  };
}

function service(io: ReturnType<typeof fakeIo>, now = 1_000) {
  return createWorkspaceService({
    io,
    backupsDir: "/backups",
    now: () => now,
    reveal: (absolute) => {
      io.revealed.push(absolute);
      return true;
    },
  });
}

describe("workspace service", () => {
  it("lists directories and maps a missing path to a failure", async () => {
    const io = fakeIo({
      "/project": { kind: "directory", text: "", mtimeMs: 1, mode: 0o755 },
      "/project/src": { kind: "directory", text: "", mtimeMs: 1, mode: 0o755 },
      "/project/src/app.ts": { kind: "file", text: "x", mtimeMs: 1, mode: 0o644 },
    });
    const result = await service(io).listDirectory({ projectPath: "/project", path: "src" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.entries[0]?.path).toBe("src/app.ts");

    const missing = await service(io).listDirectory({ projectPath: "/project", path: "nope" });
    expect(missing).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("lists files for quick open", async () => {
    const io = fakeIo({
      "/project": { kind: "directory", text: "", mtimeMs: 1, mode: 0o755 },
      "/project/src": { kind: "directory", text: "", mtimeMs: 1, mode: 0o755 },
      "/project/src/app.ts": { kind: "file", text: "x", mtimeMs: 1, mode: 0o644 },
      "/project/README.md": { kind: "file", text: "x", mtimeMs: 1, mode: 0o644 },
    });
    const result = await service(io).listFiles({ projectPath: "/project", limit: 10 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.files).toEqual(["README.md", "src/app.ts"]);
  });

  it("searches files across unloaded folders", async () => {
    const io = fakeIo({
      "/project": { kind: "directory", text: "", mtimeMs: 1, mode: 0o755 },
      "/project/src": { kind: "directory", text: "", mtimeMs: 1, mode: 0o755 },
      "/project/src/deep": { kind: "directory", text: "", mtimeMs: 1, mode: 0o755 },
      "/project/src/deep/2026-11-01-note.md": {
        kind: "file",
        text: "x",
        mtimeMs: 1,
        mode: 0o644,
      },
      "/project/other.ts": { kind: "file", text: "x", mtimeMs: 1, mode: 0o644 },
    });
    const result = await service(io).searchFiles({
      projectPath: "/project",
      query: "2026-11-01",
      includeHidden: true,
      includeIgnored: true,
      limit: 10,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        root: "/project",
        query: "2026-11-01",
        matches: [
          {
            path: "src/deep/2026-11-01-note.md",
            name: "2026-11-01-note.md",
            directory: "src/deep",
          },
        ],
        truncated: false,
        scanned: 2,
      },
    });
  });

  it("returns an empty search for an empty query", async () => {
    const io = fakeIo({ "/project": { kind: "directory", text: "", mtimeMs: 1, mode: 0o755 } });
    expect(await service(io).searchFiles({ projectPath: "/project", query: "  " })).toEqual({
      ok: true,
      value: { root: "/project", query: "  ", matches: [], truncated: false, scanned: 0 },
    });
  });

  it("reads, stats and writes files", async () => {
    const io = fakeIo({
      "/project": { kind: "directory", text: "", mtimeMs: 1, mode: 0o755 },
      "/project/a.ts": { kind: "file", text: "old\n", mtimeMs: 5, mode: 0o644 },
    });
    const api = service(io);
    expect(await api.readFile({ projectPath: "/project", path: "a.ts" })).toMatchObject({
      ok: true,
      value: { kind: "text", text: "old\n" },
    });
    expect(await api.stat({ projectPath: "/project", path: "a.ts" })).toMatchObject({
      ok: true,
      value: { mtimeMs: 5 },
    });
    expect(
      await api.writeFile({
        projectPath: "/project",
        path: "a.ts",
        text: "new\n",
        expectedMtimeMs: 5,
      }),
    ).toMatchObject({ ok: true, value: { relativePath: "a.ts" } });
    expect(io.nodes.get(resolve("/project/a.ts"))?.text).toBe("new\n");
  });

  it("returns a conflict with the current stat", async () => {
    const io = fakeIo({
      "/project": { kind: "directory", text: "", mtimeMs: 1, mode: 0o755 },
      "/project/a.ts": { kind: "file", text: "old", mtimeMs: 9, mode: 0o644 },
    });
    expect(
      await service(io).writeFile({
        projectPath: "/project",
        path: "a.ts",
        text: "new",
        expectedMtimeMs: 2,
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict", current: { mtimeMs: 9 } } });
  });

  it("reveals only contained paths", async () => {
    const io = fakeIo({
      "/project": { kind: "directory", text: "", mtimeMs: 1, mode: 0o755 },
      "/project/a.ts": { kind: "file", text: "x", mtimeMs: 1, mode: 0o644 },
    });
    const api = service(io);
    expect(await api.reveal({ projectPath: "/project", path: "a.ts" })).toEqual({
      ok: true,
      value: true,
    });
    expect(io.revealed).toHaveLength(1);
    expect(await api.reveal({ projectPath: "/project", path: "../x" })).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
  });

  it("resolves editorconfig defaults", async () => {
    const io = fakeIo({
      "/project": { kind: "directory", text: "", mtimeMs: 1, mode: 0o755 },
      "/project/a.ts": { kind: "file", text: "x", mtimeMs: 1, mode: 0o644 },
    });
    expect(await service(io).editorConfig({ projectPath: "/project", path: "a.ts" })).toMatchObject(
      {
        ok: true,
        value: { indentSize: 2, endOfLine: "lf" },
      },
    );
  });

  it("writes, reads, deletes and prunes backups", async () => {
    const io = fakeIo();
    const api = service(io, 10_000);
    expect(await api.writeBackup(backup())).toEqual({ ok: true, value: true });
    expect(await api.readBackup("tab-1")).toMatchObject({
      ok: true,
      value: { text: "const x = 1;\n" },
    });
    expect(await api.readBackup("tab-2")).toEqual({ ok: true, value: null });
    expect(await api.readBackup("../x")).toMatchObject({
      ok: false,
      error: { code: "bad_request" },
    });

    expect(await api.deleteBackup("tab-1")).toEqual({ ok: true, value: true });
    expect(await api.readBackup("tab-1")).toEqual({ ok: true, value: null });

    // Old and orphaned backups are pruned; a valid one survives.
    await api.writeBackup(backup({ tabId: "tab-2", updatedAt: 1 }));
    await api.writeBackup(backup({ tabId: "tab-3", updatedAt: 10_000 }));
    const pruned = await api.pruneBackups(["tab-3"]);
    expect(pruned.ok).toBe(true);
    if (pruned.ok) expect(pruned.value).toBe(1);
    expect(await api.readBackup("tab-2")).toEqual({ ok: true, value: null });
    expect(await api.readBackup("tab-3")).toMatchObject({ ok: true, value: { tabId: "tab-3" } });
  });

  it("rejects an oversized backup", async () => {
    const io = fakeIo();
    const api = service(io);
    const huge = backup({ text: "x".repeat(4_100_000) });
    expect(await api.writeBackup(huge)).toMatchObject({ ok: false, error: { code: "too_large" } });
  });
});
