import { describe, expect, it } from "vitest";
import {
  classifyGitFailure,
  describeGitHead,
  emptyGitSnapshot,
  firstGitLine,
  gitStatusLetter,
  gitStatusTone,
  hasStagedChanges,
  isFullSha,
  isNetworkGitAction,
  isSafeRepoPath,
  MAX_STATUS_PATHS,
  parseGitAction,
  sanitizeBranchName,
  sanitizeCommitMessage,
  sanitizeGitSnapshot,
  sanitizeIdentityEmail,
  sanitizeIdentityName,
  sanitizePatch,
  sanitizeRemoteName,
  sanitizeStashIndex,
  GIT_ACTION_KINDS,
  GIT_NETWORK_ACTIONS,
} from "../../src/shared/git";

/**
 * The git wire model (git-checkpoint plan step 1).
 *
 * These tests are the contract: the renderer can only ask for a named action,
 * every path it supplies is validated before a shell sees it, and git's stderr
 * becomes one of a small number of actionable failures.
 */

describe("parseGitAction", () => {
  it("accepts every declared action kind", () => {
    const examples: Record<(typeof GIT_ACTION_KINDS)[number], unknown> = {
      stage: { kind: "stage", paths: ["src/a.ts"] },
      unstage: { kind: "unstage", paths: ["src/a.ts"] },
      "stage-hunk": {
        kind: "stage-hunk",
        path: "src/a.ts",
        patch: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
      },
      "unstage-hunk": {
        kind: "unstage-hunk",
        path: "src/a.ts",
        patch: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
      },
      discard: { kind: "discard", paths: ["src/a.ts"], untracked: false },
      commit: { kind: "commit", message: "feat: x", amend: false },
      "set-identity": { kind: "set-identity", name: "Ada", email: "ada@example.com" },
      "stash-push": { kind: "stash-push", message: null },
      "stash-pop": { kind: "stash-pop", index: 0 },
      "stash-drop": { kind: "stash-drop", index: 1 },
      "checkout-branch": { kind: "checkout-branch", branch: "main" },
      "create-branch": { kind: "create-branch", branch: "feat/x-1" },
      fetch: { kind: "fetch", remote: "origin" },
      pull: { kind: "pull" },
      push: { kind: "push" },
      init: { kind: "init" },
    };
    for (const kind of GIT_ACTION_KINDS) {
      const parsed = parseGitAction(examples[kind]);
      expect(parsed, `kind ${kind} should parse`).not.toBeNull();
      expect(parsed?.kind).toBe(kind);
    }
  });

  it("rejects an unknown kind, a non-object and a missing payload", () => {
    expect(parseGitAction({ kind: "rm-rf" })).toBeNull();
    expect(parseGitAction({ kind: "push", paths: [] })).not.toBeNull();
    expect(parseGitAction(null)).toBeNull();
    expect(parseGitAction("push")).toBeNull();
    expect(parseGitAction([])).toBeNull();
    expect(parseGitAction({})).toBeNull();
  });

  it("rejects a path that could escape the work tree or enter .git", () => {
    for (const path of [
      "../etc/passwd",
      "a/../../b",
      "/etc/passwd",
      "\\server\\share",
      "C:\\Windows\\win.ini",
      "a\\b",
      "",
      ".git/config",
      ".GIT/HEAD",
      "a//b",
      "./a",
    ]) {
      expect(isSafeRepoPath(path), `${path} must be refused`).toBe(false);
      expect(parseGitAction({ kind: "stage", paths: [path] })).toBeNull();
    }
    // A folder that merely *starts* with `.git` is fine.
    expect(isSafeRepoPath(".gitignore")).toBe(true);
    expect(isSafeRepoPath(".github/workflows/ci.yml")).toBe(true);
  });

  it("rejects a NUL or control character in a path", () => {
    expect(isSafeRepoPath("a\u0000b")).toBe(false);
    expect(isSafeRepoPath("a\nb")).toBe(false);
    expect(isSafeRepoPath("a\u007fb")).toBe(false);
  });

  it("accepts unicode, spaces and deep paths", () => {
    expect(isSafeRepoPath("src/ünïcode/ファイル.ts")).toBe(true);
    expect(isSafeRepoPath("docs/my file.md")).toBe(true);
    expect(isSafeRepoPath("a/b/c/d/e.txt")).toBe(true);
  });

  it("dedupes paths and refuses an empty list", () => {
    const parsed = parseGitAction({ kind: "stage", paths: ["a.ts", "a.ts", "b.ts"] });
    expect(parsed).toEqual({ kind: "stage", paths: ["a.ts", "b.ts"] });
    expect(parseGitAction({ kind: "stage", paths: [] })).toBeNull();
    expect(parseGitAction({ kind: "stage", paths: "a.ts" })).toBeNull();
  });

  it("requires discard to declare whether the paths are untracked", () => {
    expect(parseGitAction({ kind: "discard", paths: ["a.ts"] })).toBeNull();
    expect(parseGitAction({ kind: "discard", paths: ["a.ts"], untracked: true })).not.toBeNull();
  });

  it("refuses an empty or whitespace-only commit message", () => {
    expect(parseGitAction({ kind: "commit", message: "   ", amend: false })).toBeNull();
    expect(parseGitAction({ kind: "commit", message: "ok\n\nbody" })).toEqual({
      kind: "commit",
      message: "ok\n\nbody",
      amend: false,
    });
  });

  it("defaults amend to false when it is omitted", () => {
    expect(parseGitAction({ kind: "commit", message: "x" })).toEqual({
      kind: "commit",
      message: "x",
      amend: false,
    });
  });

  it("normalises CRLF in a commit message", () => {
    expect(parseGitAction({ kind: "commit", message: "a\r\nb\r\n" })).toEqual({
      kind: "commit",
      message: "a\nb",
      amend: false,
    });
  });

  it("refuses an invalid identity", () => {
    expect(parseGitAction({ kind: "set-identity", name: "Ada", email: "nope" })).toBeNull();
    expect(parseGitAction({ kind: "set-identity", name: "", email: "a@b.co" })).toBeNull();
    expect(parseGitAction({ kind: "set-identity", name: "Ada <x>", email: "a@b.co" })).toBeNull();
  });

  it("refuses a branch name git itself would reject", () => {
    for (const branch of [
      "-x",
      "a b",
      "a..b",
      "a~b",
      "a^b",
      "a:b",
      "a?b",
      "a*b",
      "a[b",
      "a\\b",
      "a.lock",
      "a/",
      "/a",
      "HEAD",
      "@",
      "a@{b",
      "a//b",
      ".hidden/x",
    ]) {
      expect(sanitizeBranchName(branch), `${branch} must be refused`).toBeNull();
    }
    expect(sanitizeBranchName("main")).toBe("main");
    expect(sanitizeBranchName("feat/git-panel")).toBe("feat/git-panel");
    expect(sanitizeBranchName("release-1.2.3")).toBe("release-1.2.3");
  });

  it("bounds a stash index", () => {
    expect(sanitizeStashIndex(0)).toBe(0);
    expect(sanitizeStashIndex(-1)).toBeNull();
    expect(sanitizeStashIndex(1000)).toBeNull();
    expect(sanitizeStashIndex(1.5)).toBeNull();
  });

  it("refuses a patch without a file header or a hunk", () => {
    expect(sanitizePatch("diff --git a/x b/x\n")).toBeNull();
    expect(sanitizePatch("@@ -1 +1 @@\n-a\n+b\n")).toBeNull();
    expect(sanitizePatch("diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n")).not.toBeNull();
  });

  it("parses a remote name and refuses a hostile one", () => {
    expect(sanitizeRemoteName("origin")).toBe("origin");
    expect(sanitizeRemoteName("up-stream_1")).toBe("up-stream_1");
    expect(sanitizeRemoteName("a b")).toBeNull();
    expect(sanitizeRemoteName("$HOME")).toBeNull();
    expect(sanitizeRemoteName("")).toBeNull();
  });
});

