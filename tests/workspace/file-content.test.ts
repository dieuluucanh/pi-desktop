import { resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FileContentError,
  applyEol,
  detectEol,
  normalizeEol,
  readWorkspaceContent,
  statWorkspaceFile,
  writeWorkspaceContent,
  type FileContentIo,
} from "../../src/workspace/file-content";
import { MAX_EDITOR_READ_BYTES, MAX_EDITOR_WRITE_BYTES } from "../../src/shared/workspace";

interface FakeFile {
  kind: "file" | "directory";
  bytes: Uint8Array;
  mtimeMs: number;
  mode: number;
}

function fakeIo(
  files: Record<string, FakeFile>,
): FileContentIo & { files: Map<string, FakeFile>; writes: { mode?: number }[] } {
  const normalize = (target: string): string => resolve(target);
  const byKey = new Map(Object.entries(files).map(([path, file]) => [normalize(path), file]));
  const writes: { mode?: number }[] = [];
  return {
    files: byKey,
    writes,
    async realpath(target) {
      const key = normalize(target);
      const exists =
        byKey.has(key) ||
        [...byKey.keys()].some((candidate) => candidate.startsWith(`${key}${sep}`));
      return exists ? key : null;
    },
    async statFile(target) {
      const file = byKey.get(normalize(target));
      if (!file) return null;
      return {
        kind: file.kind,
        size: file.bytes.byteLength,
        mtimeMs: file.mtimeMs,
        mode: file.mode,
      };
    },
    async readBytes(target, maxBytes) {
      const file = byKey.get(normalize(target));
      if (!file) return null;
      const slice = file.bytes.subarray(0, maxBytes);
      return { bytes: slice, truncated: file.bytes.byteLength > maxBytes };
    },
    async writeAtomic(target, text, mode) {
      const key = normalize(target);
      writes.push(mode === undefined ? {} : { mode });
      const previous = byKey.get(key);
      byKey.set(key, {
        kind: "file",
        bytes: Buffer.from(text, "utf8"),
        mtimeMs: (previous?.mtimeMs ?? 0) + 1,
        mode: mode ?? previous?.mode ?? 0o600,
      });
    },
  };
}

function file(text: string, overrides: Partial<FakeFile> = {}): FakeFile {
  return {
    kind: "file",
    bytes: Buffer.from(text, "utf8"),
    mtimeMs: 1,
    mode: 0o644,
    ...overrides,
  };
}

describe("EOL helpers", () => {
  it("detects CRLF, LF and empty files", () => {
    expect(detectEol("a\nb\n")).toBe("lf");
    expect(detectEol("a\r\nb\r\n")).toBe("crlf");
    expect(detectEol("a\r\nb\nc\n")).toBe("lf");
    expect(detectEol("no newline")).toBe("lf");
  });

  it("normalizes and reapplies EOL", () => {
    expect(normalizeEol("a\r\nb\rc\n")).toBe("a\nb\nc\n");
    expect(applyEol("a\nb", "crlf")).toBe("a\r\nb");
    expect(applyEol("a\r\nb", "lf")).toBe("a\nb");
  });
});

describe("readWorkspaceContent", () => {
  it("reads UTF-8 text and reports metadata", async () => {
    const io = fakeIo({ "/project/src/app.ts": file("const x = 1;\n") });
    const result = await readWorkspaceContent(io, "/project", "src/app.ts");
    expect(result.kind).toBe("text");
    expect(result.text).toBe("const x = 1;\n");
    expect(result.relativePath).toBe("src/app.ts");
    expect(result.eol).toBe("lf");
    expect(result.bom).toBe(false);
    expect(result.encoding).toBe("utf8");
    expect(result.size).toBe(13);
    expect(result.truncated).toBe(false);
  });

  it("detects CRLF and strips a UTF-8 BOM", async () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\r\nb\r\n")]);
    const io = fakeIo({
      "/project/a.txt": { kind: "file", bytes: withBom, mtimeMs: 1, mode: 0o644 },
    });
    const result = await readWorkspaceContent(io, "/project", "a.txt");
    expect(result.text).toBe("a\r\nb\r\n");
    expect(result.eol).toBe("crlf");
    expect(result.bom).toBe(true);
    expect(result.encoding).toBe("utf8");
  });

  it("recognises NUL bytes and invalid UTF-8 as binary", async () => {
    const nul = fakeIo({
      "/project/a.bin": { kind: "file", bytes: Buffer.from([1, 0, 2]), mtimeMs: 1, mode: 0o644 },
    });
    expect((await readWorkspaceContent(nul, "/project", "a.bin")).kind).toBe("binary");

    const invalid = fakeIo({
      "/project/b.bin": {
        kind: "file",
        bytes: Buffer.from([0x61, 0xff, 0x62]),
        mtimeMs: 1,
        mode: 0o644,
      },
    });
    expect((await readWorkspaceContent(invalid, "/project", "b.bin")).kind).toBe("binary");
  });

  it("recognises UTF-16 BOMs as unsupported", async () => {
    const le = fakeIo({
      "/project/a.txt": {
        kind: "file",
        bytes: Buffer.from([0xff, 0xfe, 0x61, 0x00]),
        mtimeMs: 1,
        mode: 0o644,
      },
    });
    const result = await readWorkspaceContent(le, "/project", "a.txt");
    expect(result.kind).toBe("unsupported_encoding");
    expect(result.encoding).toBe("utf16le");
    expect(result.text).toBeNull();

    const be = fakeIo({
      "/project/b.txt": {
        kind: "file",
        bytes: Buffer.from([0xfe, 0xff, 0x00, 0x61]),
        mtimeMs: 1,
        mode: 0o644,
      },
    });
    const bigEndian = await readWorkspaceContent(be, "/project", "b.txt");
    expect(bigEndian.kind).toBe("unsupported_encoding");
    expect(bigEndian.encoding).toBe("utf16be");
  });

  it("refuses files over the read cap without reading them", async () => {
    const io = fakeIo({
      "/project/huge.log": {
        kind: "file",
        bytes: new Uint8Array(0),
        mtimeMs: 1,
        mode: 0o644,
      },
    });
    // The fake's stat uses the byte array length, so override it for this case.
    io.statFile = async () => ({
      kind: "file",
      size: MAX_EDITOR_READ_BYTES + 1,
      mtimeMs: 1,
      mode: 0o644,
    });
    const result = await readWorkspaceContent(io, "/project", "huge.log");
    expect(result.kind).toBe("too_large");
    expect(result.text).toBeNull();
    expect(result.size).toBe(MAX_EDITOR_READ_BYTES + 1);
  });

  it("rejects missing files, directories, escapes and .git", async () => {
    const io = fakeIo({
      "/project": { kind: "directory", bytes: new Uint8Array(), mtimeMs: 1, mode: 0o755 },
      "/project/dir": { kind: "directory", bytes: new Uint8Array(), mtimeMs: 1, mode: 0o755 },
      "/project/.git/config": file("x"),
    });
    await expect(readWorkspaceContent(io, "/project", "missing.ts")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(readWorkspaceContent(io, "/project", "dir")).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(readWorkspaceContent(io, "/project", "../x")).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(readWorkspaceContent(io, "/project", ".git/config")).rejects.toBeInstanceOf(
      FileContentError,
    );
  });
});

