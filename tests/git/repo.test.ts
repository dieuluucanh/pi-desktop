import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initRepository, isRepository, readIdentity, readRepo } from "../../src/git/repo";
import { createFakeGitRunner, createNodeGitRunner, type FakeGitSpec } from "../../src/git/runner";
import { gitFixture, type GitFixture } from "./fixture";

/**
 * Repository discovery (git-checkpoint plan step 3).
 *
 * Two layers: the fake runner proves the *questions* (which commands, in what
 * order, and how each answer is interpreted), and a real repository proves the
 * answers are shaped the way git actually prints them.
 */

const TOP = "/repo\n";

/** A `stat`-backed folder probe, the shape `readRepo` expects in production. */
async function pathKind(target: string): Promise<"file" | "directory" | null> {
  try {
    const info = await stat(target);
    return info.isDirectory() ? "directory" : "file";
  } catch {
    return null;
  }
}

describe("readRepo with a fake runner", () => {
  function runnerFor(
    overrides: Record<string, string | { code: number; stdout?: string; stderr?: string }> = {},
  ) {
    const defaults: Record<string, string | { code: number; stdout?: string; stderr?: string }> = {
      "rev-parse --show-toplevel": TOP,
      "rev-parse --is-inside-work-tree": "true\n",
      "rev-parse --absolute-git-dir": "/repo/.git\n",
      "symbolic-ref --short HEAD": "main\n",
      "rev-parse --short HEAD": "abc1234\n",
      "rev-parse --abbrev-ref --symbolic-full-name @{upstream}": "origin/main\n",
      remote: "origin\nupstream\n",
      "rev-list --left-right --count @{upstream}...HEAD": "2\t3\n",
      "config --get user.name": "Ada\n",
      "config --get user.email": "ada@example.com\n",
      "config --local --get user.name": "",
      "config --global --get user.name": "Ada\n",
      "config --system --get user.name": "",
    };
    const specs: FakeGitSpec[] = Object.entries({ ...defaults, ...overrides }).map(
      ([key, value]) => {
        const args = key.split(" ");
        return typeof value === "string" ? { args, stdout: value } : { args, ...value };
      },
    );
    return createFakeGitRunner(specs);
  }

  it("reads a healthy repository", async () => {
    const result = await readRepo(runnerFor(), "/repo");
    expect(result.available).toBe(true);
    expect(result.repo).toEqual({
      root: "/repo",
      gitDir: "/repo/.git",
      branch: "main",
      head: "abc1234",
      detached: false,
      empty: false,
      upstream: "origin/main",
      ahead: 3,
      behind: 2,
      remotes: ["origin", "upstream"],
      identity: { name: "Ada", email: "ada@example.com", source: "global" },
    });
  });

  it("reports a missing git binary", async () => {
    const runner = createFakeGitRunner([{ args: ["rev-parse", "--show-toplevel"], missing: true }]);
    const result = await readRepo(runner, "/repo");
    expect(result.available).toBe(false);
    expect(result.reason).toBe("git_missing");
  });

  it("reports a plain folder as not_a_repo", async () => {
    const runner = createFakeGitRunner([
      { args: ["rev-parse", "--show-toplevel"], code: 128, stderr: "fatal: not a git repository" },
      { args: ["rev-parse", "--is-bare-repository"], stdout: "false\n" },
    ]);
    const result = await readRepo(runner, "/docs");
    expect(result.available).toBe(false);
    expect(result.reason).toBe("not_a_repo");
    expect(result.detail).toMatch(/not a git repository/);
  });

  it("distinguishes a bare repository", async () => {
    const runner = createFakeGitRunner([
      { args: ["rev-parse", "--show-toplevel"], code: 128 },
      { args: ["rev-parse", "--is-bare-repository"], stdout: "true\n" },
    ]);
    const result = await readRepo(runner, "/srv/repo.git");
    expect(result.reason).toBe("bare_repo");
  });

  it("reports a missing folder without asking git", async () => {
    const runner = createFakeGitRunner([]);
    const result = await readRepo(runner, "/gone", {
      pathKind: async () => null,
    });
    expect(result.reason).toBe("no_folder");
    expect(runner.calls).toEqual([]);
  });

  it("reports an in-flight merge", async () => {
    const runner = createFakeGitRunner([
      { args: ["rev-parse", "--show-toplevel"], stdout: TOP },
      { args: ["rev-parse", "--is-inside-work-tree"], stdout: "true\n" },
      { args: ["rev-parse", "--absolute-git-dir"], stdout: "/repo/.git\n" },
      {
        args: ["rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"],
        stdout: "/repo/.git/MERGE_HEAD\n",
      },
      { args: ["symbolic-ref", "--short", "HEAD"], stdout: "main\n" },
      { args: ["rev-parse", "--short", "HEAD"], stdout: "abc1234\n" },
    ]);
    const result = await readRepo(runner, "/repo", {
      pathKind: async (target) => {
        // The work tree itself must look like a directory; only MERGE_HEAD exists.
        if (target === "/repo") return "directory";
        return target.endsWith("MERGE_HEAD") ? "file" : null;
      },
    });
    expect(result.available).toBe(false);
    expect(result.reason).toBe("operation_in_progress");
    expect(result.detail).toMatch(/merge/);
  });

  it("does not claim an operation when it has no folder probe", async () => {
    const runner = runnerFor();
    const result = await readRepo(runner, "/repo");
    // The marker probe is skipped without `pathKind`, so the repo reads normally.
    expect(result.available).toBe(true);
  });

  it("handles an empty repository (no commits)", async () => {
    const runner = createFakeGitRunner([
      { args: ["rev-parse", "--show-toplevel"], stdout: TOP },
      { args: ["rev-parse", "--is-inside-work-tree"], stdout: "true\n" },
      { args: ["rev-parse", "--absolute-git-dir"], stdout: "/repo/.git\n" },
      { args: ["symbolic-ref", "--short", "HEAD"], stdout: "main\n" },
      { args: ["rev-parse", "--short", "HEAD"], code: 128, stderr: "fatal: ambiguous argument" },
      { args: ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], code: 128 },
      { args: ["remote"], stdout: "" },
      { args: ["config", "--get", "user.name"], code: 1 },
      { args: ["config", "--get", "user.email"], code: 1 },
    ]);
    const result = await readRepo(runner, "/repo");
    expect(result.available).toBe(true);
    expect(result.repo?.empty).toBe(true);
    expect(result.repo?.head).toBeNull();
    expect(result.repo?.detached).toBe(false);
    expect(result.repo?.upstream).toBeNull();
    expect(result.repo?.ahead).toBe(0);
    expect(result.repo?.identity).toBeNull();
  });

  it("handles a detached head", async () => {
    const runner = createFakeGitRunner([
      { args: ["rev-parse", "--show-toplevel"], stdout: TOP },
      { args: ["rev-parse", "--is-inside-work-tree"], stdout: "true\n" },
      { args: ["rev-parse", "--absolute-git-dir"], stdout: "/repo/.git\n" },
      {
        args: ["symbolic-ref", "--short", "HEAD"],
        code: 1,
        stderr: "fatal: ref HEAD is not a symbolic ref",
      },
      { args: ["rev-parse", "--short", "HEAD"], stdout: "deadbee\n" },
      { args: ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], code: 128 },
      { args: ["remote"], stdout: "" },
      { args: ["config", "--get", "user.name"], code: 1 },
    ]);
    const result = await readRepo(runner, "/repo");
    expect(result.repo?.branch).toBeNull();
    expect(result.repo?.detached).toBe(true);
    expect(result.repo?.head).toBe("deadbee");
  });

  it("reports a timeout as timeout with a detail", async () => {
    const runner = createFakeGitRunner([
      { args: ["rev-parse", "--show-toplevel"], timedOut: true, code: 1 },
    ]);
    const result = await readRepo(runner, "/repo");
    expect(result.reason).toBe("timeout");
    expect(result.detail).toMatch(/timed out/);
  });
});

