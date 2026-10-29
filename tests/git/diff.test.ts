import { describe, expect, it } from "vitest";
import {
  applyHunkPatch,
  buildHunkPatch,
  diffTotals,
  DiffParseError,
  hasDiffContent,
  parseDiffText,
  readDiff,
} from "../../src/git/diff";
import { createFakeGitRunner, createNodeGitRunner } from "../../src/git/runner";
import { MAX_DIFF_BYTES, MAX_DIFF_FILES } from "../../src/shared/git";
import { gitFixture, type GitFixture } from "./fixture";

/**
 * Structured diffs and single-hunk patches (git-checkpoint plan step 5).
 *
 * The parser is pinned against hand-written git patches (every extended header
 * shape), and hunk staging is pinned against a real repository: a rebuilt patch
 * is only correct if `git apply --cached` accepts it and the index ends up with
 * exactly one hunk applied.
 */

const MODIFIED = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
 const e = 6;
`;

const ADDED = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const x = 1;
+export const y = 2;
`;

const DELETED = `diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const z = 1;
-export const w = 2;
`;

const RENAMED = `diff --git a/src/old name.ts b/src/new name.ts
similarity index 100%
rename from src/old name.ts
rename to src/new name.ts
`;

const BINARY = `diff --git a/docs/report.docx b/docs/report.docx
index 5555555..6666666 100644
Binary files a/docs/report.docx and b/docs/report.docx differ
`;

const TWO_HUNKS = `diff --git a/src/spread.ts b/src/spread.ts
index 7777777..8888888 100644
--- a/src/spread.ts
+++ b/src/spread.ts
@@ -1,3 +1,3 @@
 line one
-line two
+line TWO
 line three
@@ -20,3 +20,3 @@
 line twenty
-line twenty-one
+line TWENTY-ONE
 line twenty-two
`;

