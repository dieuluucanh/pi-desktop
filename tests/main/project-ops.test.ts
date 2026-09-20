import { normalize } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createProjectOps, repoNameFromUrl, validateProjectName } from "../../src/main/project-ops";
import { createMemoryFsPort } from "../../src/main/fs-port";
import { createFakeCommandRunner } from "../../src/main/office/exec";

const PARENT = "C:/work";

function harness(
  options: {
    dirs?: readonly string[];
    runner?: ReturnType<typeof createFakeCommandRunner>;
  } = {},
) {
  const fs = createMemoryFsPort({ dirs: options.dirs ?? [PARENT] });
  const runner =
    options.runner ??
    createFakeCommandRunner([
      { command: "git", args: ["--version"], stdout: "git version 2.45.0\n" },
      { command: "git", args: ["init"], stdout: "Initialized empty Git repository\n" },
    ]);
  const ops = createProjectOps({
    fs,
    runner,
    reveal: vi.fn(() => true),
    openTerminal: vi.fn(async () => true),
    copyText: vi.fn(async () => true),
    join: (...parts) => parts.join("/"),
  });
  return { fs, runner, ops };
}

describe("validateProjectName", () => {
  it("accepts a plain folder name", () => {
    expect(validateProjectName("pi-desktop")).toBeNull();
    expect(validateProjectName("  my.app  ")).toBeNull();
  });

  it("rejects separators, traversal, Windows-reserved characters and trailing dots", () => {
    expect(validateProjectName("")).toMatch(/required/);
    expect(validateProjectName("..")).toMatch(/not a valid/);
    expect(validateProjectName("a/b")).toMatch(/separator/);
    expect(validateProjectName("a\\b")).toMatch(/separator/);
    expect(validateProjectName("a:b")).toMatch(/cannot contain/);
    expect(validateProjectName("app.")).toMatch(/dot or a space/);
    expect(validateProjectName("x".repeat(200))).toMatch(/at most/);
    expect(validateProjectName(`bad${String.fromCharCode(7)}name`)).toMatch(/control/);
  });
});

describe("repoNameFromUrl", () => {
  it("derives the folder name from every supported URL shape", () => {
    expect(repoNameFromUrl("https://github.com/user/pi-desktop.git")).toBe("pi-desktop");
    expect(repoNameFromUrl("git@github.com:user/pi-desktop.git")).toBe("pi-desktop");
    expect(repoNameFromUrl("ssh://git@host/user/repo")).toBe("repo");
    expect(repoNameFromUrl("C:/repos/local-app/")).toBe("local-app");
  });
});

describe("createBlank", () => {
  it("creates the folder without git when gitInit is off", async () => {
    const { ops, fs, runner } = harness();

    const result = await ops.createBlank({ parentDir: PARENT, name: "new-app" });

    expect(result).toEqual({ ok: true, path: `${PARENT}/new-app` });
    expect(fs.dirs.has(normalize(`${PARENT}/new-app`))).toBe(true);
    expect(runner.calls).toEqual([]);
  });

  it("runs git init inside the new folder", async () => {
    const { ops, runner } = harness();

    const result = await ops.createBlank({ parentDir: PARENT, name: "repo", gitInit: true });

    expect(result.ok).toBe(true);
    expect(runner.calls).toEqual([
      { command: "git", args: ["--version"] },
      { command: "git", args: ["init"], cwd: `${PARENT}/repo` },
    ]);
  });

  it("refuses before creating anything when git is missing", async () => {
    const runner = createFakeCommandRunner([
      { command: "git", args: ["--version"], missing: true, code: 127 },
    ]);
    const { ops, fs } = harness({ runner });

    const result = await ops.createBlank({ parentDir: PARENT, name: "repo", gitInit: true });

    expect(result).toMatchObject({ ok: false, path: null });
    expect(result.error).toMatch(/git is not installed/);
    expect(fs.dirs.has(normalize(`${PARENT}/repo`))).toBe(false);
  });

  it("refuses a missing parent, an existing target and an invalid name", async () => {
    const { ops } = harness({ dirs: [PARENT, `${PARENT}/taken`] });

    expect((await ops.createBlank({ parentDir: "C:/nope", name: "x" })).error).toMatch(
      /not an existing folder/,
    );
    expect((await ops.createBlank({ parentDir: PARENT, name: "taken" })).error).toMatch(
      /already exists/,
    );
    expect((await ops.createBlank({ parentDir: PARENT, name: "../escape" })).error).toMatch(
      /separator/,
    );
  });

  it("surfaces a failing git init", async () => {
    const runner = createFakeCommandRunner([
      { command: "git", args: ["--version"], stdout: "git version 2.45.0\n" },
      { command: "git", args: ["init"], code: 1, stderr: "fatal: cannot create directory\n" },
    ]);
    const { ops } = harness({ runner });

    const result = await ops.createBlank({ parentDir: PARENT, name: "repo", gitInit: true });
    expect(result.error).toMatch(/cannot create directory/);
  });
});

