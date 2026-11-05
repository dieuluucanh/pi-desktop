import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Dev-script guard (2026-10-25 model-scope plan).
 *
 * The regression this pins: `electron-vite dev` builds main/preload once and
 * never watches them unless `--watch` is passed. A renderer hot-reload then
 * shows a new feature (the model-scope star) while the long-running main
 * process still rejects the new host method
 * (`session: unsupported host method model.scope.toggle`).
 *
 * The host bundle was already watched, so the host side looked current. Both
 * watches are required; neither script may silently lose its flag.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), "utf8");

const packageJson = JSON.parse(read("package.json")) as {
  scripts: Record<string, string>;
};
const devRunner = read("scripts/dev.mjs");

describe("development build scripts", () => {
  it("watches main and preload so a protocol edit restarts Electron", () => {
    // `electron-vite@5` only installs its rebuild/restart hook in watch mode.
    expect(packageJson.scripts["dev:electron"]).toMatch(/electron-vite\s+dev\s+(?:--watch|-w)\b/);
  });

  it("keeps the host bundle on a watch build too", () => {
    expect(packageJson.scripts["dev:host"]).toMatch(/vite\s+build\s+--watch\b/);
  });

  it("starts both watches through the one dev runner", () => {
    expect(packageJson.scripts.dev).toContain("scripts/dev.mjs");
    expect(devRunner).toContain('"dev:host"');
    expect(devRunner).toContain('"dev:electron"');
  });

  it("stops each child's whole tree, not just the cmd.exe shell", () => {
    // Windows spawns npm through `shell: true`, so child.kill() leaves the
    // Vite/Electron descendants (and the renderer dev port) behind.
    expect(devRunner).toContain('from "./dev-stop.mjs"');
    expect(devRunner).toContain("stopChild(child, process.platform)");
  });
});
