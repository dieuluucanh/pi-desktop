import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Architecture guard (AGENTS.md rule 4, plan 2026-11-09 step 28).
 *
 * Every `@earendil-works/*` import lives in `src/host/sdk/**`, so a Pi upgrade
 * touches one directory. The rest of the host — and `src/extensions/**`, which
 * mirrors the few SDK members it uses as structural types — stays SDK-free.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const SDK_IMPORT =
  /(?:from\s*["']@earendil-works\/)|(?:require\(\s*["']@earendil-works\/)|(?:import\(\s*["']@earendil-works\/)/;

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js"] as const;

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(join(repoRoot, dir), { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext)))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

const portable = (file: string): string => relative(repoRoot, file).split(sep).join("/");

describe("SDK boundary", () => {
  it("imports @earendil-works only from src/host/sdk", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles("src")) {
      const path = portable(file);
      if (path.startsWith("src/host/sdk/")) continue;
      const text = await readFile(file, "utf8");
      if (SDK_IMPORT.test(text)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps src/extensions free of SDK imports", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles("src/extensions")) {
      const text = await readFile(file, "utf8");
      if (SDK_IMPORT.test(text)) offenders.push(portable(file));
    }
    expect(offenders).toEqual([]);
  });
});
