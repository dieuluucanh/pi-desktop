import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The terminal-Pi artifact (git-checkpoint plan step 26).
 *
 * `scripts/build-extension.mjs` bundles `src/extensions/pi-checkpoints.ts` into
 * an installable path package. Three things make it usable, and this suite pins
 * all three:
 *
 *  1. It **builds** and exposes a default factory function.
 *  2. It carries **no `@earendil-works` specifier**, so it loads with no
 *     `node_modules` beside it (the structural types are what make that possible).
 *  3. Its `package.json` declares `pi.extensions` — the field Pi's loader reads —
 *     and its version tracks the root `package.json`, so an artifact can never be
 *     shipped as a stale copy.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const outDir = join(repoRoot, "dist", "pi-checkpoints");
const execFileAsync = promisify(execFile);

beforeAll(async () => {
  // Build once for the whole suite: the script is the unit under test.
  await execFileAsync(process.execPath, [join(repoRoot, "scripts", "build-extension.mjs")], {
    cwd: repoRoot,
    timeout: 120_000,
  });
}, 180_000);

describe("the built artifact", () => {
  it("emits index.mjs, package.json and a README", async () => {
    for (const name of ["index.mjs", "package.json", "README.md"]) {
      const info = await stat(join(outDir, name));
      expect(info.isFile(), name).toBe(true);
    }
  });

  it("exposes a default factory function", async () => {
    const module = (await import(join(outDir, "index.mjs"))) as { default?: unknown };
    expect(typeof module.default).toBe("function");
  });

  it("has no unresolved @earendil-works specifier", async () => {
    const bundle = await readFile(join(outDir, "index.mjs"), "utf8");
    // The extension mirrors the SDK structurally, so nothing needs the package.
    expect(bundle).not.toMatch(/@earendil-works/);
    // And it is a real bundle: only Node built-ins may survive as bare imports.
    const specifiers = [...bundle.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
    const bare = specifiers.filter(
      (id) => id !== undefined && !id.startsWith(".") && !id.startsWith("/"),
    );
    expect(bare.filter((id) => !id?.startsWith("node:") && !id?.startsWith("file:"))).toEqual([]);
  });

  it("has no unresolved relative import left dangling", async () => {
    const bundle = await readFile(join(outDir, "index.mjs"), "utf8");
    // Every relative import must have been inlined; a surviving one would point
    // at a `src/` file that is not shipped.
    const relatives = [...bundle.matchAll(/from\s+["'](\.[^"']+)["']/g)].map((match) => match[1]);
    expect(relatives).toEqual([]);
  });

  it("declares pi.extensions in its manifest", async () => {
    const text = await readFile(join(outDir, "package.json"), "utf8");
    const manifest = JSON.parse(text) as {
      name?: string;
      version?: string;
      private?: boolean;
      pi?: { extensions?: unknown };
    };
    expect(manifest.name).toBe("pi-checkpoints");
    // `readPiManifest` (and Pi itself) reads exactly this field.
    expect(manifest.pi?.extensions).toEqual(["./index.mjs"]);
    // Not publishable by accident: publication is a separate release decision.
    expect(manifest.private).toBe(true);
  });

  it("tracks the root package version", async () => {
    const rootText = await readFile(join(repoRoot, "package.json"), "utf8");
    const root = JSON.parse(rootText) as { version?: string };
    const text = await readFile(join(outDir, "package.json"), "utf8");
    const artifact = JSON.parse(text) as { version?: string };
    expect(artifact.version).toBe(root.version);
  });

  it("documents the install command", async () => {
    const readme = await readFile(join(outDir, "README.md"), "utf8");
    expect(readme).toContain("pi install path:");
    // The one caveat a user must know before installing.
    expect(readme).toMatch(/git/);
  });
});
