import { describe, expect, it } from "vitest";
import { globToRegexSource, isIgnored, parseGitignore } from "../../src/host/gitignore";

/**
 * The gitignore matcher behind `@` completion (plan step 7). Each case mirrors a
 * rule from git's own documentation, because the failure mode is silent: a
 * mis-parsed rule either hides real files from completion or lists thousands of
 * ignored ones.
 */

function ignored(contents: string, path: string, isDirectory = false): boolean {
  return isIgnored(parseGitignore(contents), path, isDirectory);
}

describe("parseGitignore", () => {
  it("ignores blanks and comments", () => {
    expect(parseGitignore("\n# a comment\n   \n")).toEqual([]);
  });

  it("reads negation, anchoring and directory-only rules", () => {
    const rules = parseGitignore("/build\n!keep.log\nnode_modules/\n*.tmp\n");
    expect(rules).toHaveLength(4);
    expect(rules[0]).toMatchObject({ pattern: "build", anchored: true, negated: false });
    expect(rules[1]).toMatchObject({ pattern: "keep.log", anchored: false, negated: true });
    expect(rules[2]).toMatchObject({ pattern: "node_modules", directoryOnly: true });
    expect(rules[3]).toMatchObject({ pattern: "*.tmp", directoryOnly: false });
  });

  it("treats a pattern containing a slash as anchored", () => {
    expect(parseGitignore("src/generated\n")[0]?.anchored).toBe(true);
  });
});

describe("matching", () => {
  it("matches a bare name at any depth", () => {
    expect(ignored("dist\n", "dist")).toBe(true);
    expect(ignored("dist\n", "packages/app/dist")).toBe(true);
    expect(ignored("dist\n", "dist/app.js")).toBe(true);
  });

  it("anchors a leading slash to the root", () => {
    expect(ignored("/build\n", "build")).toBe(true);
    expect(ignored("/build\n", "packages/build")).toBe(false);
  });

  it("honours the trailing slash for directories only", () => {
    expect(ignored("logs/\n", "logs", true)).toBe(true);
    expect(ignored("logs/\n", "logs", false)).toBe(false);
  });

  it("lets the last matching rule win so negation works", () => {
    expect(ignored("*.log\n!keep.log\n", "debug.log")).toBe(true);
    expect(ignored("*.log\n!keep.log\n", "keep.log")).toBe(false);
  });

  it("does not re-include a file inside an excluded directory (as git does not)", () => {
    expect(ignored("build/\n!build/keep.js\n", "build/keep.js")).toBe(true);
  });

  it("supports * ** ? and character classes", () => {
    expect(ignored("*.tmp\n", "a/b/c.tmp")).toBe(true);
    expect(ignored("docs/**/draft.md\n", "docs/a/b/draft.md")).toBe(true);
    expect(ignored("docs/**/draft.md\n", "docs/draft.md")).toBe(true);
    expect(ignored("file?.txt\n", "file1.txt")).toBe(true);
    expect(ignored("file?.txt\n", "file12.txt")).toBe(false);
    expect(ignored("*.log[0-9]\n", "app.log3")).toBe(true);
  });

  it("drops unescaped trailing spaces but keeps an escaped one", () => {
    // The stored pattern keeps its escape (`globToRegexSource` consumes it), so
    // the contract worth asserting is what actually matches.
    expect(parseGitignore("name   \n")[0]?.pattern).toBe("name");
    expect(ignored("name\\ \n", "name ")).toBe(true);
    expect(ignored("name   \n", "name ")).toBe(false);
  });

  it("keeps nested rules from the directory that declares them", () => {
    const root = parseGitignore("*.log\n");
    const nested = [...root, ...parseGitignore("!app.log\n")];
    expect(isIgnored(root, "sub/app.log")).toBe(true);
    expect(isIgnored(nested, "sub/app.log")).toBe(false);
  });
});

describe("globToRegexSource", () => {
  it("escapes regex metacharacters in literal segments", () => {
    expect(globToRegexSource("a+b(c)")).toBe("a\\+b\\(c\\)");
  });
});
