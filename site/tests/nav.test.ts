import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCS_INDEX_SOURCE, NAV_GROUPS } from "../src/data/nav.mjs";

const repoRoot = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function walkDocs(directory: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walkDocs(absolute));
    else if (entry.isFile() && entry.name.endsWith(".md")) {
      result.push(absolute.slice(repoRoot.length).split("\\").join("/"));
    }
  }
  return result;
}

describe("docs navigation", () => {
  it("names every non-release docs page exactly once", () => {
    const sources = [...NAV_GROUPS.flatMap((group) => group.sources), DOCS_INDEX_SOURCE];
    expect(new Set(sources).size).toBe(sources.length);

    const expected = walkDocs(join(repoRoot, "docs")).filter(
      (source) => !source.startsWith("docs/releases/"),
    );
    expect(sources.sort()).toEqual(expected.sort());
  });

  it("keeps the release notes out of the static groups (they are generated)", () => {
    expect(
      NAV_GROUPS.flatMap((group) => group.sources).some((source) =>
        source.startsWith("docs/releases/"),
      ),
    ).toBe(false);
  });
});
