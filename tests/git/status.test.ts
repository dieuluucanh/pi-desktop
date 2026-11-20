import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStatus, readStashes, readStatus } from "../../src/git/status";
import { createFakeGitRunner, createNodeGitRunner } from "../../src/git/runner";
import { MAX_STATUS_PATHS, isSafeRepoPath } from "../../src/shared/git";
import { gitFixture, type GitFixture } from "./fixture";

/**
 * `git status --porcelain=v2 -z` (git-checkpoint plan step 4).
 *
 * The parser is tested two ways: hand-written records prove each shape is read
 * the way git documents it, and a real repository proves the records really look
 * like that — including a path with a space, a CJK name and a rename, which is
 * where every naive parser breaks.
 */

/** Joins fields the way `-z` does: NUL between every field. */
function z(...fields: string[]): string {
  return `${fields.join("\u0000")}\u0000`;
}

describe("parseStatus", () => {
  it("reads branch facts from the header records", () => {
    const parsed = parseStatus(
      z(
        "# branch.oid abc123",
        "# branch.head main",
        "# branch.upstream origin/main",
        "# branch.ab +2 -3",
      ),
    );
    expect(parsed.branch).toEqual({ head: "main", ahead: 2, behind: 3 });
    expect(parsed.staged).toEqual([]);
    expect(parsed.changed).toEqual([]);
  });

  it("reports a detached head as a null branch name", () => {
    const parsed = parseStatus(z("# branch.head (detached)", "# branch.oid abc123"));
    expect(parsed.branch?.head).toBeNull();
  });

  it("keeps branch.ab when it arrives before branch.head", () => {
    const parsed = parseStatus(z("# branch.ab +1 -0", "# branch.head feat/x"));
    expect(parsed.branch).toEqual({ head: "feat/x", ahead: 1, behind: 0 });
  });

  it("splits an ordinary change into index and work-tree groups", () => {
    // `1 .M` — unchanged in the index, modified in the work tree.
    const parsed = parseStatus(z("1 .M N... 100644 100644 100644 aaa bbb src/app.ts"));
    expect(parsed.staged).toEqual([]);
    expect(parsed.changed).toEqual([
      { path: "src/app.ts", origPath: null, status: "modified", staged: false, unstaged: true },
    ]);

    // `1 M.` — staged, no further work-tree change.
    const stagedOnly = parseStatus(z("1 M. N... 100644 100644 100644 aaa bbb src/app.ts"));
    expect(stagedOnly.staged).toEqual([
      { path: "src/app.ts", origPath: null, status: "modified", staged: true, unstaged: false },
    ]);
    expect(stagedOnly.changed).toEqual([]);
  });

  it("puts a file changed on both sides in both groups", () => {
    const parsed = parseStatus(z("1 MM N... 100644 100644 100644 aaa bbb src/app.ts"));
    expect(parsed.staged.map((entry) => entry.path)).toEqual(["src/app.ts"]);
    expect(parsed.changed.map((entry) => entry.path)).toEqual(["src/app.ts"]);
    expect(parsed.total).toBe(1);
  });

  it("maps every status letter", () => {
    const cases: Array<[string, string]> = [
      ["1 A. N... 000000 100644 100644 0000 aaa new.ts", "added"],
      ["1 .D N... 100644 100644 000000 aaa 0000 gone.ts", "deleted"],
      ["1 .T N... 100644 100644 120000 aaa bbb link.ts", "modified"],
    ];
    for (const [record, expected] of cases) {
      const parsed = parseStatus(z(record));
      const entry = parsed.staged[0] ?? parsed.changed[0];
      expect(entry?.status, record).toBe(expected);
    }
  });

  it("reads a rename and its original path from the following field", () => {
    const parsed = parseStatus(
      z("2 R. N... 100644 100644 100644 aaa bbb R100 new/name.ts", "old/name.ts"),
    );
    expect(parsed.staged).toEqual([
      {
        path: "new/name.ts",
        origPath: "old/name.ts",
        status: "renamed",
        staged: true,
        unstaged: false,
      },
    ]);
  });

  it("reads an untracked path", () => {
    const parsed = parseStatus(z("? scratch/notes.md"));
    expect(parsed.changed).toEqual([
      {
        path: "scratch/notes.md",
        origPath: null,
        status: "untracked",
        staged: false,
        unstaged: true,
      },
    ]);
  });

  it("skips a nested repository's folder record", () => {
    // `-uall` descends into every untracked folder except another repository,
    // which git still reports as one trailing-slash record.
    const parsed = parseStatus(z("? nested/"));
    expect(parsed.changed).toEqual([]);
    expect(parsed.total).toBe(0);
  });

  it("drops ignored paths", () => {
    const parsed = parseStatus(z("! node_modules/", "! dist/"));
    expect(parsed.total).toBe(0);
    expect(parsed.staged).toEqual([]);
    expect(parsed.changed).toEqual([]);
  });

  it("marks a conflict as both staged and unstaged", () => {
    const parsed = parseStatus(
      z("u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.ts"),
    );
    expect(parsed.staged[0]?.status).toBe("conflicted");
    expect(parsed.changed[0]?.status).toBe("conflicted");
  });

  it("keeps a path that contains a space", () => {
    const parsed = parseStatus(z("? docs/my notes.md"));
    expect(parsed.changed[0]?.path).toBe("docs/my notes.md");
  });

  it("keeps a path that contains a newline", () => {
    const parsed = parseStatus(z("? weird\nname.txt"));
    expect(parsed.changed[0]?.path).toBe("weird\nname.txt");
  });

  it("keeps a CJK path verbatim", () => {
    const parsed = parseStatus(z("1 .M N... 100644 100644 100644 aaa bbb 資料/報告書.docx"));
    expect(parsed.changed[0]?.path).toBe("資料/報告書.docx");
  });

  it("skips an empty stream and a trailing NUL", () => {
    expect(parseStatus("").total).toBe(0);
    expect(parseStatus("\u0000\u0000").total).toBe(0);
  });

  it("marks the list truncated past the cap but keeps counting", () => {
    const records: string[] = [];
    for (let index = 0; index < MAX_STATUS_PATHS + 5; index += 1) {
      records.push(`? f${index}.txt`);
    }
    const parsed = parseStatus(z(...records));
    expect(parsed.changed).toHaveLength(MAX_STATUS_PATHS);
    expect(parsed.truncated).toBe(true);
    expect(parsed.total).toBe(MAX_STATUS_PATHS + 5);
  });

  it("does not truncate an exactly-full list", () => {
    const records = Array.from({ length: MAX_STATUS_PATHS }, (_, index) => `? f${index}.txt`);
    const parsed = parseStatus(z(...records));
    expect(parsed.changed).toHaveLength(MAX_STATUS_PATHS);
    expect(parsed.truncated).toBe(false);
  });
});

