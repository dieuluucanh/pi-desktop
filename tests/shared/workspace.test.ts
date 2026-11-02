import { describe, expect, it } from "vitest";

import {
  MAX_DIRECTORY_ENTRIES,
  MAX_EDITOR_READ_BYTES,
  MAX_EDITOR_WRITE_BYTES,
  MAX_QUICK_OPEN_FILES,
  MAX_WORKSPACE_PATH_LENGTH,
  isWorkspaceRelativePath,
  sameWorkspacePath,
  sortWorkspaceEntries,
  workspaceBasename,
  workspaceDirname,
  workspaceFailure,
  workspaceJoin,
  workspaceOk,
  type WorkspaceEntry,
} from "../../src/shared/workspace";

function entry(overrides: Partial<WorkspaceEntry> & Pick<WorkspaceEntry, "name">): WorkspaceEntry {
  return {
    path: overrides.name,
    kind: "file",
    size: 1,
    mtimeMs: 1,
    hidden: false,
    ignored: false,
    symlink: false,
    outside: false,
    ...overrides,
  };
}

describe("isWorkspaceRelativePath", () => {
  it("accepts project-relative POSIX paths", () => {
    expect(isWorkspaceRelativePath("src/app.ts")).toBe(true);
    expect(isWorkspaceRelativePath(".env")).toBe(true);
    expect(isWorkspaceRelativePath("a.b/c-d_e.ts")).toBe(true);
    expect(isWorkspaceRelativePath("file")).toBe(true);
  });

  it("rejects escapes and platform-specific forms", () => {
    expect(isWorkspaceRelativePath("../outside.ts")).toBe(false);
    expect(isWorkspaceRelativePath("src/../outside.ts")).toBe(false);
    expect(isWorkspaceRelativePath("/etc/passwd")).toBe(false);
    expect(isWorkspaceRelativePath("C:/Windows/system.ini")).toBe(false);
    expect(isWorkspaceRelativePath("C:\\Windows\\system.ini")).toBe(false);
    expect(isWorkspaceRelativePath("src\\app.ts")).toBe(false);
    expect(isWorkspaceRelativePath("a//b")).toBe(false);
    expect(isWorkspaceRelativePath("./a")).toBe(false);
    expect(isWorkspaceRelativePath("a/./b")).toBe(false);
    expect(isWorkspaceRelativePath("a/")).toBe(false);
    expect(isWorkspaceRelativePath("")).toBe(false);
  });

  it("rejects .git in any case and control characters", () => {
    expect(isWorkspaceRelativePath(".git/config")).toBe(false);
    expect(isWorkspaceRelativePath(".GIT/config")).toBe(false);
    expect(isWorkspaceRelativePath("src/.git/config")).toBe(true);
    expect(isWorkspaceRelativePath("a\u0000b")).toBe(false);
    expect(isWorkspaceRelativePath("a\nb")).toBe(false);
  });

  it("rejects non-strings and oversized values", () => {
    expect(isWorkspaceRelativePath(42)).toBe(false);
    expect(isWorkspaceRelativePath(null)).toBe(false);
    expect(isWorkspaceRelativePath("a".repeat(MAX_WORKSPACE_PATH_LENGTH + 1))).toBe(false);
  });
});

describe("path helpers", () => {
  it("splits base names and parents", () => {
    expect(workspaceBasename("src/app.ts")).toBe("app.ts");
    expect(workspaceBasename("app.ts")).toBe("app.ts");
    expect(workspaceDirname("src/lib/app.ts")).toBe("src/lib");
    expect(workspaceDirname("src/app.ts")).toBe("src");
    expect(workspaceDirname("app.ts")).toBe("");
  });

  it("joins segments without resolving escapes", () => {
    expect(workspaceJoin("src", "lib", "app.ts")).toBe("src/lib/app.ts");
    expect(workspaceJoin("", "src", "", "app.ts")).toBe("src/app.ts");
  });

  it("compares paths with optional Windows case folding", () => {
    expect(sameWorkspacePath("src/App.ts", "src/App.ts")).toBe(true);
    expect(sameWorkspacePath("src/App.ts", "src/app.ts")).toBe(false);
    expect(sameWorkspacePath("src/App.ts", "src/app.ts", true)).toBe(true);
  });
});

describe("sortWorkspaceEntries", () => {
  const entries = [
    entry({ name: "file10.ts", kind: "file", path: "file10.ts" }),
    entry({ name: "file2.ts", kind: "file", path: "file2.ts" }),
    entry({ name: "b-dir", kind: "directory", path: "b-dir", size: null }),
    entry({ name: "a-dir", kind: "directory", path: "a-dir", size: null }),
    entry({ name: "app.json", kind: "file", path: "app.json" }),
  ];

  it("puts directories first and sorts names naturally", () => {
    expect(sortWorkspaceEntries(entries).map((item) => item.name)).toEqual([
      "a-dir",
      "b-dir",
      "app.json",
      "file2.ts",
      "file10.ts",
    ]);
  });

  it("sorts by extension then name", () => {
    expect(sortWorkspaceEntries(entries, "type").map((item) => item.name)).toEqual([
      "a-dir",
      "b-dir",
      "app.json",
      "file2.ts",
      "file10.ts",
    ]);
  });

  it("sorts modified newest first, then name", () => {
    const withTimes = [
      entry({ name: "old.ts", kind: "file", mtimeMs: 10 }),
      entry({ name: "new.ts", kind: "file", mtimeMs: 30 }),
      entry({ name: "mid.ts", kind: "file", mtimeMs: 20 }),
    ];
    expect(sortWorkspaceEntries(withTimes, "modified").map((item) => item.name)).toEqual([
      "new.ts",
      "mid.ts",
      "old.ts",
    ]);
  });

  it("does not mutate the input", () => {
    const input = [...entries];
    sortWorkspaceEntries(input, "name");
    expect(input.map((item) => item.name)).toEqual(entries.map((item) => item.name));
  });
});

describe("caps and result envelopes", () => {
  it("exports the shared limits", () => {
    expect(MAX_DIRECTORY_ENTRIES).toBeGreaterThan(0);
    expect(MAX_QUICK_OPEN_FILES).toBeGreaterThan(MAX_DIRECTORY_ENTRIES);
    expect(MAX_EDITOR_READ_BYTES).toBeGreaterThan(MAX_EDITOR_WRITE_BYTES);
  });

  it("builds ok and failure results", () => {
    expect(workspaceOk(1)).toEqual({ ok: true, value: 1 });
    expect(workspaceFailure("conflict", "changed", { mtimeMs: 2, size: 3 })).toEqual({
      ok: false,
      error: { code: "conflict", message: "changed", current: { mtimeMs: 2, size: 3 } },
    });
  });
});