describe("statWorkspaceFile", () => {
  it("returns kind, size and mtime", async () => {
    const io = fakeIo({ "/project/src/app.ts": file("abc", { mtimeMs: 42 }) });
    await expect(statWorkspaceFile(io, "/project", "src/app.ts")).resolves.toMatchObject({
      kind: "file",
      size: 3,
      mtimeMs: 42,
      relativePath: "src/app.ts",
    });
  });
});

describe("writeWorkspaceContent", () => {
  it("creates a file with mode 0644 and returns the new stat", async () => {
    const io = fakeIo({
      "/project": { kind: "directory", bytes: new Uint8Array(), mtimeMs: 1, mode: 0o755 },
    });
    const result = await writeWorkspaceContent(io, "/project", {
      path: "new.ts",
      text: "const x = 1;\n",
      expectedMtimeMs: null,
    });
    expect(io.writes).toEqual([{ mode: 0o644 }]);
    expect(result.relativePath).toBe("new.ts");
    expect(Buffer.from(io.files.get(resolve("/project/new.ts"))!.bytes).toString("utf8")).toBe(
      "const x = 1;\n",
    );
  });

  it("preserves the existing mode and applies CRLF + BOM", async () => {
    const io = fakeIo({ "/project/a.ts": file("old", { mode: 0o640 }) });
    await writeWorkspaceContent(io, "/project", {
      path: "a.ts",
      text: "a\nb",
      eol: "crlf",
      bom: true,
      expectedMtimeMs: 1,
    });
    expect(io.writes).toEqual([{ mode: 0o640 }]);
    const written = Buffer.from(io.files.get(resolve("/project/a.ts"))!.bytes);
    expect(written[0]).toBe(0xef);
    expect(written.subarray(3).toString("utf8")).toBe("a\r\nb");
  });

  it("refuses a stale expected mtime and an unexpected existing file", async () => {
    const io = fakeIo({ "/project/a.ts": file("a", { mtimeMs: 10 }) });
    await expect(
      writeWorkspaceContent(io, "/project", { path: "a.ts", text: "b", expectedMtimeMs: 5 }),
    ).rejects.toMatchObject({ code: "conflict", current: { mtimeMs: 10 } });
    await expect(
      writeWorkspaceContent(io, "/project", { path: "a.ts", text: "b", expectedMtimeMs: null }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("allows force and reports a vanished file as a conflict", async () => {
    const io = fakeIo({ "/project/a.ts": file("a", { mtimeMs: 10 }) });
    await expect(
      writeWorkspaceContent(io, "/project", {
        path: "a.ts",
        text: "b",
        expectedMtimeMs: 5,
        force: true,
      }),
    ).resolves.toMatchObject({ relativePath: "a.ts" });

    await expect(
      writeWorkspaceContent(io, "/project", { path: "gone.ts", text: "b", expectedMtimeMs: 3 }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses oversized writes, .git and non-files", async () => {
    const io = fakeIo({
      "/project/dir": { kind: "directory", bytes: new Uint8Array(), mtimeMs: 1, mode: 0o755 },
    });
    await expect(
      writeWorkspaceContent(io, "/project", {
        path: "huge.ts",
        text: "x".repeat(MAX_EDITOR_WRITE_BYTES + 1),
        expectedMtimeMs: null,
      }),
    ).rejects.toMatchObject({ code: "too_large" });
    await expect(
      writeWorkspaceContent(io, "/project", {
        path: ".git/config",
        text: "x",
        expectedMtimeMs: null,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      writeWorkspaceContent(io, "/project", { path: "dir", text: "x", expectedMtimeMs: 1 }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });
});
