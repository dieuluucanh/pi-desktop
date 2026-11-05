import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Architecture guard for the native PTY (2026-11-05 terminal plan, step 4).
 *
 * `node-pty` is a native module. Keeping it in one host-side adapter means:
 * - the Electron main process, the preload and the renderer never load it;
 * - it is built for the bundled Node runtime, not Electron's ABI;
 * - swapping the adapter (or the multiarch fork) stays a one-file change.
 *
 * The second guard keeps the terminal entry out of the Pi SDK graph: the whole
 * reason it is a separate rollup input is that a process that owns PTYs has no
 * business loading the agent, the extension runner or the TUI surface.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const NODE_PTY_IMPORT =
  /(?:from\s*["']node-pty["'])|(?:require\(\s*["']node-pty["']\s*\))|(?:import\(\s*["']node-pty["']\s*\))/;

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js"] as const;

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(join(repoRoot, dir), { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext)))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

describe("node-pty isolation", () => {
  it("is imported only by the host adapter", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles("src")) {
      const text = await readFile(file, "utf8");
      if (NODE_PTY_IMPORT.test(text)) offenders.push(relative(repoRoot, file).split(sep).join("/"));
    }
    expect(offenders).toEqual(["src/host/pty-node.ts"]);
  });

  it("is a pinned runtime dependency, not a dev dependency", async () => {
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.["node-pty"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.devDependencies?.["node-pty"]).toBeUndefined();
  });
});

describe("terminal host entry", () => {
  it("never imports the Pi SDK or the session host", async () => {
    const text = await readFile(join(repoRoot, "src/host/terminal-main.ts"), "utf8");
    expect(text).not.toContain("pi-coding-agent");
    expect(text).not.toMatch(/from\s*["']\.\/sdk/);
    expect(text).not.toMatch(/from\s*["']\.\/service["']/);
    expect(text).not.toMatch(/from\s*["']\.\/session-core["']/);
    expect(text).not.toMatch(/from\s*["']\.\/index["']/);
  });

  it("is built as its own host bundle input", async () => {
    const config = await readFile(join(repoRoot, "vite.host.config.ts"), "utf8");
    expect(config).toMatch(/terminal:\s*resolve\(\s*["']\.\/src\/host\/terminal-main\.ts["']\s*\)/);
  });
});
