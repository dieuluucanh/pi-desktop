import { describe, expect, it } from "vitest";
import {
  BASE_GIT_ARGS,
  createFakeGitRunner,
  createNodeGitRunner,
  GIT_ENV,
  MAX_GIT_BUFFER_BYTES,
} from "../../src/git/runner";

/**
 * The git runner (git-checkpoint plan step 2).
 *
 * The Node adapter is exercised with a *real* child process (`process.execPath`
 * with `baseArgs: []`), so stdin, timeouts and ENOENT are tested against the
 * kernel rather than a mock. The fake runner is tested separately because the
 * engine's tests depend on its matching rules being right.
 */

const NODE = process.execPath;

function nodeRunner() {
  return createNodeGitRunner({ executable: NODE, baseArgs: [] });
}

describe("createNodeGitRunner", () => {
  it("captures stdout, stderr and the exit code", async () => {
    const runner = nodeRunner();
    const result = await runner.run(
      process.cwd(),
      ["-e", "process.stdout.write('out');process.stderr.write('err');process.exit(3)"],
      { timeoutMs: 10_000 },
    );
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
    expect(result.code).toBe(3);
    expect(result.missing).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.cwd).toBe(process.cwd());
    expect(result.args[0]).toBe("-e");
  });

  it("writes the input to stdin and closes it", async () => {
    const runner = nodeRunner();
    const result = await runner.run(
      process.cwd(),
      [
        "-e",
        "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write('['+s+']'))",
      ],
      { input: "line one\nline two\n", timeoutMs: 10_000 },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("[line one\nline two\n]");
  });

  it("closes stdin when no input is given, so a reader does not hang", async () => {
    const runner = nodeRunner();
    const result = await runner.run(
      process.cwd(),
      ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('closed'))"],
      { timeoutMs: 10_000 },
    );
    expect(result.stdout).toBe("closed");
  });

  it("reports a missing executable as a value, never a rejection", async () => {
    const runner = createNodeGitRunner({
      executable: "pi-desktop-no-such-git-binary",
      baseArgs: [],
    });
    const result = await runner.run(process.cwd(), ["--version"]);
    expect(result.missing).toBe(true);
    expect(result.code).toBe(127);
  });

  it("kills a command that runs past its timeout", async () => {
    const runner = nodeRunner();
    const started = Date.now();
    const result = await runner.run(process.cwd(), ["-e", "setTimeout(()=>{}, 60000)"], {
      timeoutMs: 150,
    });
    const elapsed = Date.now() - started;
    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(10_000);
  });

  it("merges extra env over the process env without dropping PATH", async () => {
    const runner = nodeRunner();
    const result = await runner.run(
      process.cwd(),
      ["-e", "process.stdout.write(String(process.env.PI_DESKTOP_TEST_VAR))"],
      { env: { PI_DESKTOP_TEST_VAR: "yes" }, timeoutMs: 10_000 },
    );
    expect(result.stdout).toBe("yes");
  });

  it("bounds a runaway stream instead of growing without limit", async () => {
    const runner = createNodeGitRunner({
      executable: NODE,
      baseArgs: [],
      maxBufferBytes: 1000,
    });
    const result = await runner.run(
      process.cwd(),
      ["-e", "process.stdout.write('x'.repeat(50000))"],
      { timeoutMs: 10_000 },
    );
    expect(result.stdout.length).toBeLessThanOrEqual(1000);
    expect(result.code).toBe(0);
  });
});

describe("production defaults", () => {
  it("pins the flags that keep the app out of the user's way", () => {
    expect(BASE_GIT_ARGS).toContain("--no-optional-locks");
    expect(BASE_GIT_ARGS).toContain("color.ui=false");
    expect(BASE_GIT_ARGS).toContain("core.quotepath=false");
  });

  it("never lets git prompt, page or open an editor", () => {
    expect(GIT_ENV.GIT_TERMINAL_PROMPT).toBe("0");
    expect(GIT_ENV.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(GIT_ENV.GIT_EDITOR).toBe(":");
    expect(GIT_ENV.GIT_PAGER).toBe("cat");
    // An empty askpass makes git fall through to its error path rather than a GUI.
    expect(GIT_ENV.GIT_ASKPASS).toBe("");
  });

  it("uses a 16 MB stream cap", () => {
    expect(MAX_GIT_BUFFER_BYTES).toBe(16 * 1024 * 1024);
  });

  it("runs real git when it is available", async () => {
    const runner = createNodeGitRunner();
    const result = await runner.run(process.cwd(), ["--version"], { timeoutMs: 20_000 });
    if (result.missing) {
      // The test machine has no git; the missing-binary behaviour is the thing
      // under test, and it is asserted directly above.
      expect(result.code).toBe(127);
      return;
    }
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^git version /);
    // Git exits non-zero on an unknown `-c` key, so a successful run proves the
    // base flags are acceptable to the real binary.
    expect(result.args).toEqual(["--version"]);
  });
});

describe("createFakeGitRunner", () => {
  it("matches a prefix by default and records the call", async () => {
    const runner = createFakeGitRunner([
      { args: ["rev-parse", "--show-toplevel"], stdout: "/repo\n" },
    ]);
    const result = await runner.run("/repo/sub", ["rev-parse", "--show-toplevel"]);
    expect(result.stdout).toBe("/repo\n");
    expect(result.code).toBe(0);
    expect(runner.calls).toEqual([{ root: "/repo/sub", args: ["rev-parse", "--show-toplevel"] }]);
  });

  it("prefers the first matching spec", async () => {
    const runner = createFakeGitRunner([
      { args: ["status"], stdout: "first" },
      { args: ["status"], stdout: "second" },
    ]);
    const result = await runner.run("/repo", ["status", "--porcelain=v2"]);
    expect(result.stdout).toBe("first");
  });

  it("records stdin so a commit message can be asserted", async () => {
    const runner = createFakeGitRunner([{ args: ["commit", "-F", "-"] }]);
    await runner.run("/repo", ["commit", "-F", "-"], { input: "feat: x\n" });
    expect(runner.calls[0]?.input).toBe("feat: x\n");
  });

  it("fails loudly when a call has no spec", async () => {
    const runner = createFakeGitRunner([]);
    const result = await runner.run("/repo", ["push"]);
    expect(result.missing).toBe(true);
    expect(result.stderr).toMatch(/no fake git spec for: git push/);
  });

  it("scopes a spec to a repository by cwd suffix", async () => {
    const runner = createFakeGitRunner([
      { args: ["rev-parse"], cwdSuffix: "/b", stdout: "b\n" },
      { args: ["rev-parse"], cwdSuffix: "/a", stdout: "a\n" },
    ]);
    expect((await runner.run("/work/a", ["rev-parse"])).stdout).toBe("a\n");
    expect((await runner.run("/work/b", ["rev-parse"])).stdout).toBe("b\n");
  });

  it("honours an exact match and a declared failure", async () => {
    const runner = createFakeGitRunner([
      { args: ["status"], exact: true, stdout: "exact" },
      { args: ["push"], code: 1, stderr: "! [rejected] main -> main (fetch first)" },
    ]);
    expect((await runner.run("/r", ["status"])).stdout).toBe("exact");
    expect((await runner.run("/r", ["status", "-z"])).code).toBe(127);
    const push = await runner.run("/r", ["push"]);
    expect(push.code).toBe(1);
    expect(push.stderr).toMatch(/rejected/);
  });
});