describe("parseDiffText", () => {
  it("parses a modified file with numbered lines and counts", () => {
    const diff = parseDiffText(MODIFIED, "working");
    expect(diff.scope).toBe("working");
    expect(diff.tooLarge).toBe(false);
    expect(diff.files).toHaveLength(1);

    const file = diff.files[0];
    expect(file?.path).toBe("src/app.ts");
    expect(file?.status).toBe("modified");
    expect(file?.binary).toBe(false);
    expect(file?.added).toBe(2);
    expect(file?.removed).toBe(1);
    expect(file?.hunks).toHaveLength(1);

    const lines = file?.hunks[0]?.lines ?? [];
    expect(lines[0]).toEqual({ kind: "context", oldLine: 1, newLine: 1, text: "const a = 1;" });
    expect(lines[1]).toEqual({ kind: "remove", oldLine: 2, newLine: null, text: "const b = 2;" });
    expect(lines[2]).toEqual({ kind: "add", oldLine: null, newLine: 2, text: "const b = 3;" });
    expect(lines[3]).toEqual({ kind: "add", oldLine: null, newLine: 3, text: "const c = 4;" });
    expect(lines[4]).toEqual({ kind: "context", oldLine: 3, newLine: 4, text: "const d = 5;" });
  });

  it("keeps the exact patch header names for a rebuild", () => {
    const file = parseDiffText(MODIFIED, "working").files[0];
    expect(file?.patchOldPath).toBe("a/src/app.ts");
    expect(file?.patchNewPath).toBe("b/src/app.ts");
  });

  it("parses an added file against /dev/null", () => {
    const file = parseDiffText(ADDED, "staged").files[0];
    expect(file?.path).toBe("src/new.ts");
    expect(file?.status).toBe("added");
    expect(file?.added).toBe(2);
    expect(file?.removed).toBe(0);
    expect(file?.patchOldPath).toBe("/dev/null");
    expect(file?.patchNewPath).toBe("b/src/new.ts");
  });

  it("parses a deleted file and names it from the old side", () => {
    const file = parseDiffText(DELETED, "staged").files[0];
    expect(file?.path).toBe("src/gone.ts");
    expect(file?.status).toBe("deleted");
    expect(file?.added).toBe(0);
    expect(file?.removed).toBe(2);
    expect(file?.patchNewPath).toBe("/dev/null");
  });

  it("parses a pure rename with no hunks", () => {
    const file = parseDiffText(RENAMED, "staged").files[0];
    expect(file?.path).toBe("src/new name.ts");
    expect(file?.origPath).toBe("src/old name.ts");
    expect(file?.status).toBe("renamed");
    expect(file?.hunks).toEqual([]);
    expect(hasDiffContent(parseDiffText(RENAMED, "staged"))).toBe(false);
  });

  it("marks a binary file and gives it no hunks", () => {
    const diff = parseDiffText(BINARY, "working");
    const file = diff.files[0];
    expect(file?.binary).toBe(true);
    expect(file?.hunks).toEqual([]);
    expect(file?.added).toBe(0);
    expect(file?.removed).toBe(0);
    expect(hasDiffContent(diff)).toBe(true);
  });

  it("parses several hunks in one file", () => {
    const file = parseDiffText(TWO_HUNKS, "working").files[0];
    expect(file?.hunks).toHaveLength(2);
    expect(file?.hunks[0]?.oldStart).toBe(1);
    expect(file?.hunks[1]?.oldStart).toBe(20);
    expect(file?.added).toBe(2);
    expect(file?.removed).toBe(2);
    expect(file?.hunks[0]?.header).toBe("-1,3 +1,3");
  });

  it("parses a multi-file diff", () => {
    const diff = parseDiffText([MODIFIED, ADDED, DELETED].join(""), "working");
    expect(diff.files.map((file) => file.path)).toEqual([
      "src/app.ts",
      "src/new.ts",
      "src/gone.ts",
    ]);
    expect(diffTotals(diff)).toEqual({ added: 4, removed: 3 });
  });

  it("returns an empty diff for empty text", () => {
    expect(parseDiffText("", "working")).toEqual({
      scope: "working",
      files: [],
      tooLarge: false,
      truncated: false,
    });
    expect(parseDiffText("   \n\n", "staged").files).toEqual([]);
  });

  it("reports too_large without parsing", () => {
    const diff = parseDiffText("x".repeat(MAX_DIFF_BYTES + 1), "working");
    expect(diff.tooLarge).toBe(true);
    expect(diff.files).toEqual([]);
    expect(hasDiffContent(diff)).toBe(false);
  });

  it("truncates past the file cap", () => {
    const many = Array.from({ length: MAX_DIFF_FILES + 3 }, (_, index) =>
      ADDED.replaceAll("src/new.ts", `src/new-${index}.ts`),
    ).join("");
    const diff = parseDiffText(many, "working");
    expect(diff.files).toHaveLength(MAX_DIFF_FILES);
    expect(diff.truncated).toBe(true);
  });

  it("throws when non-empty text yields no file sections", () => {
    expect(() => parseDiffText("this is not a patch\n", "working")).toThrow(DiffParseError);
  });

  it("carries the requested scope through", () => {
    expect(parseDiffText(MODIFIED, "staged").scope).toBe("staged");
    expect(parseDiffText(MODIFIED, "commit").scope).toBe("commit");
  });
});

