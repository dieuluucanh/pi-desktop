import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import config from "../../electron.vite.config";
import {
  DEFAULT_RENDERER_DEV_PORT,
  RENDERER_DEV_HOST,
  rendererDevServer,
} from "../../src/main/runtime/dev-server";

/**
 * The renderer dev-server wiring (2026-11-05 port-collision plan, step 2).
 *
 * The policy module is unit tested on its own; this file pins the one-line
 * binding in `electron.vite.config.ts`, so a future edit cannot quietly return
 * the app to Vite's default 5173 or drop `strictPort` while the policy still
 * looks correct.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), "utf8");

describe("renderer dev server config", () => {
  it("uses the dedicated loopback port and never falls back", () => {
    expect(config.renderer?.server).toEqual(rendererDevServer({}));
    expect(config.renderer?.server).toEqual({
      host: RENDERER_DEV_HOST,
      port: DEFAULT_RENDERER_DEV_PORT,
      strictPort: true,
    });
  });

  it("keeps the wiring in the config instead of a hardcoded port", () => {
    const source = read("electron.vite.config.ts");
    expect(source).toContain("server: rendererDevServer(process.env)");
    expect(source).not.toMatch(/port:\s*5173/);
  });

  it("does not let a dev script bypass the config with a port flag", () => {
    const packageJson = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };
    for (const [name, script] of Object.entries(packageJson.scripts)) {
      if (name === "dev" || name.startsWith("dev:")) {
        expect(script, name).not.toMatch(/--port\s+5173\b/);
      }
    }
  });
});
