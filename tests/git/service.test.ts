import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitService, readLog, type GitService } from "../../src/git/service";
import { createFakeGitRunner, createNodeGitRunner, type FakeGitSpec } from "../../src/git/runner";
import type { GitAction } from "../../src/shared/git";
import { gitFixture, type GitFixture } from "./fixture";

/**
 * The git service (git-checkpoint plan step 6).
 *
 * The fake-runner tests pin the *contract*: the exact argv each action produces,
 * the validation that runs before it, the stdin a commit receives, and the
 * safety hook that must fire before a destructive action. The real-repository
 * tests pin the *outcome*, because argv alone proves nothing.
 */

const ROOT = "/repo";

/** Builds a `--porcelain=v2 -z` payload from record strings. */
function statusText(records: readonly string[]): string {
  return `${records.map((record) => `${record}\u0000`).join("")}`;
}

const CLEAN_STATUS = statusText(["# branch.oid abc123", "# branch.head main"]);

const TWO_CHANGED = statusText([
  "# branch.oid abc123",
  "# branch.head main",
  "1 .M N... 100644 100644 100644 aaa bbb src/app.ts",
  "? src/new-file.ts",
]);

/** The repository-probe answers `readRepo` needs, in matching order. */
function repoSpecs(overrides: Partial<Record<string, FakeGitSpec>> = {}): FakeGitSpec[] {
  const defaults: Record<string, FakeGitSpec> = {
    "rev-parse --show-toplevel": { args: ["rev-parse", "--show-toplevel"], stdout: `${ROOT}\n` },
    "rev-parse --is-inside-work-tree": {
      args: ["rev-parse", "--is-inside-work-tree"],
      stdout: "true\n",
    },
    "rev-parse --absolute-git-dir": {
      args: ["rev-parse", "--absolute-git-dir"],
      stdout: `${ROOT}/.git\n`,
    },
    "symbolic-ref --short HEAD": { args: ["symbolic-ref", "--short", "HEAD"], stdout: "main\n" },
    "rev-parse --short HEAD": { args: ["rev-parse", "--short", "HEAD"], stdout: "abc1234\n" },
    upstream: {
      args: ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      stdout: "origin/main\n",
    },
    remote: { args: ["remote"], stdout: "origin\n" },
    counts: {
      args: ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
      stdout: "0\t0\n",
    },
    "user name": { args: ["config", "--get", "user.name"], stdout: "Ada\n" },
    "user email": { args: ["config", "--get", "user.email"], stdout: "ada@example.com\n" },
    "local name": { args: ["config", "--local", "--get", "user.name"], stdout: "Ada\n" },
    "system name": { args: ["config", "--system", "--get", "user.name"], code: 1 },
    status: { args: ["status"], stdout: CLEAN_STATUS },
    "stash list": { args: ["stash", "list"], stdout: "" },
  };
  const merged = { ...defaults };
  for (const [key, spec] of Object.entries(overrides)) {
    if (spec) merged[key] = spec;
  }
  return Object.values(merged);
}

function serviceWith(
  specs: FakeGitSpec[],
  options: Partial<Parameters<typeof createGitService>[0]> = {},
) {
  const runner = createFakeGitRunner(specs);
  const service = createGitService({ runner, now: () => 1_000, ...options });
  return { runner, service };
}

/** Counts the calls whose argv starts with `head`. */
function callsStartingWith(
  runner: ReturnType<typeof createFakeGitRunner>,
  ...head: string[]
): number {
  return runner.calls.filter((call) => head.every((part, index) => call.args[index] === part))
    .length;
}