describe("classifyGitFailure", () => {
  it("reports a missing executable from the structural flag, not the text", () => {
    const error = classifyGitFailure({ missing: true, stderr: "" });
    expect(error.code).toBe("git_missing");
    expect(error.recoverable).toBe(false);
    expect(error.fix).toMatch(/Install Git/);
  });

  it.each([
    ["fatal: Unable to create '/repo/.git/index.lock': File exists.", "index_locked"],
    [
      "remote: Invalid username or password.\nfatal: Authentication failed for 'https://x'",
      "auth_required",
    ],
    ["! [rejected]        main -> main (fetch first)", "non_fast_forward"],
    ["CONFLICT (content): Merge conflict in src/a.ts", "conflict"],
    [
      "error: Your local changes to the following files would be overwritten by checkout:",
      "dirty_tree",
    ],
    ["*** Please tell me who you are.", "no_identity"],
    ["nothing to commit, working tree clean", "nothing_to_commit"],
    ["fatal: The current branch x has no upstream branch.", "no_upstream"],
    ["error: pathspec 'nope' did not match any file(s) known to git", "pathspec"],
    ["error: patch does not apply", "apply_failed"],
    ["fatal: not a git repository (or any of the parent directories): .git", "not_a_repo"],
  ])("classifies %s as %s", (stderr, expected) => {
    expect(classifyGitFailure({ stderr, code: 128 }).code).toBe(expected);
  });

  it("falls back to unknown and keeps git's own line", () => {
    const error = classifyGitFailure({ stderr: "fatal: something new happened\n", code: 1 });
    expect(error.code).toBe("unknown");
    expect(error.message).toBe("something new happened");
    expect(error.recoverable).toBe(true);
    expect(error.fix).toBeUndefined();
  });

  it("never returns an empty message", () => {
    const error = classifyGitFailure({ stderr: "", code: 3 });
    expect(error.message).toBe("git exited with code 3");
  });

  it("names a timeout before any stderr pattern", () => {
    const error = classifyGitFailure({
      stderr: "fatal: Authentication failed for 'https://x'",
      code: 1,
      timedOut: true,
      durationMs: 120_000,
    });
    expect(error.code).toBe("timeout");
    expect(error.message).toBe("git timed out after 120 s.");
    expect(error.fix).toMatch(/did not answer in time/i);
    expect(error.recoverable).toBe(true);
  });

  it("still says it timed out when the duration is unknown", () => {
    const error = classifyGitFailure({ timedOut: true });
    expect(error.code).toBe("timeout");
    expect(error.message).toBe("git timed out before it answered.");
  });

  it("strips git's level prefixes and skips hint lines", () => {
    expect(firstGitLine("hint: see git help\nfatal: real problem\n")).toBe("real problem");
    expect(firstGitLine("error: bad thing")).toBe("bad thing");
    expect(firstGitLine(undefined)).toBe("");
  });
});

