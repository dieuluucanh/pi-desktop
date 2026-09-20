import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALWAYS_IGNORED,
  DEFAULT_FILE_LIMIT,
  listWorkspaceFiles,
  type DirectoryEntry,
  type FileListingIo,
} from "../../src/host/file-listing";
import { createNodeFileListingIo } from "../../src/host/file-io";

/**
 * Workspace listing for `@` completion (plan step 7). Two paths are covered: the
 * git fast path (exact ignore semantics, one process) and the pruning walk that
 * runs when git is absent. Both must skip `.git`/`node_modules`, respect
 * `.gitignore` and admit when they truncated.
 */

/** An in-memory tree: keys are relative paths, values are file contents. */
function fakeIo(
  files: Record<string, string>,
  options: { gitOutput?: string | null } = {},
): FileListingIo {
  const directories = new Map<string, Map<string, boolean>>();
  const ensure = (dir: string): Map<string, boolean> => {
    let entry = directories.get(dir);
    if (!entry) {
      entry = new Map();
      directories.set(dir, entry);
    }
    return entry;
  };
  ensure("");
  for (const path of Object.keys(files)) {
    const segments = path.split("/");
    let prefix = "";
    segments.forEach((segment, index) => {
      const isFile = index === segments.length - 1;
      ensure(prefix).set(segment, !isFile);
      prefix = prefix.length === 0 ? segment : `${prefix}/${segment}`;
      if (!isFile) ensure(prefix);
    });
  }

  const relativeOf = (target: string): string =>
    target.replace(/^\/root\/?/, "").replace(/\/+$/, "");

  return {
    async readDirectory(directory: string): Promise<DirectoryEntry[]> {
      const entries = directories.get(relativeOf(directory));
      if (!entries) return [];
      return [...entries.entries()].map(([name, directoryFlag]) => ({
        name,
        directory: directoryFlag,
      }));
    },
    async readTextFile(target: string): Promise<string | null> {
      return files[relativeOf(target)] ?? null;
    },
    ...(options.gitOutput === undefined ? {} : { runGit: async () => options.gitOutput ?? null }),
  };
}

describe("walk (no git)", () => {
  it("lists files relative to the root, sorted, skipping .git and node_modules", async () => {
    const io = fakeIo({
      "src/app.ts": "",
      "src/nested/deep.ts": "",
      "README.md": "",
      ".git/config": "",
      "node_modules/left-pad/index.js": "",
    });
    const result = await listWorkspaceFiles(io, "/root");
    expect(result).toEqual({
      files: ["README.md", "src/app.ts", "src/nested/deep.ts"],
      truncated: false,
    });
    expect(ALWAYS_IGNORED).toContain(".git");
    expect(ALWAYS_IGNORED).toContain("node_modules");
  });

  it("honours a root .gitignore, including negation and directory rules", async () => {
    const io = fakeIo({
      ".gitignore": "dist/\n*.log\n!keep.log\n",
      "dist/out.js": "",
      "debug.log": "",
      "keep.log": "",
      "src/index.ts": "",
    });
    const result = await listWorkspaceFiles(io, "/root");
    expect(result.files).toEqual([".gitignore", "keep.log", "src/index.ts"]);
  });

  it("honours a nested .gitignore only inside its own directory", async () => {
    const io = fakeIo({
      "app/.gitignore": "generated/\n",
      "app/generated/x.ts": "",
      "app/real.ts": "",
      "other/generated/y.ts": "",
    });
    const result = await listWorkspaceFiles(io, "/root");
    expect(result.files).toEqual(["app/.gitignore", "app/real.ts", "other/generated/y.ts"]);
  });

  it("truncates at the limit and says so", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 25; index += 1) files[`file-${index}.ts`] = "";
    const result = await listWorkspaceFiles(fakeIo(files), "/root", { limit: 10 });
    expect(result.files).toHaveLength(10);
    expect(result.truncated).toBe(true);
    expect(result.files[0]).toBe("file-0.ts");
  });

  it("does not claim truncation when the tree is exactly the limit", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 10; index += 1) files[`file-${index}.ts`] = "";
    const result = await listWorkspaceFiles(fakeIo(files), "/root", { limit: 10 });
    expect(result.files).toHaveLength(10);
    expect(result.truncated).toBe(false);
  });

  it("defaults to a bounded limit", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < DEFAULT_FILE_LIMIT + 5; index += 1) files[`f${index}.ts`] = "";
    const result = await listWorkspaceFiles(fakeIo(files), "/root");
    expect(result.files).toHaveLength(DEFAULT_FILE_LIMIT);
    expect(result.truncated).toBe(true);
  });
});

describe("git fast path", () => {
  it("parses -z output and drops always-ignored segments", async () => {
    const io = fakeIo(
      {},
      { gitOutput: "src/app.ts\0node_modules/dep/index.js\0README.md\0.git/config\0" },
    );
    const result = await listWorkspaceFiles(io, "/root");
    expect(result.files).toEqual(["README.md", "src/app.ts"]);
    expect(result.truncated).toBe(false);
  });

  it("falls back to the walk when git answers null (no repo, no git)", async () => {
    const io = fakeIo({ "src/app.ts": "", "tracked.ts": "" }, { gitOutput: null });
    const result = await listWorkspaceFiles(io, "/root");
    expect(result.files).toEqual(["src/app.ts", "tracked.ts"]);
  });

  it("accepts an empty repository as an empty listing, not a fallback", async () => {
    const io = fakeIo({ "ignored-by-the-walk.ts": "" }, { gitOutput: "" });
    const result = await listWorkspaceFiles(io, "/root");
    expect(result).toEqual({ files: [], truncated: false });
  });
});

describe("real filesystem (node adapter)", () => {
  const created: string[] = [];

  afterEach(async () => {
    while (created.length > 0) await rm(created.pop()!, { recursive: true, force: true });
  });

  it("lists a real repository the user would actually complete against", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-desktop-files-"));
    created.push(root);
    await mkdir(join(root, "src/main"), { recursive: true });
    await writeFile(join(root, "src/main/index.ts"), "export {};\n");
    await writeFile(join(root, "AGENTS.md"), "# rules\n");
    await writeFile(join(root, ".gitignore"), "secret.txt\n");
    await writeFile(join(root, "secret.txt"), "nope\n");
    await mkdir(join(root, "node_modules/pkg"), { recursive: true });
    await writeFile(join(root, "node_modules/pkg/index.js"), "");

    const result = await listWorkspaceFiles(createNodeFileListingIo(), root);
    // Not a git repo, so this exercises the walk through real fs calls.
    expect(result.files).toContain("src/main/index.ts");
    expect(result.files).toContain("AGENTS.md");
    expect(result.files).not.toContain("secret.txt");
    expect(result.files.some((file) => file.startsWith("node_modules"))).toBe(false);
    expect(result.truncated).toBe(false);
  });
});