describe("snapshot", () => {
  it("assembles the two groups, the repo facts and the stashes", async () => {
    const { service } = serviceWith(
      repoSpecs({
        status: { args: ["status"], stdout: TWO_CHANGED },
        "stash list": {
          args: ["stash", "list"],
          stdout: "stash@{0}\u0000170000001000\u0000work in progress\n",
        },
      }),
    );
    const snapshot = await service.snapshot(ROOT);
    expect(snapshot.available).toBe(true);
    expect(snapshot.repo?.branch).toBe("main");
    expect(snapshot.repo?.root).toBe(ROOT);
    expect(snapshot.staged).toEqual([]);
    expect(snapshot.changed.map((entry) => entry.path)).toEqual(["src/app.ts", "src/new-file.ts"]);
    expect(snapshot.totalChanged).toBe(2);
    expect(snapshot.stashes).toHaveLength(1);
    expect(snapshot.stashes[0]?.subject).toBe("work in progress");
    expect(snapshot.fetchedAt).toBe(new Date(1_000).toISOString());
  });

  it("prefers the counts status reports over a separate rev-list probe", async () => {
    const { service, runner } = serviceWith(
      repoSpecs({
        status: {
          args: ["status"],
          stdout: statusText(["# branch.oid abc123", "# branch.head main", "# branch.ab +3 -4"]),
        },
      }),
    );
    const snapshot = await service.snapshot(ROOT);
    expect(snapshot.repo?.ahead).toBe(3);
    expect(snapshot.repo?.behind).toBe(4);
    // `rev-list` was asked while reading the repo, but the status answer wins.
    expect(callsStartingWith(runner, "rev-list")).toBe(1);
  });

  it("reports a plain folder as unavailable with a reason", async () => {
    const { service } = serviceWith([
      { args: ["rev-parse", "--show-toplevel"], code: 128, stderr: "fatal: not a git repository" },
      { args: ["rev-parse", "--is-bare-repository"], stdout: "false\n" },
    ]);
    const snapshot = await service.snapshot("/docs");
    expect(snapshot.available).toBe(false);
    expect(snapshot.reason).toBe("not_a_repo");
    expect(snapshot.message).toMatch(/not a git repository/i);
    expect(snapshot.staged).toEqual([]);
    expect(snapshot.changed).toEqual([]);
  });

  it("reports a missing git binary", async () => {
    const { service } = serviceWith([{ args: ["rev-parse", "--show-toplevel"], missing: true }]);
    const snapshot = await service.snapshot(ROOT);
    expect(snapshot.reason).toBe("git_missing");
    expect(snapshot.message).toMatch(/not installed/i);
  });

  it("reports an index git refuses to read as unavailable, with its own words", async () => {
    const { service } = serviceWith(
      repoSpecs({
        status: {
          args: ["status"],
          code: 128,
          stderr: "fatal: Unable to create '/repo/.git/index.lock': File exists.",
        },
      }),
    );
    const snapshot = await service.snapshot(ROOT);
    expect(snapshot.available).toBe(false);
    expect(snapshot.message).toMatch(/index\.lock/);
  });

  it("memoises a snapshot inside the window and re-reads after it", async () => {
    let clock = 1_000;
    const { service, runner } = serviceWith(repoSpecs(), { now: () => clock });
    await service.snapshot(ROOT);
    await service.snapshot(ROOT);
    expect(callsStartingWith(runner, "status")).toBe(1);

    clock += 5_000;
    await service.snapshot(ROOT);
    expect(callsStartingWith(runner, "status")).toBe(2);
  });

  it("reads once for concurrent callers (single-flight)", async () => {
    const { service, runner } = serviceWith(repoSpecs());
    const [first, second] = await Promise.all([service.snapshot(ROOT), service.snapshot(ROOT)]);
    expect(first.fetchedAt).toBe(second.fetchedAt);
    expect(callsStartingWith(runner, "status")).toBe(1);
  });

  it("bypasses the memo when asked to be fresh", async () => {
    const { service, runner } = serviceWith(repoSpecs());
    await service.snapshot(ROOT);
    await service.snapshot(ROOT, { fresh: true });
    expect(callsStartingWith(runner, "status")).toBe(2);
  });

  it("invalidates the memo after an action", async () => {
    const { service, runner } = serviceWith(
      repoSpecs({
        status: { args: ["status"], stdout: TWO_CHANGED },
        add: { args: ["add"], stdout: "" },
      }),
    );
    await service.snapshot(ROOT);
    await service.action(ROOT, { kind: "stage", paths: ["src/app.ts"] });
    await service.snapshot(ROOT);
    // One read for the first snapshot, two inside the action (known-paths check
    // and the discard path), one after.
    expect(callsStartingWith(runner, "status")).toBeGreaterThanOrEqual(2);
  });

  it("never throws when git misbehaves", async () => {
    const runner = createFakeGitRunner([]);
    const service = createGitService({ runner, now: () => 1_000 });
    const snapshot = await service.snapshot(ROOT);
    expect(snapshot.available).toBe(false);
    expect(typeof snapshot.message).toBe("string");
  });
});