describe("status against a real repository", () => {
  /**
   * Each case gets its own repository: these tests mutate the work tree, and a
   * shared fixture makes one failing case cascade into the next.
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

  it("reports a clean tree as empty", async () => {
    await withFixture(async (fixture) => {
      const parsed = await readStatus(createNodeGitRunner(), fixture.root);
      expect(parsed.ok).toBe(true);
      expect(parsed.staged).toEqual([]);
      expect(parsed.changed).toEqual([]);
      expect(parsed.branch?.head).toBe("main");
    });
  });

  it("reports unstaged, staged, untracked and modified-twice files", async () => {
    await withFixture(async (fixture) => {
      const runner = createNodeGitRunner();

      await fixture.write("README.md", "# fixture\nchanged\n");
      await fixture.write("staged.txt", "first\n");
      await fixture.git(["add", "staged.txt"]);
      await fixture.write("staged.txt", "first\nsecond\n");
      await fixture.write("brand new.md", "untracked\n");

      const parsed = await readStatus(runner, fixture.root);
      expect(parsed.ok).toBe(true);

      const changedPaths = parsed.changed.map((entry) => entry.path);
      expect(changedPaths).toContain("README.md");
      expect(changedPaths).toContain("brand new.md");

      const untracked = parsed.changed.find((entry) => entry.status === "untracked");
      expect(untracked?.path).toBe("brand new.md");

      // `staged.txt` was staged and then edited again: both groups see it.
      expect(parsed.staged.some((entry) => entry.path === "staged.txt")).toBe(true);
      expect(parsed.changed.some((entry) => entry.path === "staged.txt")).toBe(true);
    });
  });

  it("lists each file inside a brand-new folder", async () => {
    await withFixture(async (fixture) => {
      await fixture.write("feature/new/deep.ts", "export const deep = 1;\n");
      await fixture.write("feature/new/second.ts", "export const second = 2;\n");

      const parsed = await readStatus(createNodeGitRunner(), fixture.root);
      expect(parsed.ok).toBe(true);

      const paths = parsed.changed.map((entry) => entry.path);
      expect(paths).toContain("feature/new/deep.ts");
      expect(paths).toContain("feature/new/second.ts");
      // A folder row cannot be staged or diffed by this panel.
      expect(paths.some((path) => path.endsWith("/"))).toBe(false);
      // The wire sanitizer refuses anything this parser emits — the contract
      // that silently dropped the pre-`-uall` folder record.
      expect(paths.every((path) => isSafeRepoPath(path))).toBe(true);
      expect(parsed.changed.find((entry) => entry.path === "feature/new/deep.ts")?.status).toBe(
        "untracked",
      );
    });
  });

  it("skips a nested repository", async () => {
    await withFixture(async (fixture) => {
      await fixture.git(["init", "nested"]);

      const parsed = await readStatus(createNodeGitRunner(), fixture.root);
      expect(parsed.changed.some((entry) => entry.path.startsWith("nested"))).toBe(false);
    });
  });

  it("reads a committed rename with a CJK name and a space", async () => {
    await withFixture(async (fixture) => {
      // A rename is only detectable against a commit, so commit the source first.
      await fixture.write("資料/報告書.txt", "cjk\n");
      await fixture.git(["add", "資料/報告書.txt"]);
      await fixture.git(["commit", "-m", "docs: add report"]);
      await fixture.git(["mv", "資料/報告書.txt", "資料/renamed 報告書.txt"]);

      const parsed = await readStatus(createNodeGitRunner(), fixture.root);
      expect(parsed.ok).toBe(true);

      const renamed = parsed.staged.find((entry) => entry.status === "renamed");
      expect(renamed?.path).toBe("資料/renamed 報告書.txt");
      expect(renamed?.origPath).toBe("資料/報告書.txt");
    });
  });

  it("reports a deletion", async () => {
    await withFixture(async (fixture) => {
      await fixture.git(["rm", "README.md"]);
      const parsed = await readStatus(createNodeGitRunner(), fixture.root);
      expect(parsed.staged.find((entry) => entry.path === "README.md")?.status).toBe("deleted");
    });
  });

  it("reports a conflict after a failed merge", async () => {
    await withFixture(async (fixture) => {
      const runner = createNodeGitRunner();
      await fixture.git(["checkout", "-b", "conflict-side"]);
      await fixture.write("README.md", "side\n");
      await fixture.git(["commit", "-am", "side"]);
      await fixture.git(["checkout", "main"]);
      await fixture.write("README.md", "main\n");
      await fixture.git(["commit", "-am", "main"]);
      await fixture.tryGit(["merge", "conflict-side"]);

      const parsed = await readStatus(runner, fixture.root);
      const conflicted = [...parsed.staged, ...parsed.changed].find(
        (entry) => entry.status === "conflicted",
      );
      expect(conflicted?.path).toBe("README.md");
      // The conflict is both staged (index stages) and unstaged (work tree).
      expect(parsed.staged.some((entry) => entry.path === "README.md")).toBe(true);
      expect(parsed.changed.some((entry) => entry.path === "README.md")).toBe(true);
    });
  });

  it("reports a folder that is not a repository", async () => {
    const plain = await mkdtemp(join(tmpdir(), "pi-desktop-status-"));
    try {
      const parsed = await readStatus(createNodeGitRunner(), plain);
      expect(parsed.ok).toBe(false);
      expect(parsed.stderr).toMatch(/not a git repository/i);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});

describe("readStatus argv", () => {
  it("asks git for every untracked file, not just the folder", async () => {
    const runner = createFakeGitRunner([{ args: ["status"], stdout: "" }]);

    await readStatus(runner, "/repo");

    expect(runner.calls[0]?.args).toContain("--untracked-files=all");
  });
});

describe("readStashes", () => {
  let fixture: GitFixture;

  beforeAll(async () => {
    fixture = await gitFixture();
  });

  afterAll(async () => {
    await fixture?.cleanup();
  });

  it("returns nothing when there is no stash", async () => {
    if (fixture.skipReason) return;
    expect(await readStashes(createNodeGitRunner(), fixture.root)).toEqual([]);
  });

  it("lists a stash with its index, time and subject", async () => {
    if (fixture.skipReason) return;
    await fixture.write("README.md", "# fixture\nstashed edit\n");
    await fixture.git(["stash", "push", "-m", "work in progress"]);

    const stashes = await readStashes(createNodeGitRunner(), fixture.root);
    expect(stashes).toHaveLength(1);
    expect(stashes[0]?.ref).toBe("stash@{0}");
    expect(stashes[0]?.index).toBe(0);
    expect(stashes[0]?.subject).toMatch(/work in progress/);
    expect(stashes[0]?.at).toBeGreaterThan(0);

    await fixture.git(["stash", "drop"]);
  });

  it("returns nothing for a folder that is not a repository", async () => {
    if (fixture.skipReason) return;
    const plain = await mkdtemp(join(tmpdir(), "pi-desktop-stash-"));
    try {
      expect(await readStashes(createNodeGitRunner(), plain)).toEqual([]);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});