describe("identity config level", () => {
  it("reports repo-local when the local config supplies it", async () => {
    const runner = createFakeGitRunner([
      { args: ["config", "--get", "user.name"], stdout: "Local\n" },
      { args: ["config", "--get", "user.email"], stdout: "local@example.com\n" },
      { args: ["config", "--local", "--get", "user.name"], stdout: "Local\n" },
    ]);
    const identity = await readIdentity(runner, "/repo");
    expect(identity?.source).toBe("repo");
  });

  it("reports global when only the global config supplies it", async () => {
    const runner = createFakeGitRunner([
      { args: ["config", "--get", "user.name"], stdout: "Ada\n" },
      { args: ["config", "--get", "user.email"], stdout: "ada@example.com\n" },
      { args: ["config", "--local", "--get", "user.name"], code: 1 },
      { args: ["config", "--global", "--get", "user.name"], stdout: "Ada\n" },
    ]);
    expect((await readIdentity(runner, "/repo"))?.source).toBe("global");
  });

  it("falls back to unknown when no scope claims the value", async () => {
    const runner = createFakeGitRunner([
      { args: ["config", "--get", "user.name"], stdout: "Ada\n" },
      { args: ["config", "--get", "user.email"], stdout: "ada@example.com\n" },
      { args: ["config", "--local", "--get", "user.name"], code: 1 },
      { args: ["config", "--global", "--get", "user.name"], code: 1 },
      { args: ["config", "--system", "--get", "user.name"], code: 1 },
    ]);
    expect((await readIdentity(runner, "/repo"))?.source).toBe("unknown");
  });

  it("returns null when the identity is incomplete", async () => {
    const runner = createFakeGitRunner([
      { args: ["config", "--get", "user.name"], stdout: "Ada\n" },
      { args: ["config", "--get", "user.email"], code: 1 },
    ]);
    expect(await readIdentity(runner, "/repo")).toBeNull();
  });
});

