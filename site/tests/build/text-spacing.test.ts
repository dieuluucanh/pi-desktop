import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const siteRoot = fileURLToPath(new URL("../../", import.meta.url));
const dist = join(siteRoot, "dist");

function htmlFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...htmlFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".html")) files.push(path);
  }
  return files;
}

/** Drop regions where HTML-looking text is data rather than rendered prose. */
function visibleMarkup(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<pre\b[\s\S]*?<\/pre>/gi, "")
    .replace(/<code\b[\s\S]*?<\/code>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

function missingSpaceContexts(html: string): string[] {
  const contexts: string[] = [];
  for (const match of html.matchAll(/[A-Za-z0-9,.;:!?)]<a\b|<\/a>[A-Za-z0-9]/g)) {
    const index = match.index ?? 0;
    contexts.push(html.slice(Math.max(0, index - 45), index + 75));
  }
  return contexts;
}

const pages = htmlFiles(dist);

describe("inline link spacing", () => {
  it("scans every built HTML page", () => {
    expect(pages.length).toBeGreaterThanOrEqual(30);
  });

  it("never joins a word or punctuation directly to an anchor", () => {
    const issues = pages.flatMap((page) =>
      missingSpaceContexts(visibleMarkup(readFileSync(page, "utf8"))).map(
        (context) => `${page}: …${context}…`,
      ),
    );
    expect(issues).toEqual([]);
  });

  it("keeps the reported FAQ and footer sentences spaced", () => {
    const landing = readFileSync(join(dist, "index.html"), "utf8");
    expect(landing).toContain("FAQ</a> and <a");
    expect(landing).toContain("published on <a");
  });

  it("keeps the installation link spaced after the colon", () => {
    const landing = readFileSync(join(dist, "index.html"), "utf8");
    expect(landing).toContain("first-run flow: <a");
  });
});
