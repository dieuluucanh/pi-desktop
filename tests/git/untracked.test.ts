import { resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { DiffParseError } from "../../src/git/diff";
import { readUntrackedSource, untrackedDiff } from "../../src/git/untracked";
import { MAX_DIFF_BYTES } from "../../src/shared/git";
import type { FileContentIo } from "../../src/workspace/file-content";

/**
 * The synthetic untracked diff (untracked-changes plan step 4).
 *
 * `readUntrackedSource` is a thin adapter over the editor's
 * `readWorkspaceContent`, so these tests pin the mapping (missing / forbidden /
 * binary / too-large / text) rather than re-testing the containment guard. The
 * builder tests pin the viewer's conventions: an unnumbered hunk header, the
 * `\ No newline` marker, and no patch paths on a synthesised file.
 */

const ROOT = "/repo";

interface FakeIo extends FileContentIo {
  reads: string[];
}

function fakeIo(
  files: Record<string, string | Uint8Array>,
  options: { escape?: string } = {},
): FakeIo {
  const byKey = new Map(
    Object.entries(files).map(([path, value]) => [
      resolve(path),
      typeof value === "string" ? new TextEncoder().encode(value) : value,
    ]),
  );
  const exists = (key: string): boolean =>
    byKey.has(key) || [...byKey.keys()].some((candidate) => candidate.startsWith(`${key}${sep}`));
  const reads: string[] = [];
  return {
    reads,
    async realpath(target) {
      const key = resolve(target);
      if (options.escape !== undefined && key === resolve(options.escape)) {
        return resolve("/outside", "secret.ts");
      }
      return exists(key) ? key : null;
    },
    async statFile(target) {
      const bytes = byKey.get(resolve(target));
      if (!bytes) return null;
      return { kind: "file", size: bytes.byteLength, mtimeMs: 0, mode: 0o644 };
    },
    async readBytes(target, maxBytes) {
      const key = resolve(target);
      reads.push(key);
      const bytes = byKey.get(key);
      if (!bytes) return null;
      return { bytes: bytes.subarray(0, maxBytes), truncated: bytes.byteLength > maxBytes };
    },
    async writeAtomic() {
      // The reader never writes.
    },
  };
}

describe("readUntrackedSource", () => {
  it("returns the file's text through the editor reader", async () => {
    const io = fakeIo({ [`${ROOT}/feature/new/deep.ts`]: "export const deep = 1;\n" });

    expect(await readUntrackedSource(io, ROOT, "feature/new/deep.ts")).toEqual({
      ok: true,
      text: "export const deep = 1;\n",
    });
    // The read went through the realpath containment guard, not a bare join.
    expect(io.reads).toHaveLength(1);
  });

  it("preserves a missing trailing newline", async () => {
    const io = fakeIo({ [`${ROOT}/new.ts`]: "no newline" });
    expect(await readUntrackedSource(io, ROOT, "new.ts")).toEqual({
      ok: true,
      text: "no newline",
    });
  });

  it("reports a NUL byte and a UTF-16 BOM as binary", async () => {
    const nul = fakeIo({ [`${ROOT}/bin.dat`]: new Uint8Array([0x61, 0x00, 0x62]) });
    expect(await readUntrackedSource(nul, ROOT, "bin.dat")).toEqual({
      ok: false,
      reason: "binary",
    });

    const utf16 = fakeIo({ [`${ROOT}/utf16.txt`]: new Uint8Array([0xff, 0xfe, 0x61, 0x00]) });
    expect(await readUntrackedSource(utf16, ROOT, "utf16.txt")).toEqual({
      ok: false,
      reason: "binary",
    });
  });

  it("reports a file over MAX_DIFF_BYTES as too_large", async () => {
    const big = new Uint8Array(MAX_DIFF_BYTES + 1).fill(0x61);
    const io = fakeIo({ [`${ROOT}/big.txt`]: big });
    expect(await readUntrackedSource(io, ROOT, "big.txt")).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it("reports a vanished file as missing", async () => {
    // The root has to exist (a sibling file is enough), or the containment
    // guard cannot tell "no such file" from "outside the project".
    const io = fakeIo({ [`${ROOT}/README.md`]: "# repo\n" });
    expect(await readUntrackedSource(io, ROOT, "gone.ts")).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("reports a symlink escape as forbidden", async () => {
    const io = fakeIo({ [`${ROOT}/escape.ts`]: "secret\n" }, { escape: `${ROOT}/escape.ts` });
    expect(await readUntrackedSource(io, ROOT, "escape.ts")).toEqual({
      ok: false,
      reason: "forbidden",
    });
  });
});

describe("untrackedDiff", () => {
  it("renders every line as an addition with an unnumbered header", () => {
    const diff = untrackedDiff("feature/new/deep.ts", {
      ok: true,
      text: "export const deep = 1;\nexport const second = 2;\n",
    });

    expect(diff.scope).toBe("working");
    expect(diff.tooLarge).toBe(false);
    expect(diff.files).toHaveLength(1);

    const file = diff.files[0];
    expect(file?.status).toBe("untracked");
    expect(file?.binary).toBe(false);
    expect(file?.added).toBe(2);
    expect(file?.removed).toBe(0);
    expect(file?.hunks[0]?.header).toBe("-0,0 +1,2");
    expect(file?.hunks[0]?.lines).toEqual([
      { kind: "add", oldLine: null, newLine: 1, text: "export const deep = 1;" },
      { kind: "add", oldLine: null, newLine: 2, text: "export const second = 2;" },
    ]);
    // A synthesised file carries no patch paths (no hunk staging is offered).
    expect(file?.patchOldPath).toBeUndefined();
    expect(file?.patchNewPath).toBeUndefined();
  });

  it("keeps the no-newline marker unnumbered and out of the added count", () => {
    const file = untrackedDiff("a.ts", { ok: true, text: "const a = 1;" }).files[0];

    expect(file?.added).toBe(1);
    expect(file?.hunks[0]?.header).toBe("-0,0 +1,1");
    expect(file?.hunks[0]?.lines.at(-1)).toEqual({
      kind: "context",
      oldLine: null,
      newLine: null,
      text: "\\ No newline at end of file",
    });
  });

  it("does not normalise CRLF", () => {
    const file = untrackedDiff("a.ts", { ok: true, text: "a\r\nb\r\n" }).files[0];
    expect(file?.added).toBe(2);
    expect(file?.hunks[0]?.lines.map((line) => line.text)).toEqual(["a\r", "b\r"]);
  });

  it("returns an empty file section for an empty file", () => {
    const file = untrackedDiff("empty.ts", { ok: true, text: "" }).files[0];
    expect(file?.hunks).toEqual([]);
    expect(file?.added).toBe(0);
  });

  it("describes a binary file without hunks", () => {
    const diff = untrackedDiff("image.png", { ok: false, reason: "binary" });
    expect(diff.tooLarge).toBe(false);
    expect(diff.files[0]).toMatchObject({
      path: "image.png",
      status: "untracked",
      binary: true,
      added: 0,
      removed: 0,
      hunks: [],
    });
  });

  it("reports an oversized diff without reading it", () => {
    const diff = untrackedDiff("big.txt", { ok: false, reason: "too_large" });
    expect(diff).toEqual({
      scope: "working",
      files: [],
      tooLarge: true,
      truncated: false,
    });
  });

  it("throws a specific error when the file vanished or is outside the project", () => {
    expect(() => untrackedDiff("gone.ts", { ok: false, reason: "missing" })).toThrow(
      DiffParseError,
    );
    expect(() => untrackedDiff("gone.ts", { ok: false, reason: "missing" })).toThrow(
      /no longer there/,
    );
    expect(() => untrackedDiff("escape.ts", { ok: false, reason: "forbidden" })).toThrow(
      /outside the project/,
    );
  });
});
