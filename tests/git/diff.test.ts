import { describe, expect, it } from "vitest";
import {
  applyHunkPatch,
  buildHunkPatch,
  diffTotals,
  DiffParseError,
  hasDiffContent,
  MAX_COMMIT_PATCH_LINES,
  parseDiffText,
  readCommitContext,
  readDiff,
} from "../../src/git/diff";
import { createFakeGitRunner, createNodeGitRunner } from "../../src/git/runner";
import {
  MAX_COMMIT_CONTEXT_BYTES,
  MAX_COMMIT_CONTEXT_FILES,
  MAX_DIFF_BYTES,
  MAX_DIFF_FILES,
  MAX_RECENT_COMMIT_SUBJECTS,
} from "../../src/shared/git";
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

  it("refuses an untracked request instead of running git diff", async () => {
    const runner = createFakeGitRunner([]);
    await expect(readDiff(runner, "/repo", { path: "new.ts", untracked: true })).rejects.toThrow(
      /read from the work tree/,
    );
    expect(runner.calls).toEqual([]);
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

/** One plausible `git diff --stat` block for tests that do not parse it. */
const STAGED_STAT = " src/app.ts | 3 ++-\n 1 file changed, 2 insertions(+), 1 deletion(-)\n";

/** One complete file section, padded to a predictable size. */
function fileSection(name: string, lines: number): string {
  const body = Array.from({ length: lines }, (_, index) => `+line ${index} of ${name}`).join("\n");
  return `diff --git a/${name} b/${name}
new file mode 100644
--- /dev/null
+++ b/${name}
@@ -0,0 +1,${lines} @@
${body}
`;
}

describe("readCommitContext", () => {
  it("pins the argv and reads the stat, numstat, log and patch", async () => {
    const runner = createFakeGitRunner([
      { args: ["diff", "--cached", "--stat"], stdout: STAGED_STAT },
      { args: ["diff", "--cached", "--numstat", "-z"], stdout: "2\t1\tsrc/app.ts\u0000" },
      { args: ["diff", "--cached", "-U3"], stdout: MODIFIED },
      { args: ["log", "-n", "8", "--format=%s"], stdout: "feat: one\nfix: two\n\n" },
    ]);

    const context = await readCommitContext(runner, "/repo");

    expect(runner.calls.map((call) => call.args)).toEqual([
      ["diff", "--cached", "--stat"],
      ["diff", "--cached", "--numstat", "-z"],
      ["log", "-n", String(MAX_RECENT_COMMIT_SUBJECTS), "--format=%s"],
      ["diff", "--cached", "-U3", "--no-color", "--no-ext-diff", "--no-textconv"],
    ]);
    expect(context.stat).toBe(STAGED_STAT);
    expect(context.patch).toContain("@@ -1,4 +1,5 @@");
    expect(context.truncated).toBe(false);
    expect(context.files).toBe(1);
    expect(context.insertions).toBe(2);
    expect(context.deletions).toBe(1);
    expect(context.recentSubjects).toEqual(["feat: one", "fix: two"]);
  });

  it("returns a zeroed context for an empty index but still reads the log", async () => {
    const runner = createFakeGitRunner([
      { args: ["diff", "--cached", "--stat"], stdout: "" },
      { args: ["diff", "--cached", "--numstat", "-z"], stdout: "" },
      { args: ["log", "-n", "8", "--format=%s"], stdout: "chore: seed\n" },
    ]);

    const context = await readCommitContext(runner, "/repo");

    expect(context).toEqual({
      stat: "",
      patch: "",
      truncated: false,
      files: 0,
      insertions: 0,
      deletions: 0,
      recentSubjects: ["chore: seed"],
    });
    // No patch read for an empty index.
    expect(runner.calls).toHaveLength(3);
  });

  it("truncates at the last complete diff --git boundary before the cap", async () => {
    const first = fileSection("first.ts", 20);
    const second = fileSection("second.ts", 20);
    const third = fileSection("third.ts", 20);
    const patch = first + second + third;
    // The cap lands inside the third section, after its header.
    const cap = first.length + second.length + 20;
    const runner = createFakeGitRunner([
      { args: ["diff", "--cached", "--stat"], stdout: STAGED_STAT },
      {
        args: ["diff", "--cached", "--numstat", "-z"],
        stdout: "20\t0\tfirst.ts\u0000" + "20\t0\tsecond.ts\u0000" + "20\t0\tthird.ts\u0000",
      },
      { args: ["diff", "--cached", "-U3"], stdout: patch },
      { args: ["log", "-n", "8", "--format=%s"], stdout: "" },
    ]);

    const context = await readCommitContext(runner, "/repo", { maxBytes: cap });

    expect(context.truncated).toBe(true);
    expect(context.patch).toBe(first + second.replace(/\n+$/, ""));
    expect(context.patch).not.toContain("third.ts");
    expect(context.patch.length).toBeLessThanOrEqual(cap);
  });

  it("cuts a single section larger than the cap at a line boundary", async () => {
    const section = fileSection("huge.ts", 80);
    const cap = 200;
    const runner = createFakeGitRunner([
      { args: ["diff", "--cached", "--stat"], stdout: STAGED_STAT },
      { args: ["diff", "--cached", "--numstat", "-z"], stdout: "80\t0\thuge.ts\u0000" },
      { args: ["diff", "--cached", "-U3"], stdout: section },
      { args: ["log", "-n", "8", "--format=%s"], stdout: "" },
    ]);

    const context = await readCommitContext(runner, "/repo", { maxBytes: cap });

    expect(context.truncated).toBe(true);
    expect(context.patch.length).toBeLessThanOrEqual(cap);
    expect(context.patch.startsWith("diff --git a/huge.ts")).toBe(true);
    expect(section.startsWith(context.patch)).toBe(true);
    // The cut respects a line boundary.
    expect(context.patch.endsWith("\n")).toBe(false);
  });

  it("drops a leading partial block left by the runner's tail trim", async () => {
    const complete = fileSection("complete.ts", 5);
    const leading = "@@ -1 +1 @@\n-partial\n+block\n";
    const runner = createFakeGitRunner([
      { args: ["diff", "--cached", "--stat"], stdout: STAGED_STAT },
      { args: ["diff", "--cached", "--numstat", "-z"], stdout: "5\t0\tcomplete.ts\u0000" },
      { args: ["diff", "--cached", "-U3"], stdout: leading + complete },
      { args: ["log", "-n", "8", "--format=%s"], stdout: "" },
    ]);

    const context = await readCommitContext(runner, "/repo");

    expect(context.patch).toBe(complete);
    expect(context.truncated).toBe(true);
  });

  it("skips the patch above the line-count early-out but keeps the stat", async () => {
    const runner = createFakeGitRunner([
      { args: ["diff", "--cached", "--stat"], stdout: STAGED_STAT },
      {
        args: ["diff", "--cached", "--numstat", "-z"],
        stdout: `${MAX_COMMIT_PATCH_LINES - 1}\t1\tbig.ts\u0000`,
      },
      { args: ["log", "-n", "8", "--format=%s"], stdout: "" },
    ]);

    const context = await readCommitContext(runner, "/repo");

    expect(context.stat).toBe(STAGED_STAT);
    expect(context.patch).toBe("");
    expect(context.truncated).toBe(true);
    expect(context.insertions).toBe(MAX_COMMIT_PATCH_LINES - 1);
    expect(context.deletions).toBe(1);
    // stat, numstat, log — no unified patch.
    expect(runner.calls).toHaveLength(3);
  });

  it("counts binary rows as zero and caps the file count", async () => {
    const rows = Array.from(
      { length: MAX_COMMIT_CONTEXT_FILES + 5 },
      (_, index) => `1\t0\tf-${index}.ts\u0000`,
    ).join("");
    const runner = createFakeGitRunner([
      { args: ["diff", "--cached", "--stat"], stdout: STAGED_STAT },
      { args: ["diff", "--cached", "--numstat", "-z"], stdout: rows },
      { args: ["diff", "--cached", "-U3"], stdout: MODIFIED },
      { args: ["log", "-n", "8", "--format=%s"], stdout: "" },
    ]);

    const context = await readCommitContext(runner, "/repo");

    expect(context.files).toBe(MAX_COMMIT_CONTEXT_FILES);
    expect(context.insertions).toBe(MAX_COMMIT_CONTEXT_FILES + 5);
    expect(context.deletions).toBe(0);
  });

  it("parses binary and rename -z rows without counting lines", async () => {
    const runner = createFakeGitRunner([
      { args: ["diff", "--cached", "--stat"], stdout: STAGED_STAT },
      {
        args: ["diff", "--cached", "--numstat", "-z"],
        stdout: "-\t-\tbook.xlsx\u0000" + "0\t0\t\u0000old.txt\u0000new.txt\u0000",
      },
      { args: ["diff", "--cached", "-U3"], stdout: BINARY },
      { args: ["log", "-n", "8", "--format=%s"], stdout: "" },
    ]);

    const context = await readCommitContext(runner, "/repo");

    expect(context.files).toBe(2);
    expect(context.insertions).toBe(0);
    expect(context.deletions).toBe(0);
    expect(context.patch).toContain("Binary files");
  });

  it("caps the recent subjects at the wire bound", async () => {
    const subjects = Array.from({ length: 12 }, (_, index) => `feat: subject ${index}`).join("\n");
    const runner = createFakeGitRunner([
      { args: ["diff", "--cached", "--stat"], stdout: "" },
      { args: ["diff", "--cached", "--numstat", "-z"], stdout: "" },
      { args: ["log", "-n", "8", "--format=%s"], stdout: `${subjects}\n` },
    ]);

    const context = await readCommitContext(runner, "/repo");

    expect(context.recentSubjects).toHaveLength(MAX_RECENT_COMMIT_SUBJECTS);
    expect(context.recentSubjects[0]).toBe("feat: subject 0");
    expect(context.recentSubjects.at(-1)).toBe(`feat: subject ${MAX_RECENT_COMMIT_SUBJECTS - 1}`);
  });

  it("honours the default byte budget for a large diff", async () => {
    const section = fileSection("huge.ts", 4_000);
    const runner = createFakeGitRunner([
      { args: ["diff", "--cached", "--stat"], stdout: STAGED_STAT },
      { args: ["diff", "--cached", "--numstat", "-z"], stdout: "4000\t0\thuge.ts\u0000" },
      { args: ["diff", "--cached", "-U3"], stdout: section },
      { args: ["log", "-n", "8", "--format=%s"], stdout: "" },
    ]);

    const context = await readCommitContext(runner, "/repo");

    expect(section.length).toBeGreaterThan(MAX_COMMIT_CONTEXT_BYTES);
    expect(context.truncated).toBe(true);
    expect(context.patch.length).toBeLessThanOrEqual(MAX_COMMIT_CONTEXT_BYTES);
  });
});
