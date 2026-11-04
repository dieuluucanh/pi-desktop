import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createNodeWorkspaceFileIo } from "../../src/host/file-io";
import {
  MAX_WORKSPACE_WRITE_BYTES,
  WorkspaceFileError,
  readWorkspaceFile,
  writeWorkspaceFile,
  type WorkspaceFileIo,
} from "../../src/workspace/workspace-files";

/** An in-memory workspace: `files` maps a resolved path to its text. */
function memoryIo(
  cwd: string,
  initial: Record<string, string> = {},
): WorkspaceFileIo & { files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(initial));
  const dirs = new Set<string>([resolve(cwd)]);
  return {
    files,
    async realpath(target) {
      const resolved = resolve(target);
      return files.has(resolved) || dirs.has(resolved) ? resolved : null;
    },
    async statFile(target) {
      const text = files.get(resolve(target));
      return text === undefined ? null : { size: Buffer.byteLength(text, "utf8") };
    },
    async readFile(target, maxBytes) {
      const text = files.get(resolve(target));
      if (text === undefined) return null;
      const buffer = Buffer.from(text, "utf8");
      const truncated = buffer.byteLength > maxBytes;
      return {
        text: truncated ? buffer.subarray(0, maxBytes).toString("utf8") : text,
        truncated,
      };
    },
    async writeFile(target, text) {
      files.set(resolve(target), text);
      dirs.add(resolve(target, ".."));
    },
  };
}

describe("readWorkspaceFile", () => {
  const cwd = resolve("/tmp/workspace");

  it("reads a file inside the session folder", async () => {
    const io = memoryIo(cwd, { [join(cwd, "src", "a.ts")]: "export const a = 1;\n" });
    const result = await readWorkspaceFile(io, cwd, "src/a.ts");
    expect(result.relativePath).toBe("src/a.ts");
    expect(result.text).toBe("export const a = 1;\n");
    expect(result.truncated).toBe(false);
  });

  it("refuses traversal and an absolute path outside the folder", async () => {
    const io = memoryIo(cwd);
    await expect(readWorkspaceFile(io, cwd, "../../etc/passwd")).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(readWorkspaceFile(io, cwd, resolve("/etc/passwd"))).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("refuses a symlink that escapes the folder", async () => {
    const link = join(cwd, "escape.txt");
    const io = memoryIo(cwd, { [link]: "placeholder" });
    // Model the escape: the link resolves to an outside path.
    const escaping: WorkspaceFileIo = {
      ...io,
      async realpath(target) {
        const resolved = resolve(target);
        if (resolved === resolve(link)) return resolve("/etc/passwd");
        if (resolved === resolve(cwd)) return resolve(cwd);
        return null;
      },
      async statFile(target) {
        return resolve(target) === resolve("/etc/passwd") ? { size: 10 } : null;
      },
      async readFile() {
        return { text: "root:x:0:0", truncated: false };
      },
    };
    await expect(readWorkspaceFile(escaping, cwd, "escape.txt")).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("reports a missing file without leaking whether an outside file exists", async () => {
    const io = memoryIo(cwd);
    await expect(readWorkspaceFile(io, cwd, "missing.txt")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("truncates a large file at the requested limit", async () => {
    const target = join(cwd, "big.txt");
    const io = memoryIo(cwd, { [target]: "x".repeat(1000) });
    const result = await readWorkspaceFile(io, cwd, "big.txt", { limit: 10 });
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("x".repeat(10));
  });
});

describe("writeWorkspaceFile", () => {
  const cwd = resolve("/tmp/workspace");

  it("writes a file inside the session folder", async () => {
    const io = memoryIo(cwd);
    const result = await writeWorkspaceFile(io, cwd, "notes/todo.md", "- one\n");
    expect(result.relativePath).toBe("notes/todo.md");
    expect(io.files.get(join(cwd, "notes", "todo.md"))).toBe("- one\n");
  });

  it("refuses traversal, an outside absolute path and non-string text", async () => {
    const io = memoryIo(cwd);
    await expect(writeWorkspaceFile(io, cwd, "../escape.txt", "x")).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      writeWorkspaceFile(io, cwd, resolve("/tmp/outside.txt"), "x"),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(writeWorkspaceFile(io, cwd, "a.txt", 42)).rejects.toMatchObject({
      code: "bad_request",
    });
  });

  it("refuses a payload above the write limit", async () => {
    const io = memoryIo(cwd);
    await expect(
      writeWorkspaceFile(io, cwd, "huge.txt", "x".repeat(MAX_WORKSPACE_WRITE_BYTES + 1)),
    ).rejects.toBeInstanceOf(WorkspaceFileError);
  });
});

describe("workspace files on the real filesystem", () => {
  let base = "";
  let cwd = "";
  let outside = "";

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "pi-desktop-workspace-"));
    cwd = join(base, "project");
    outside = join(base, "outside");
    await mkdir(cwd, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    await writeFile(join(cwd, "readme.md"), "# hi\n", "utf8");
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("round-trips a write and a read through the node adapter", async () => {
    const io = createNodeWorkspaceFileIo();
    const written = await writeWorkspaceFile(io, cwd, "src/new.txt", "hello");
    expect(written.bytes).toBe(5);
    const read = await readWorkspaceFile(io, cwd, "src/new.txt");
    expect(read.text).toBe("hello");
    expect(read.truncated).toBe(false);
  });

  it("refuses a real symlink that points outside the workspace", async () => {
    const io = createNodeWorkspaceFileIo();
    const link = join(cwd, "escape.txt");
    try {
      await symlink(join(outside, "secret.txt"), link, "file");
    } catch {
      return; // Windows without Developer Mode.
    }
    await expect(readWorkspaceFile(io, cwd, "escape.txt")).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(writeWorkspaceFile(io, cwd, "escape.txt", "overwrite")).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("does not follow a symlinked ancestor on a write", async () => {
    const io = createNodeWorkspaceFileIo();
    const linkDir = join(cwd, "linked");
    try {
      await symlink(outside, linkDir, "dir");
    } catch {
      return;
    }
    await expect(writeWorkspaceFile(io, cwd, "linked/new.txt", "x")).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});