describe("status presentation", () => {
  it("maps every status to a letter and a tone", () => {
    expect(gitStatusLetter("modified")).toBe("M");
    expect(gitStatusLetter("added")).toBe("A");
    expect(gitStatusLetter("deleted")).toBe("D");
    expect(gitStatusLetter("renamed")).toBe("R");
    expect(gitStatusLetter("copied")).toBe("C");
    expect(gitStatusLetter("untracked")).toBe("U");
    expect(gitStatusLetter("conflicted")).toBe("!");
    expect(gitStatusTone("untracked")).toBe("ok");
    expect(gitStatusTone("deleted")).toBe("danger");
    expect(gitStatusTone("modified")).toBe("warn");
  });

  it("describes head, empty and detached repositories", () => {
    const base = {
      root: "/repo",
      gitDir: "/repo/.git",
      branch: "main",
      head: "abcdef1234",
      detached: false,
      empty: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      remotes: [],
      identity: null,
    };
    expect(describeGitHead(undefined)).toBe("no repository");
    expect(describeGitHead(base)).toBe("main");
    expect(describeGitHead({ ...base, empty: true })).toBe("main (no commits yet)");
    expect(describeGitHead({ ...base, detached: true })).toBe("detached at abcdef1");
    expect(describeGitHead({ ...base, upstream: "origin/main", ahead: 2, behind: 1 })).toBe(
      "main ↑2 ↓1",
    );
    expect(describeGitHead({ ...base, upstream: "origin/main", ahead: 0, behind: 3 })).toBe(
      "main ↓3",
    );
  });
});