describe("initRepository", () => {
  it("reports success", async () => {
    const runner = createFakeGitRunner([{ args: ["init"], stdout: "Initialized\n" }]);
    expect(await initRepository(runner, "/repo")).toEqual({ ok: true });
  });

  it("reports a missing git binary", async () => {
    const runner = createFakeGitRunner([{ args: ["init"], missing: true }]);
    const result = await initRepository(runner, "/repo");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not installed/);
  });

  it("surfaces git's own failure message", async () => {
    const runner = createFakeGitRunner([
      { args: ["init"], code: 128, stderr: "fatal: cannot create /repo: permission denied" },
    ]);
    const result = await initRepository(runner, "/repo");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/permission denied/);
  });
});

describe("readRepo against a real repository", () => {
  let fixture: GitFixture;

  beforeAll(async () => {
    fixture = await gitFixture();
  });

  afterAll(async () => {
    await fixture?.cleanup();
  });

  it("reads the real work tree, branch, head and identity", async () => {
    if (fixture.skipReason) return;
    const runner = createNodeGitRunner();
    const result = await readRepo(runner, fixture.root, { pathKind });
    expect(result.available).toBe(true);
    expect(result.repo?.branch).toBe("main");
    expect(result.repo?.detached).toBe(false);
    expect(result.repo?.empty).toBe(false);
    expect(result.repo?.head).toMatch(/^[0-9a-f]{7,}$/);
    expect(result.repo?.identity?.name).toBe("Fixture Author");
    expect(result.repo?.identity?.source).toBe("repo");
    expect(result.repo?.upstream).toBeNull();
    expect(result.repo?.ahead).toBe(0);
    expect(result.repo?.behind).toBe(0);
    expect(await isRepository(runner, fixture.root)).toBe(true);
  });

  it("reads a subdirectory as the same repository", async () => {
    if (fixture.skipReason) return;
    await fixture.write("nested/deep/file.txt", "x\n");
    const runner = createNodeGitRunner();
    const result = await readRepo(runner, join(fixture.root, "nested", "deep"), { pathKind });
    expect(result.available).toBe(true);
    // `rev-parse --show-toplevel` reports the work-tree root, not the cwd.
    expect(resolve(result.repo?.root ?? "")).toBe(resolve(fixture.root));
  });

  it("reports a plain folder as not_a_repo", async () => {
    if (fixture.skipReason) return;
    const plain = await mkdtemp(join(tmpdir(), "pi-desktop-plain-"));
    try {
      const runner = createNodeGitRunner();
      const result = await readRepo(runner, plain);
      expect(result.available).toBe(false);
      expect(result.reason).toBe("not_a_repo");
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it("initialises a repository on request", async () => {
    if (fixture.skipReason) return;
    const target = await mkdtemp(join(tmpdir(), "pi-desktop-init-"));
    try {
      const runner = createNodeGitRunner();
      expect(await isRepository(runner, target)).toBe(false);
      expect(await initRepository(runner, target)).toEqual({ ok: true });
      expect(await isRepository(runner, target)).toBe(true);
      const result = await readRepo(runner, target);
      expect(result.repo?.empty).toBe(true);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("reports a merge in progress", async () => {
    if (fixture.skipReason) return;
    const isolated = await gitFixture();
    if (isolated.skipReason) return;
    try {
      await isolated.write("README.md", "base\n");
      await isolated.git(["add", "README.md"]);
      await isolated.git(["commit", "-m", "base"]);
      await isolated.git(["checkout", "-b", "side"]);
      await isolated.write("README.md", "side\n");
      await isolated.git(["commit", "-am", "side"]);
      await isolated.git(["checkout", "main"]);
      await isolated.write("README.md", "main\n");
      await isolated.git(["commit", "-am", "main"]);
      // The merge conflicts, which leaves MERGE_HEAD behind.
      await isolated.tryGit(["merge", "side"]);
      expect(await isolated.exists(".git/MERGE_HEAD")).toBe(true);

      const runner = createNodeGitRunner();
      const result = await readRepo(runner, isolated.root, { pathKind });
      expect(result.available).toBe(false);
      expect(result.reason).toBe("operation_in_progress");
      expect(result.detail).toMatch(/merge/);
    } finally {
      await isolated.cleanup();
    }
  });
});
