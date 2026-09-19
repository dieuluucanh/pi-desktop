import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Architecture guard (AGENTS.md rule 1): the Office backend, the package
 * plumbing and the Pi host must stay pure Node so they can be unit tested and
 * can run under the bundled runtime instead of inside Electron.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const CORE_DIRS = ["src/host", "src/main/office", "src/main/packages", "src/main/runtime"] as const;
/** Electron-free *modules* that live outside those directories (plan step 3). */
const CORE_FILES = ["src/main/session-service.ts"] as const;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js"] as const;

const ELECTRON_IMPORT =
  /(?:from\s*["']electron["'])|(?:require\(\s*["']electron["']\s*\))|(?:import\(\s*["']electron["']\s*\))/;

async function sourceFilesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(join(repoRoot, dir), { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext)))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

describe("electron-free core modules", () => {
  it("the detector recognises the import shapes it must catch", () => {
    expect(ELECTRON_IMPORT.test('import { app } from "electron";')).toBe(true);
    expect(ELECTRON_IMPORT.test("const { shell } = require('electron');")).toBe(true);
    expect(ELECTRON_IMPORT.test('const mod = await import("electron");')).toBe(true);
    expect(ELECTRON_IMPORT.test('import type { AppInfo } from "../shared/ipc";')).toBe(false);
    expect(ELECTRON_IMPORT.test('import { checkBridgeHealth } from "./verify";')).toBe(false);
  });

  it("no core module imports electron", async () => {
    const offenders: string[] = [];
    let inspected = 0;

    for (const dir of CORE_DIRS) {
      const files = await sourceFilesUnder(dir);
      expect(files.length, `${dir} should contain source files`).toBeGreaterThan(0);
      for (const file of files) {
        inspected += 1;
        if (ELECTRON_IMPORT.test(await readFile(file, "utf8"))) {
          offenders.push(relative(repoRoot, file));
        }
      }
    }

    for (const file of CORE_FILES) {
      inspected += 1;
      if (ELECTRON_IMPORT.test(await readFile(join(repoRoot, file), "utf8"))) {
        offenders.push(file);
      }
    }

    expect(inspected).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});
