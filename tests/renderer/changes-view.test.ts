import { describe, expect, it } from "vitest";
import { canOpenFile, diffRequestFor, orderFiles } from "../../src/renderer/src/rail/changes-view";
import type { GitFileEntry } from "../../src/shared/git";

/**
 * The Changes view helpers (untracked-changes plan step 5).
 *
 * These three decisions used to live inside the component: which side a row's
 * diff reads, whether Open file is meaningful, and the order the two groups
 * render in. Keeping them pure is what makes the untracked case testable without
 * a DOM.
 */

function file(path: string, overrides: Partial<GitFileEntry> = {}): GitFileEntry {
  return {
    path,
    origPath: null,
    status: "modified",
    staged: false,
    unstaged: true,
    ...overrides,
  };
}

describe("diffRequestFor", () => {
  it("asks for the index side from the staged group", () => {
    expect(diffRequestFor(file("src/a.ts"), true)).toEqual({
      path: "src/a.ts",
      staged: true,
    });
  });

  it("asks for a work-tree read for an untracked file", () => {
    expect(diffRequestFor(file("new.ts", { status: "untracked" }), false)).toEqual({
      path: "new.ts",
      untracked: true,
    });
  });

  it("asks for the ordinary work-tree side otherwise", () => {
    expect(diffRequestFor(file("src/a.ts"), false)).toEqual({ path: "src/a.ts" });
  });
});

describe("canOpenFile", () => {
  it("refuses a deleted path and accepts everything else", () => {
    expect(canOpenFile(file("gone.ts", { status: "deleted" }))).toBe(false);
    expect(canOpenFile(file("src/a.ts"))).toBe(true);
    expect(canOpenFile(file("new.ts", { status: "untracked" }))).toBe(true);
    expect(canOpenFile(file("link.ts", { status: "renamed", origPath: "old.ts" }))).toBe(true);
  });
});

describe("orderFiles", () => {
  it("orders by path, numerically and case-insensitively", () => {
    const ordered = orderFiles([file("b.ts"), file("f10.ts"), file("a.ts"), file("f2.ts")]).map(
      (entry) => entry.path,
    );
    expect(ordered).toEqual(["a.ts", "b.ts", "f2.ts", "f10.ts"]);
  });

  it("does not mutate the caller's array", () => {
    const input = [file("b.ts"), file("a.ts")];
    orderFiles(input);
    expect(input.map((entry) => entry.path)).toEqual(["b.ts", "a.ts"]);
  });
});