describe("sanitizeGitSnapshot", () => {
  const repo = {
    root: "/repo",
    gitDir: "/repo/.git",
    branch: "main",
    head: "abcdef1234567890",
    detached: false,
    empty: false,
    upstream: "origin/main",
    ahead: 1,
    behind: 0,
    remotes: ["origin"],
    identity: { name: "Ada", email: "ada@example.com", source: "global" },
  };

  it("keeps a well-formed snapshot", () => {
    const snapshot = sanitizeGitSnapshot({
      projectPath: "/repo",
      available: true,
      repo,
      staged: [{ path: "a.ts", status: "modified", staged: true, unstaged: false }],
      changed: [{ path: "b.ts", status: "untracked", staged: false, unstaged: true }],
      totalChanged: 2,
      fetchedAt: "2026-10-27T00:00:00.000Z",
    });
    expect(snapshot.available).toBe(true);
    expect(snapshot.repo?.branch).toBe("main");
    expect(snapshot.staged).toHaveLength(1);
    expect(snapshot.changed).toHaveLength(1);
    expect(snapshot.totalChanged).toBe(2);
  });

  it("turns an available snapshot without a repo into an honest not_a_repo", () => {
    const snapshot = sanitizeGitSnapshot({ projectPath: "/x", available: true });
    expect(snapshot.available).toBe(false);
    expect(snapshot.reason).toBe("not_a_repo");
    expect(snapshot.message).toMatch(/not a git repository/i);
  });

  it("keeps a declared reason and fills in its message", () => {
    const snapshot = sanitizeGitSnapshot({
      projectPath: "/x",
      available: false,
      reason: "git_missing",
    });
    expect(snapshot.reason).toBe("git_missing");
    expect(snapshot.message).toMatch(/not installed/i);
  });

  it("keeps a timeout reason and fills in its message", () => {
    const snapshot = sanitizeGitSnapshot({
      projectPath: "/x",
      available: false,
      reason: "timeout",
    });
    expect(snapshot.reason).toBe("timeout");
    expect(snapshot.message).toMatch(/did not answer/i);
  });

  it("drops unsafe files and preserves the cap", () => {
    const snapshot = sanitizeGitSnapshot({
      projectPath: "/repo",
      available: true,
      repo,
      changed: [
        { path: "../escape.ts", status: "modified", staged: false, unstaged: true },
        { path: "ok.ts", status: "modified", staged: false, unstaged: true },
      ],
      fetchedAt: "2026-10-27T00:00:00.000Z",
    });
    expect(snapshot.changed.map((file) => file.path)).toEqual(["ok.ts"]);
  });

  it("caps a hostile file list", () => {
    const changed = Array.from({ length: MAX_STATUS_PATHS + 50 }, (_, index) => ({
      path: `f${index}.ts`,
      status: "modified",
      staged: false,
      unstaged: true,
    }));
    const snapshot = sanitizeGitSnapshot({ projectPath: "/repo", available: true, repo, changed });
    expect(snapshot.changed).toHaveLength(MAX_STATUS_PATHS);
  });

  it("keeps only a well-formed identity", () => {
    const snapshot = sanitizeGitSnapshot({
      projectPath: "/repo",
      available: true,
      repo: { ...repo, identity: { name: "Ada", email: "bad", source: "repo" } },
    });
    expect(snapshot.repo?.identity).toBeNull();
  });

  it("drops an operation error without a message", () => {
    const snapshot = sanitizeGitSnapshot({
      projectPath: "/repo",
      available: true,
      repo,
      error: { code: "conflict" },
    });
    expect(snapshot.error).toBeUndefined();
  });
});

describe("emptyGitSnapshot", () => {
  it("is unavailable with a message", () => {
    const snapshot = emptyGitSnapshot("/x", "git_missing");
    expect(snapshot.available).toBe(false);
    expect(snapshot.reason).toBe("git_missing");
    expect(snapshot.message).toMatch(/not installed/i);
    expect(snapshot.staged).toEqual([]);
    expect(hasStagedChanges(snapshot)).toBe(false);
  });
});

describe("action classification", () => {
  it("marks only the network verbs", () => {
    expect(isNetworkGitAction("pull")).toBe(true);
    expect(isNetworkGitAction("push")).toBe(true);
    expect(isNetworkGitAction("fetch")).toBe(true);
    expect(isNetworkGitAction("commit")).toBe(false);
    expect(isNetworkGitAction("stage")).toBe(false);
    // The list is the one source for the sync UI and the lifecycle feedback.
    expect([...GIT_NETWORK_ACTIONS].sort()).toEqual(["fetch", "pull", "push"]);
  });
});

describe("identity validation", () => {
  it("accepts a normal name and email", () => {
    expect(sanitizeIdentityName("Ada Lovelace")).toBe("Ada Lovelace");
    expect(sanitizeIdentityName("  Ada   Lovelace ")).toBe("Ada Lovelace");
    expect(sanitizeIdentityEmail("ada@example.com")).toBe("ada@example.com");
  });

  it("refuses config-breaking values", () => {
    expect(sanitizeIdentityName("Ada\nLovelace")).toBeNull();
    expect(sanitizeIdentityName("a".repeat(121))).toBeNull();
    expect(sanitizeIdentityEmail("ada@example")).toBeNull();
    expect(sanitizeIdentityEmail("ada @example.com")).toBeNull();
    expect(sanitizeIdentityEmail("a@b@c.com")).toBeNull();
  });
});

describe("commit message validation", () => {
  it("trims trailing whitespace but keeps internal structure", () => {
    expect(sanitizeCommitMessage("  subject\n\nbody\n\n")).toBe("  subject\n\nbody");
  });

  it("bounds the length", () => {
    const message = sanitizeCommitMessage("x".repeat(50_000));
    expect(message).not.toBeNull();
    expect(message?.length).toBeLessThanOrEqual(20_000);
  });
});

describe("sha validation", () => {
  it("accepts only a full lowercase sha", () => {
    expect(isFullSha("a".repeat(40))).toBe(true);
    expect(isFullSha("A".repeat(40))).toBe(false);
    expect(isFullSha("a".repeat(39))).toBe(false);
    expect(isFullSha("a".repeat(41))).toBe(false);
    expect(isFullSha(undefined)).toBe(false);
  });
});