describe("cloneRepo", () => {
  it("clones into the derived folder name", async () => {
    const runner = createFakeCommandRunner([
      { command: "git", args: ["clone"], stdout: "Cloning into 'pi-desktop'...\n" },
    ]);
    const { ops, fs } = harness({ runner });

    const result = await ops.cloneRepo({
      parentDir: PARENT,
      url: "https://github.com/user/pi-desktop.git",
    });

    expect(result).toEqual({ ok: true, path: `${PARENT}/pi-desktop` });
    expect(runner.calls).toEqual([
      {
        command: "git",
        args: ["clone", "https://github.com/user/pi-desktop.git", `${PARENT}/pi-desktop`],
        cwd: PARENT,
      },
    ]);
    // The fake runner does not create the folder; the op reports what git did.
    expect(fs.dirs.has(normalize(`${PARENT}/pi-desktop`))).toBe(false);
  });

  it("honours an explicit name", async () => {
    const runner = createFakeCommandRunner([{ command: "git", args: ["clone"], stdout: "" }]);
    const { ops } = harness({ runner });

    const result = await ops.cloneRepo({
      parentDir: PARENT,
      url: "https://github.com/user/pi-desktop.git",
      name: "desktop-fork",
    });
    expect(result.path).toBe(`${PARENT}/desktop-fork`);
  });

  it("refuses a dangerous URL, a missing destination and an existing target", async () => {
    const { ops } = harness({ dirs: [PARENT, `${PARENT}/repo`] });

    expect((await ops.cloneRepo({ parentDir: PARENT, url: "--upload-pack=evil" })).error).toMatch(
      /enter a git URL/,
    );
    expect(
      (await ops.cloneRepo({ parentDir: PARENT, url: "https://x/y.git", name: "repo" })).error,
    ).toMatch(/already exists/);
    expect(
      (await ops.cloneRepo({ parentDir: "C:/missing", url: "https://x/y.git" })).error,
    ).toMatch(/not an existing folder/);
  });

  it("surfaces git's own error and a missing git binary", async () => {
    const failing = createFakeCommandRunner([
      { command: "git", args: ["clone"], code: 128, stderr: "fatal: repository not found\n" },
    ]);
    expect(
      (
        await harness({ runner: failing }).ops.cloneRepo({
          parentDir: PARENT,
          url: "https://x/y.git",
        })
      ).error,
    ).toMatch(/repository not found/);

    const missing = createFakeCommandRunner([
      { command: "git", args: ["clone"], missing: true, code: 127 },
    ]);
    expect(
      (
        await harness({ runner: missing }).ops.cloneRepo({
          parentDir: PARENT,
          url: "https://x/y.git",
        })
      ).error,
    ).toMatch(/git is not installed/);
  });
});

describe("actions", () => {
  it("routes reveal, terminal and copy-path to their ports", async () => {
    const fs = createMemoryFsPort({ dirs: [PARENT] });
    const reveal = vi.fn(() => true);
    const openTerminal = vi.fn(async () => true);
    const copyText = vi.fn(async () => true);
    const ops = createProjectOps({
      fs,
      runner: createFakeCommandRunner([]),
      reveal,
      openTerminal,
      copyText,
    });

    expect(await ops.action(PARENT, "reveal")).toBe(true);
    expect(await ops.action(PARENT, "terminal")).toBe(true);
    expect(await ops.action(PARENT, "copy-path")).toBe(true);
    expect(reveal).toHaveBeenCalledWith(PARENT);
    expect(openTerminal).toHaveBeenCalledWith(PARENT);
    expect(copyText).toHaveBeenCalledWith(PARENT);
  });

  it("rejects an empty path", async () => {
    const { ops } = harness();
    expect(await ops.action("   ", "reveal")).toBe(false);
  });
});
