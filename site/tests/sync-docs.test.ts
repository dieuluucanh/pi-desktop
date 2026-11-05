import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REPO_ROOT,
  DocsSyncError,
  buildFrontmatter,
  extractTitleAndDescription,
  routeForSource,
  rewriteLink,
  syncDocs,
} from "../scripts/sync-docs.mjs";

const source = "docs/guide/getting-started.md";
const packageJson = JSON.parse(readFileSync(join(DEFAULT_REPO_ROOT, "package.json"), "utf8")) as {
  version: string;
};
const currentVersion = packageJson.version;

describe("docs sync", () => {
  it("maps every docs source and keeps the release routes dotted", () => {
    const manifest = syncDocs({ validate: true });
    expect(manifest.docs).toHaveLength(34);
    expect(manifest.releases).toHaveLength(6);
    expect(manifest.version).toBe(currentVersion);
    expect(manifest.docs.map((doc: { route: string }) => doc.route)).toEqual(
      expect.arrayContaining([
        "/docs/",
        "/guide/getting-started/",
        "/architecture/app-shell/",
        `/releases/v${currentVersion}/`,
      ]),
    );
    expect(manifest.releases.map((release: { version: string }) => release.version)).toEqual([
      currentVersion,
      "0.5.0",
      "0.4.0",
      "0.3.0",
      "0.2.0",
      "0.1.0",
    ]);
  });

  it("routes docs README to /docs/ and keeps the source for edit links", () => {
    expect(routeForSource("docs/README.md")).toBe("/docs/");
    expect(routeForSource("docs/guide/getting-started.md")).toBe("/guide/getting-started/");
  });

  it("rewrites doc-to-doc links, anchors, repo files and external links", () => {
    expect(rewriteLink("../architecture/app-shell.md#ipc", source, DEFAULT_REPO_ROOT)).toBe(
      "/architecture/app-shell/#ipc",
    );
    expect(rewriteLink("projects.md", source, DEFAULT_REPO_ROOT)).toBe("/guide/projects/");
    expect(rewriteLink("../README.md", source, DEFAULT_REPO_ROOT)).toBe("/docs/");
    expect(
      rewriteLink("../../LICENSE", `docs/releases/v${currentVersion}.md`, DEFAULT_REPO_ROOT),
    ).toBe("https://github.com/dieuluucanh/pi-desktop/blob/main/LICENSE");
    expect(rewriteLink("https://pi.dev", source, DEFAULT_REPO_ROOT)).toBe("https://pi.dev");
    expect(rewriteLink("#updates", source, DEFAULT_REPO_ROOT)).toBe("#updates");
  });

  it("fails on an unknown local target instead of leaving a broken link", () => {
    expect(() => rewriteLink("../missing.md", source, DEFAULT_REPO_ROOT)).toThrow(DocsSyncError);
  });

  it("builds frontmatter with escaped values and removes the H1 from the body", () => {
    const tree = unified()
      .use(remarkParse)
      .parse("# Hello: one\n\nThe first paragraph with `code`.\n\n## Next\n");
    const { title, description } = extractTitleAndDescription(tree, source);
    expect(title).toBe("Hello: one");
    expect(description).toBe("The first paragraph with code.");
    expect(tree.children.some((node: { type: string }) => node.type === "heading")).toBe(true);

    const frontmatter = buildFrontmatter({ title, description, sourceRel: source });
    expect(frontmatter).toContain('title: "Hello: one"');
    expect(frontmatter).toContain("editUrl:");
  });

  it("removes the H1 and leaves no source-relative Markdown links in generated pages", () => {
    syncDocs();
    const generated = readFileSync(
      join(DEFAULT_REPO_ROOT, "site", "src", "content", "docs", "guide", "getting-started.md"),
      "utf8",
    );
    expect(generated.startsWith("---\ntitle:")).toBe(true);
    expect(generated).not.toContain("](getting-started.md");
    expect(generated).not.toContain("](../");
  });

  it("fails a source with frontmatter, keeping docs/ as the plain source", () => {
    const tree = unified().use(remarkParse).parse("No heading here.\n");
    expect(() => extractTitleAndDescription(tree, "docs/bad.md")).toThrow(DocsSyncError);
  });
});