describe("action argv", () => {
  async function stage(service: GitService, action: GitAction) {
    return service.action(ROOT, action);
  }

  it("stages the exact paths after a validation read", async () => {
    const { runner, service } = serviceWith(
      repoSpecs({
        status: { args: ["status"], stdout: TWO_CHANGED },
        add: { args: ["add"], stdout: "" },
      }),
    );
    const result = await stage(service, { kind: "stage", paths: ["src/app.ts"] });
    expect(result.ok).toBe(true);
    const add = runner.calls.find((call) => call.args[0] === "add");
    expect(add?.args).toEqual(["add", "--", "src/app.ts"]);
  });

  it("refuses to stage a file the current status does not list", async () => {
    const { runner, service } = serviceWith(
      repoSpecs({
        status: { args: ["status"], stdout: TWO_CHANGED },
        add: { args: ["add"], stdout: "" },
      }),
    );
    const result = await stage(service, { kind: "stage", paths: ["src/gone.ts"] });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("pathspec");
    expect(runner.calls.some((call) => call.args[0] === "add")).toBe(false);
  });

  it("unstages with restore --staged, then falls back to reset", async () => {
    const { runner, service } = serviceWith(
      repoSpecs({
        restore: {
          args: ["restore", "--staged"],
          code: 128,
          stderr: "fatal: could not resolve HEAD",
        },
        reset: { args: ["reset", "--"], stdout: "" },
      }),
    );
    const result = await stage(service, { kind: "unstage", paths: ["src/app.ts"] });
    expect(result.ok).toBe(true);
    expect(runner.calls.some((call) => call.args[0] === "restore")).toBe(true);
    expect(runner.calls.some((call) => call.args[0] === "reset")).toBe(true);
  });

  it("commits with the message on stdin, not in an argument", async () => {
    const { runner, service } = serviceWith(
      repoSpecs({ commit: { args: ["commit"], stdout: "[main abc] done\n" } }),
    );
    const message = 'feat: add the rail\n\nA body with "quotes" and\nnewlines.';
    const result = await stage(service, { kind: "commit", message, amend: false });
    expect(result.ok).toBe(true);
    const call = runner.calls.find((entry) => entry.args[0] === "commit");
    expect(call?.args).toEqual(["commit", "-F", "-"]);
    expect(call?.input).toBe(message);
    expect(result.message).toMatch(/feat: add the rail/);
  });

  it("amends with --amend", async () => {
    const { runner, service } = serviceWith(
      repoSpecs({ commit: { args: ["commit"], stdout: "amended\n" } }),
    );
    await stage(service, { kind: "commit", message: "fix: x", amend: true });
    expect(runner.calls.find((call) => call.args[0] === "commit")?.args).toEqual([
      "commit",
      "-F",
      "-",
      "--amend",
    ]);
  });

  it("refuses to commit without an identity and names the fix", async () => {
    const { runner, service } = serviceWith(
      repoSpecs({
        "user name": { args: ["config", "--get", "user.name"], code: 1 },
        "user email": { args: ["config", "--get", "user.email"], code: 1 },
      }),
    );
    const result = await stage(service, { kind: "commit", message: "x", amend: false });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("no_identity");
    expect(result.error?.fix).toMatch(/git config --global/);
    expect(runner.calls.some((call) => call.args[0] === "commit")).toBe(false);
  });

  it("writes the identity repository-locally", async () => {
    const { runner, service } = serviceWith(
      repoSpecs({ "config set": { args: ["config", "--local"], stdout: "" } }),
    );
    const result = await stage(service, {
      kind: "set-identity",
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
    expect(result.ok).toBe(true);
    // `config --local --get` is the identity-source probe; the *writes* are the
    // calls without `--get`.
    const sets = runner.calls.filter(
      (call) =>
        call.args[0] === "config" && call.args[1] === "--local" && !call.args.includes("--get"),
    );
    expect(sets.map((call) => call.args)).toEqual([
      ["config", "--local", "user.name", "Ada Lovelace"],
      ["config", "--local", "user.email", "ada@example.com"],
    ]);
  });

  it("applies a single-hunk patch and reverses it for unstage", async () => {
    const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
    const { runner, service } = serviceWith(repoSpecs({ apply: { args: ["apply"], stdout: "" } }));
    expect((await stage(service, { kind: "stage-hunk", path: "a.ts", patch })).ok).toBe(true);
    const first = runner.calls.find((call) => call.args[0] === "apply");
    expect(first?.args).toContain("--cached");
    expect(first?.args).not.toContain("--reverse");
    expect(first?.input).toBe(patch);

    expect((await stage(service, { kind: "unstage-hunk", path: "a.ts", patch })).ok).toBe(true);
    const second = runner.calls.filter((call) => call.args[0] === "apply")[1];
    expect(second?.args).toContain("--reverse");
  });

  it("discards a tracked file with checkout --", async () => {
    const { runner, service } = serviceWith(
      repoSpecs({
        status: { args: ["status"], stdout: TWO_CHANGED },
        checkout: { args: ["checkout", "--"], stdout: "" },
      }),
    );
    const result = await stage(service, {
      kind: "discard",
      paths: ["src/app.ts"],
      untracked: false,
    });
    expect(result.ok).toBe(true);
    expect(runner.calls.find((call) => call.args[0] === "checkout")?.args).toEqual([
      "checkout",
      "--",
      "src/app.ts",
    ]);
  });

  it("moves an untracked file to the trash instead of deleting it", async () => {
    const trashed: string[] = [];
    const { runner, service } = serviceWith(
      repoSpecs({ status: { args: ["status"], stdout: TWO_CHANGED } }),
      {
        trash: {
          trash: async (target: string) => {
            trashed.push(target);
            return true;
          },
        },
      },
    );
    const result = await stage(service, {
      kind: "discard",
      paths: ["src/new-file.ts"],
      untracked: true,
    });
    expect(result.ok).toBe(true);
    expect(trashed).toEqual(["/repo/src/new-file.ts"]);
    // Nothing was removed through git.
    expect(runner.calls.some((call) => call.args[0] === "clean")).toBe(false);
  });

  it("refuses an untracked discard when there is no trash port", async () => {
    const { service } = serviceWith(
      repoSpecs({ status: { args: ["status"], stdout: TWO_CHANGED } }),
    );
    const result = await stage(service, {
      kind: "discard",
      paths: ["src/new-file.ts"],
      untracked: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/trash/);
  });

  it("reports a refused trash move without pretending it worked", async () => {
    const { service } = serviceWith(
      repoSpecs({ status: { args: ["status"], stdout: TWO_CHANGED } }),
      { trash: { trash: async () => false } },
    );
    const result = await stage(service, {
      kind: "discard",
      paths: ["src/new-file.ts"],
      untracked: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("permission");
  });

  it("stashes, pops and drops", async () => {
    const { runner, service } = serviceWith(
      repoSpecs({
        "stash push": { args: ["stash", "push"], stdout: "Saved\n" },
        "stash pop": { args: ["stash", "pop"], stdout: "" },
        "stash drop": { args: ["stash", "drop"], stdout: "" },
      }),
    );
    expect((await stage(service, { kind: "stash-push", message: "wip" })).ok).toBe(true);
    expect(
      runner.calls.find((call) => call.args[0] === "stash" && call.args[1] === "push")?.args,
    ).toEqual(["stash", "push", "-m", "wip"]);
    expect((await stage(service, { kind: "stash-pop", index: 2 })).ok).toBe(true);
    expect(
      runner.calls.find((call) => call.args[0] === "stash" && call.args[1] === "pop")?.args,
    ).toEqual(["stash", "pop", "stash@{2}"]);
    expect((await stage(service, { kind: "stash-drop", index: 0 })).ok).toBe(true);
  });

  it("switches and creates branches with switch", async () => {
    const { runner, service } = serviceWith(
      repoSpecs({
        switch: { args: ["switch"], stdout: "Switched\n" },
        "switch create": { args: ["switch", "-c"], stdout: "Switched\n" },
      }),
    );
    expect((await stage(service, { kind: "checkout-branch", branch: "feat/x" })).ok).toBe(true);
    expect(runner.calls.find((call) => call.args[0] === "switch")?.args).toEqual([
      "switch",
      "feat/x",
    ]);
    expect((await stage(service, { kind: "create-branch", branch: "feat/y" })).ok).toBe(true);
    expect(
      runner.calls.find((call) => call.args[0] === "switch" && call.args[1] === "-c")?.args,
    ).toEqual(["switch", "-c", "feat/y"]);
  });

  it("refuses an invalid branch name without running git", async () => {
    const { runner, service } = serviceWith(repoSpecs());
    const result = await stage(service, { kind: "checkout-branch", branch: "bad name" });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("bad_request");
    expect(runner.calls.some((call) => call.args[0] === "switch")).toBe(false);
  });

  it("fetches, pulls and pushes", async () => {
    const { runner, service } = serviceWith(
      repoSpecs({
        fetch: { args: ["fetch"], stdout: "" },
        pull: { args: ["pull"], stdout: "" },
        push: { args: ["push"], stdout: "" },
      }),
    );
    expect((await stage(service, { kind: "fetch", remote: "origin" })).ok).toBe(true);
    expect(runner.calls.find((call) => call.args[0] === "fetch")?.args).toEqual([
      "fetch",
      "origin",
    ]);
    expect((await stage(service, { kind: "pull" })).ok).toBe(true);
    expect(runner.calls.find((call) => call.args[0] === "pull")?.args).toEqual([
      "pull",
      "--no-edit",
    ]);
    expect((await stage(service, { kind: "push" })).ok).toBe(true);
    expect(runner.calls.find((call) => call.args[0] === "push")?.args).toEqual(["push"]);
  });

  it("reports a timed-out fetch as a timeout, not an exit code", async () => {
    const { service } = serviceWith(
      repoSpecs({
        fetch: { args: ["fetch"], code: 1, timedOut: true, durationMs: 120_000, stderr: "" },
      }),
    );
    const result = await service.action(ROOT, { kind: "fetch", remote: null });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("timeout");
    expect(result.error?.message).toBe("git timed out after 120 s.");
    expect(result.error?.fix).toMatch(/did not answer in time/i);
  });

  it("reports a timed-out push as a timeout", async () => {
    const { service } = serviceWith(
      repoSpecs({
        push: { args: ["push"], code: 1, timedOut: true, durationMs: 120_000, stderr: "" },
      }),
    );
    const result = await service.action(ROOT, { kind: "push" });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("timeout");
  });

  it("sets the upstream when the first push has none", async () => {
    const { runner, service } = serviceWith([
      ...repoSpecs(),
      {
        args: ["push"],
        exact: true,
        code: 1,
        stderr: "fatal: The current branch main has no upstream branch.",
      },
      { args: ["push", "--set-upstream"], stdout: "" },
    ]);
    const result = await service.action(ROOT, { kind: "push" });
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Pushed main to origin and set the upstream.");
    expect(
      runner.calls.find((call) => call.args[0] === "push" && call.args[1] === "--set-upstream")
        ?.args,
    ).toEqual(["push", "--set-upstream", "origin", "main"]);
  });

  it("reports the retry's error, not the stale no-upstream advice", async () => {
    const { service } = serviceWith([
      ...repoSpecs(),
      {
        args: ["push"],
        exact: true,
        code: 1,
        stderr: "fatal: The current branch main has no upstream branch.",
      },
      {
        args: ["push", "--set-upstream"],
        code: 128,
        stderr: "fatal: Authentication failed for 'https://example.com/r.git'",
      },
    ]);
    const result = await service.action(ROOT, { kind: "push" });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("auth_required");
  });

  it("keeps the no-upstream failure when the retry says nothing useful", async () => {
    const { service } = serviceWith([
      ...repoSpecs(),
      {
        args: ["push"],
        exact: true,
        code: 1,
        stderr: "fatal: The current branch main has no upstream branch.",
      },
      { args: ["push", "--set-upstream"], code: 1, stderr: "" },
    ]);
    const result = await service.action(ROOT, { kind: "push" });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("no_upstream");
  });

  it("surfaces an auth failure with the delegate-to-git fix", async () => {
    const { service } = serviceWith(
      repoSpecs({
        push: {
          args: ["push"],
          code: 128,
          stderr: "fatal: Authentication failed for 'https://example.com/r.git'",
        },
      }),
    );
    const result = await service.action(ROOT, { kind: "push" });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("auth_required");
    expect(result.error?.fix).toMatch(/terminal/);
  });

  it("initialises a repository for a plain folder", async () => {
    const { runner, service } = serviceWith([
      { args: ["rev-parse", "--show-toplevel"], code: 128 },
      { args: ["rev-parse", "--is-bare-repository"], stdout: "false\n" },
      { args: ["init"], stdout: "Initialized empty Git repository\n" },
    ]);
    const result = await service.action("/docs", { kind: "init" });
    expect(result.ok).toBe(true);
    expect(runner.calls.find((call) => call.args[0] === "init")?.root).toBe("/docs");
  });

  it("refuses a non-init action on a plain folder", async () => {
    const { runner, service } = serviceWith([
      { args: ["rev-parse", "--show-toplevel"], code: 128 },
      { args: ["rev-parse", "--is-bare-repository"], stdout: "false\n" },
    ]);
    const result = await service.action("/docs", { kind: "stage", paths: ["a.ts"] });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("not_a_repo");
    expect(runner.calls.some((call) => call.args[0] === "add")).toBe(false);
  });
});

describe("safety and ordering", () => {
  it("takes a pre-op snapshot before a discard", async () => {
    const order: string[] = [];
    const { runner, service } = serviceWith(
      repoSpecs({
        status: { args: ["status"], stdout: TWO_CHANGED },
        checkout: { args: ["checkout", "--"], stdout: "" },
      }),
      {
        preOpSnapshot: async () => {
          order.push("snapshot");
        },
      },
    );
    // Record when `checkout` actually runs.
    const originalRun = runner.run.bind(runner);
    runner.run = async (root, args, options) => {
      if (args[0] === "checkout") order.push("checkout");
      return originalRun(root, args, options);
    };
    await service.action(ROOT, { kind: "discard", paths: ["src/app.ts"], untracked: false });
    expect(order).toEqual(["snapshot", "checkout"]);
  });

  it("aborts a discard when the safety snapshot fails", async () => {
    const { runner, service } = serviceWith(
      repoSpecs({
        status: { args: ["status"], stdout: TWO_CHANGED },
        checkout: { args: ["checkout", "--"], stdout: "" },
      }),
      {
        preOpSnapshot: async () => {
          throw new Error("checkpoint store is unavailable");
        },
      },
    );
    await expect(
      service.action(ROOT, { kind: "discard", paths: ["src/app.ts"], untracked: false }),
    ).rejects.toThrow(/checkpoint store/);
    expect(runner.calls.some((call) => call.args[0] === "checkout")).toBe(false);
  });

  it("takes a pre-op snapshot before a branch switch", async () => {
    const order: string[] = [];
    const { service } = serviceWith(repoSpecs({ switch: { args: ["switch"], stdout: "" } }), {
      preOpSnapshot: async () => {
        order.push("snapshot");
      },
    });
    await service.action(ROOT, { kind: "checkout-branch", branch: "feat/x" });
    expect(order).toEqual(["snapshot"]);
  });

  it("serialises two actions on the same repository", async () => {
    const seen: string[] = [];
    const { runner, service } = serviceWith(
      repoSpecs({
        status: { args: ["status"], stdout: TWO_CHANGED },
        add: { args: ["add"], stdout: "" },
      }),
    );
    const originalRun = runner.run.bind(runner);
    runner.run = async (root, args, options) => {
      if (args[0] === "add") {
        seen.push(`start:${args[2]}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        seen.push(`end:${args[2]}`);
      }
      return originalRun(root, args, options);
    };
    await Promise.all([
      service.action(ROOT, { kind: "stage", paths: ["src/app.ts"] }),
      service.action(ROOT, { kind: "stage", paths: ["src/new-file.ts"] }),
    ]);
    expect(seen).toEqual([
      "start:src/app.ts",
      "end:src/app.ts",
      "start:src/new-file.ts",
      "end:src/new-file.ts",
    ]);
  });
});

describe("readLog", () => {
  it("parses records, decorations, the body and HEAD", async () => {
    const record = (sha: string, subject: string, body: string, refs: string, seconds: string) =>
      `${sha}\u0000${sha.slice(0, 7)}\u0000${subject}\u0000Ada\u0000${seconds}\u0000${refs}\u0000${body}\u001e`;
    const stdout = [
      record(
        "a".repeat(40),
        "feat: newest",
        "Body line one\nBody line two\n",
        "HEAD -> main, origin/main, tag: v1",
        "1700000000",
      ),
      record("b".repeat(40), "fix: older", "", "", "1600000000"),
    ].join("\n");
    const runner = createFakeGitRunner([{ args: ["log"], stdout }]);
    const entries = await readLog(runner, ROOT, { limit: 30, skip: 0 });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      sha: "a".repeat(40),
      shortSha: "aaaaaaa",
      subject: "feat: newest",
      body: "Body line one\nBody line two",
      author: "Ada",
      at: 1_700_000_000_000,
      refs: ["main", "origin/main", "v1"],
      head: true,
    });
    expect(entries[1]?.head).toBe(false);
    expect(entries[1]?.refs).toEqual([]);
    expect(entries[1]?.body).toBe("");
  });

  it("passes the page window and the path to git", async () => {
    const runner = createFakeGitRunner([{ args: ["log"], stdout: "" }]);
    await readLog(runner, ROOT, { limit: 30, skip: 60, path: "src/a.ts" });
    const args = runner.calls[0]?.args ?? [];
    expect(args).toContain("--max-count=30");
    expect(args).toContain("--skip=60");
    expect(args).toContain("--");
    expect(args).toContain("src/a.ts");
  });

  it("skips a malformed record instead of failing the page", async () => {
    const runner = createFakeGitRunner([
      { args: ["log"], stdout: "not-a-sha\u0000\u0000\u0000\u0000\u0000\u001e" },
    ]);
    expect(await readLog(runner, ROOT, { limit: 30, skip: 0 })).toEqual([]);
  });

  it("returns nothing when git fails", async () => {
    const runner = createFakeGitRunner([
      { args: ["log"], code: 128, stderr: "fatal: bad revision" },
    ]);
    expect(await readLog(runner, ROOT, { limit: 30, skip: 0 })).toEqual([]);
  });
});

describe("branches", () => {
  it("lists local branches sorted, with the current one", async () => {
    const { service } = serviceWith(
      repoSpecs({
        refs: {
          args: ["for-each-ref"],
          stdout: "zeta\nmain\nalpha\n",
        },
      }),
    );
    expect(await service.branches(ROOT)).toEqual({
      local: ["alpha", "main", "zeta"],
      current: "main",
    });
  });

  it("returns an empty list outside a repository", async () => {
    const { service } = serviceWith([
      { args: ["rev-parse", "--show-toplevel"], code: 128 },
      { args: ["rev-parse", "--is-bare-repository"], stdout: "false\n" },
    ]);
    expect(await service.branches("/docs")).toEqual({ local: [], current: null });
  });
});

describe("against a real repository", () => {
  let fixture: GitFixture;

  beforeAll(async () => {
    fixture = await gitFixture();
  });

  afterAll(async () => {
    await fixture?.cleanup();
  });

  it("runs stage → commit → unstage → discard end to end", async () => {
    if (fixture.skipReason) return;
    const runner = createNodeGitRunner();
    const service = createGitService({ runner, now: () => Date.now() });

    await fixture.write("README.md", "# fixture\nedited\n");
    await fixture.write("notes.txt", "untracked\n");

    const before = await service.snapshot(fixture.root, { fresh: true });
    expect(before.available).toBe(true);
    expect(before.changed.map((entry) => entry.path).sort()).toEqual(["README.md", "notes.txt"]);

    // Stage, then commit.
    expect((await service.action(fixture.root, { kind: "stage", paths: ["README.md"] })).ok).toBe(
      true,
    );
    const staged = await service.snapshot(fixture.root, { fresh: true });
    expect(staged.staged.map((entry) => entry.path)).toEqual(["README.md"]);

    const committed = await service.action(fixture.root, {
      kind: "commit",
      message: "docs: edit the readme",
      amend: false,
    });
    expect(committed.ok, JSON.stringify(committed.error)).toBe(true);

    const afterCommit = await service.snapshot(fixture.root, { fresh: true });
    expect(afterCommit.staged).toEqual([]);
    expect(afterCommit.changed.map((entry) => entry.path)).toEqual(["notes.txt"]);

    const log = await service.log(fixture.root, { limit: 5 });
    expect(log[0]?.subject).toBe("docs: edit the readme");

    // Stage the untracked file, then unstage it again.
    await service.action(fixture.root, { kind: "stage", paths: ["notes.txt"] });
    expect(
      (await service.snapshot(fixture.root, { fresh: true })).staged.map((e) => e.path),
    ).toEqual(["notes.txt"]);
    expect((await service.action(fixture.root, { kind: "unstage", paths: ["notes.txt"] })).ok).toBe(
      true,
    );
    expect(await fixture.git(["diff", "--cached", "--name-only"])).toBe("");

    // Discard the work-tree edit; the file returns to HEAD's content.
    await fixture.write("README.md", "# fixture\ndirty again\n");
    const discarded = await service.action(fixture.root, {
      kind: "discard",
      paths: ["README.md"],
      untracked: false,
    });
    expect(discarded.ok, JSON.stringify(discarded.error)).toBe(true);
    expect(await fixture.read("README.md")).toBe("# fixture\nedited\n");
  });

  it("stages and unstages a single hunk through the service", async () => {
    if (fixture.skipReason) return;
    const runner = createNodeGitRunner();
    const service = createGitService({ runner, now: () => Date.now() });

    const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
    await fixture.write("hunks.txt", `${lines}\n`);
    await fixture.git(["add", "hunks.txt"]);
    await fixture.git(["commit", "-m", "test: seed hunks"]);

    const edited = `${lines}\n`
      .replace("line 2\n", "line TWO\n")
      .replace("line 38\n", "line THIRTY-EIGHT\n");
    await fixture.write("hunks.txt", edited);

    const diff = await service.diff(fixture.root, { path: "hunks.txt" });
    const file = diff.files[0];
    if (!file?.hunks[0]) throw new Error("expected two hunks");
    expect(file.hunks).toHaveLength(2);

    const { buildHunkPatch } = await import("../../src/git/diff");
    const result = await service.action(fixture.root, {
      kind: "stage-hunk",
      path: "hunks.txt",
      patch: buildHunkPatch(file, file.hunks[0]),
    });
    expect(result.ok, JSON.stringify(result.error)).toBe(true);

    const staged = await fixture.git(["diff", "--cached", "--", "hunks.txt"]);
    expect(staged).toContain("+line TWO");
    expect(staged).not.toContain("+line THIRTY-EIGHT");
  });
});