describe("buildHunkPatch", () => {
  it("rebuilds one hunk verbatim with the original header", () => {
    const file = parseDiffText(TWO_HUNKS, "working").files[0];
    const hunk = file?.hunks[0];
    expect(file && hunk).toBeTruthy();
    if (!file || !hunk) return;

    const patch = buildHunkPatch(file, hunk);
    expect(patch).toContain("diff --git a/src/spread.ts b/src/spread.ts");
    expect(patch).toContain("--- a/src/spread.ts");
    expect(patch).toContain("+++ b/src/spread.ts");
    expect(patch).toContain("@@ -1,3 +1,3 @@");
    expect(patch).toContain("-line two");
    expect(patch).toContain("+line TWO");
    // The second hunk must not be in the patch.
    expect(patch).not.toContain("line TWENTY-ONE");
    expect(patch).not.toContain("@@ -20,3 +20,3 @@");
  });

  it("uses /dev/null for the missing side of a created or deleted file", () => {
    const added = parseDiffText(ADDED, "staged").files[0];
    if (!added?.hunks[0]) throw new Error("fixture is broken");
    const addPatch = buildHunkPatch(added, added.hunks[0]);
    expect(addPatch).toContain("--- /dev/null");
    expect(addPatch).toContain("+++ b/src/new.ts");

    const deleted = parseDiffText(DELETED, "staged").files[0];
    if (!deleted?.hunks[0]) throw new Error("fixture is broken");
    const deletePatch = buildHunkPatch(deleted, deleted.hunks[0]);
    expect(deletePatch).toContain("--- a/src/gone.ts");
    expect(deletePatch).toContain("+++ /dev/null");
  });

  it("re-emits a 'no newline at end of file' marker", () => {
    const noNewline = `diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;
    const file = parseDiffText(noNewline, "working").files[0];
    if (!file?.hunks[0]) throw new Error("fixture is broken");
    const patch = buildHunkPatch(file, file.hunks[0]);
    expect(patch).toContain("\\ No newline at end of file");
  });
});

describe("readDiff command shape", () => {
  it("asks for the working-tree diff by default", async () => {
    const runner = createFakeGitRunner([{ args: ["diff", "--no-color"], stdout: MODIFIED }]);
    const diff = await readDiff(runner, "/repo");
    expect(diff.scope).toBe("working");
    expect(diff.files[0]?.path).toBe("src/app.ts");
    expect(runner.calls[0]?.args).toEqual(
      expect.arrayContaining(["--no-ext-diff", "-U3", "--src-prefix=a/", "--dst-prefix=b/"]),
    );
  });

  it("asks for the staged diff with --cached", async () => {
    const runner = createFakeGitRunner([{ args: ["diff", "--cached"], stdout: ADDED }]);
    const diff = await readDiff(runner, "/repo", { staged: true });
    expect(diff.scope).toBe("staged");
    expect(runner.calls[0]?.args).toContain("--cached");
  });

  it("reads a commit with show and no message in the patch", async () => {
    const runner = createFakeGitRunner([{ args: ["show", "--format="], stdout: MODIFIED }]);
    const diff = await readDiff(runner, "/repo", { commit: "a".repeat(40) });
    expect(diff.scope).toBe("commit");
    expect(runner.calls[0]?.args).toContain("--format=");
    expect(runner.calls[0]?.args).toContain("a".repeat(40));
  });

  it("scopes a path after the -- separator", async () => {
    const runner = createFakeGitRunner([{ args: ["diff", "--no-color"], stdout: MODIFIED }]);
    await readDiff(runner, "/repo", { path: "src/app.ts" });
    const args = runner.calls[0]?.args ?? [];
    expect(args[args.length - 2]).toBe("--");
    expect(args[args.length - 1]).toBe("src/app.ts");
  });

  it("returns an empty diff when git is missing", async () => {
    const runner = createFakeGitRunner([{ args: ["diff"], missing: true }]);
    const diff = await readDiff(runner, "/repo");
    expect(diff.files).toEqual([]);
    expect(diff.tooLarge).toBe(false);
  });

  it("throws a classified parse error when git fails", async () => {
    const runner = createFakeGitRunner([
      { args: ["diff"], code: 128, stderr: "fatal: not a git repository" },
    ]);
    await expect(readDiff(runner, "/repo")).rejects.toThrow(/git diff failed/);
  });
});

describe("hunk staging against a real repository", () => {
  /**
   * Each case gets its own repository: these tests commit, reset and clean, and
   * a shared fixture makes a second seed fail with "nothing to commit".
   */
  async function withFixture(run: (fixture: GitFixture) => Promise<void>): Promise<void> {
    const fixture = await gitFixture();
    if (fixture.skipReason) return;
    try {
      await run(fixture);
    } finally {
      await fixture.cleanup();
    }
  }

  /** A committed file with two well-separated spots to edit. */
  async function seedSpread(fixture: GitFixture): Promise<string> {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
    await fixture.write("spread.txt", `${lines}\n`);
    await fixture.git(["add", "spread.txt"]);
    await fixture.git(["commit", "-m", "test: seed spread"]);
    return "spread.txt";
  }

  it("stages exactly one hunk of a two-hunk edit", async () => {
    await withFixture(async (fixture) => {
      const path = await seedSpread(fixture);
      const original = await fixture.read(path);
      const edited = original
        .replace("line 2\n", "line TWO\n")
        .replace("line 28\n", "line TWENTY-EIGHT\n");
      await fixture.write(path, edited);

      const runner = createNodeGitRunner();
      const diff = await readDiff(runner, fixture.root, { path });
      expect(diff.files).toHaveLength(1);
      expect(diff.files[0]?.hunks).toHaveLength(2);

      const file = diff.files[0];
      const hunk = file?.hunks[0];
      if (!file || !hunk) throw new Error("expected one file with two hunks");

      const result = await applyHunkPatch(runner, fixture.root, buildHunkPatch(file, hunk));
      expect(result.ok, result.stderr).toBe(true);

      // The index now holds the first edit only.
      const staged = await fixture.git(["diff", "--cached", "--", path]);
      expect(staged).toContain("+line TWO");
      expect(staged).not.toContain("+line TWENTY-EIGHT");

      // The work tree still holds both edits.
      const working = await fixture.git(["diff", "--", path]);
      expect(working).toContain("+line TWENTY-EIGHT");
      expect(working).not.toContain("+line TWO");
    });
  });

  it("unstages a hunk in reverse without touching the work tree", async () => {
    await withFixture(async (fixture) => {
      const path = await seedSpread(fixture);
      const original = await fixture.read(path);
      const edited = original.replace("line 2\n", "line TWO\n");
      await fixture.write(path, edited);
      // Stage the whole edit, then unstage its single hunk.
      await fixture.git(["add", path]);

      const runner = createNodeGitRunner();
      const stagedDiff = await readDiff(runner, fixture.root, { path, staged: true });
      const file = stagedDiff.files[0];
      const hunk = file?.hunks[0];
      if (!file || !hunk) throw new Error("expected a staged hunk");

      const result = await applyHunkPatch(runner, fixture.root, buildHunkPatch(file, hunk), {
        reverse: true,
      });
      expect(result.ok, result.stderr).toBe(true);

      // Nothing is staged any more, and the work-tree edit is untouched.
      expect(await fixture.git(["diff", "--cached", "--", path])).toBe("");
      expect(await fixture.git(["diff", "--", path])).toContain("+line TWO");
    });
  });

  it("reads a commit diff and includes the whole change", async () => {
    await withFixture(async (fixture) => {
      const path = await seedSpread(fixture);
      await fixture.write(path, `${await fixture.read(path)}line 31\n`);
      await fixture.git(["commit", "-am", "test: append a line"]);

      const sha = (await fixture.git(["rev-parse", "HEAD"])).trim();
      const diff = await readDiff(createNodeGitRunner(), fixture.root, { commit: sha });
      expect(diff.scope).toBe("commit");
      expect(diff.files.map((entry) => entry.path)).toContain(path);
      const file = diff.files.find((entry) => entry.path === path);
      expect(file?.added).toBeGreaterThanOrEqual(1);
    });
  });

  it("reports a binary file without hunks", async () => {
    await withFixture(async (fixture) => {
      const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0x03]);
      await fixture.writeBytes("book.xlsx", bytes);
      await fixture.git(["add", "book.xlsx"]);
      await fixture.git(["commit", "-m", "test: binary"]);
      await fixture.writeBytes("book.xlsx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe]));

      const diff = await readDiff(createNodeGitRunner(), fixture.root, { path: "book.xlsx" });
      const file = diff.files[0];
      expect(file?.binary).toBe(true);
      expect(file?.hunks).toEqual([]);
    });
  });
});
