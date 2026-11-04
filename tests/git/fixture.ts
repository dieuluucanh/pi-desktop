/**
 * A real git repository fixture for the engine tests.
 *
 * `src/git/**` is unit-tested against the fake runner for argv shape, but the
 * parsers (`status --porcelain=v2 -z`, `diff`, `log`) are only trustworthy
 * against bytes git actually wrote. This helper creates a throw-away repository
 * in the OS temp directory, so a test asserts the format rather than our idea of
 * it.
 *
 * When the machine has no `git` on PATH, {@link gitFixture} resolves and each
 * test skips itself via `fixture.skipReason` — the same guard
 * `tests/office/detect.live.test.ts` uses. Nothing here is imported by
 * production code.
 */

import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitFixture {
  /** Absolute path of the work tree. */
  root: string;
  /** Runs git in the fixture and returns stdout; throws on a non-zero exit. */
  git(args: readonly string[], options?: { cwd?: string }): Promise<string>;
  /** Runs git and returns the raw result (never throws). */
  tryGit(
    args: readonly string[],
    options?: { cwd?: string },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Writes a UTF-8 file (creating parents). Returns its relative path. */
  write(relativePath: string, contents: string): Promise<string>;
  /** Writes raw bytes, for the binary/Office case. */
  writeBytes(relativePath: string, bytes: Uint8Array): Promise<string>;
  /** Reads a UTF-8 file. */
  read(relativePath: string): Promise<string>;
  /** True when the relative path exists in the work tree. */
  exists(relativePath: string): Promise<boolean>;
  /** Removes the fixture directory. */
  cleanup(): Promise<void>;
  /** Non-null when the fixture could not be created (no git, no temp dir). */
  skipReason: string | null;
}

/** The env every fixture git call uses: deterministic, no hooks, no signing. */
const FIXTURE_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "Fixture Author",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture Author",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00+0000",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00+0000",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

/** True when a `git` executable answers. */
export async function hasGit(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"], { timeout: 10_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a repository with one commit (`README.md`), `main` checked out, and a
 * repository-local identity so a commit never depends on the machine's config.
 */
export async function gitFixture(): Promise<GitFixture> {
  const skipReason = (await hasGit())
    ? null
    : "git is not installed on this machine; the real-repository tests skip";

  const base = await mkdtemp(join(tmpdir(), "pi-desktop-git-"));
  const root = skipReason ? base : join(base, "repo");
  if (!skipReason) await mkdir(root, { recursive: true });

  const run = (
    args: readonly string[],
    cwd = root,
  ): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn("git", [...args], {
        cwd,
        windowsHide: true,
        env: { ...process.env, ...FIXTURE_ENV },
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", () => resolve({ code: 127, stdout: "", stderr: "git is missing" }));
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });

  const fixture: GitFixture = {
    root,
    skipReason,
    async git(args, options) {
      const result = await run(args, options?.cwd ?? root);
      if (result.code !== 0) {
        throw new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr}`);
      }
      return result.stdout;
    },
    tryGit(args, options) {
      return run(args, options?.cwd ?? root);
    },
    async write(relativePath, contents) {
      const target = join(root, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents, "utf8");
      return relativePath;
    },
    async writeBytes(relativePath, bytes) {
      const target = join(root, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      return relativePath;
    },
    async read(relativePath) {
      return readFile(join(root, relativePath), "utf8");
    },
    async exists(relativePath) {
      try {
        await stat(join(root, relativePath));
        return true;
      } catch {
        return false;
      }
    },
    async cleanup() {
      const { rm } = await import("node:fs/promises");
      await rm(base, { recursive: true, force: true }).catch(() => undefined);
    },
  };

  if (!skipReason) {
    await run(["init", "-b", "main"]);
    await run(["config", "user.name", "Fixture Author"]);
    await run(["config", "user.email", "fixture@example.com"]);
    await run(["config", "commit.gpgsign", "false"]);
    // A Windows git install often defaults `autocrlf` to true, which would rewrite
    // every checked-out file with CRLF and make a byte comparison platform
    // dependent. Tests assert bytes; pin the conversion off.
    await run(["config", "core.autocrlf", "false"]);
    await run(["config", "core.hooksPath", join(base, "no-hooks")]);
    await fixture.write("README.md", "# fixture\n");
    await run(["add", "README.md"]);
    await run(["commit", "-m", "chore: initial commit"]);
  }

  return fixture;
}

/**
 * A second repository bolted onto the same parent, for the "one snapshot per
 * project, two sessions" concurrency test.
 */
export async function siblingRepo(parent: GitFixture, name: string): Promise<string> {
  const target = join(parent.root, "..", name);
  await mkdir(target, { recursive: true });
  await parent.git(["init", "-b", "main"], { cwd: target });
  return target;
}
