import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

import {
  CHANGELOG_FILE,
  ENTRY_FILE,
  LICENSE_FILE,
  PACKAGE_DIR,
  PACKAGE_NAME,
  README_FILE,
  REPOSITORY_DIRECTORY,
  REPOSITORY_URL,
  REQUIRED_FILES,
  validateTarballFiles,
} from "../../scripts/extension-package.mjs";

/**
 * The publishable checkpoint package (2026-10-31 re-home plan).
 *
 * `scripts/build-extension.mjs` bundles `src/extensions/pi-checkpoints.ts` into
 * `packages/checkpoints/index.mjs`; the manifest/README/LICENSE/CHANGELOG are
 * tracked source. This suite pins the four things that make the directory
 * publishable:
 *
 *  1. it builds and exposes a default factory function;
 *  2. the bundle carries no `@earendil-works` specifier and no dangling relative
 *     import, so it loads with no `node_modules` beside it;
 *  3. the manifest declares `pi.extensions` and the Pi Desktop repository;
 *  4. `npm pack` contains the entry, README, LICENSE and CHANGELOG, and no test,
 *     `node_modules` or lockfile content.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const buildScript = join(repoRoot, "scripts", "build-extension.mjs");
const execFileAsync = promisify(execFile);

const NPM =
  process.platform === "win32"
    ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "npm"] }
    : { command: "npm", args: [] };

function packagePath(name: string): string {
  return join(PACKAGE_DIR, name);
}

beforeAll(async () => {
  await execFileAsync(process.execPath, [buildScript], { cwd: repoRoot, timeout: 120_000 });
}, 180_000);

describe("the publishable package", () => {
  it("has every tracked file and the built entry", async () => {
    for (const name of REQUIRED_FILES) {
      const info = await stat(packagePath(name));
      expect(info.isFile(), name).toBe(true);
    }
    expect(ENTRY_FILE).toBe("index.mjs");
  });

  it("exposes a default factory function", async () => {
    const module = (await import(
      `${pathToFileURL(packagePath(ENTRY_FILE)).href}?v=${Date.now()}`
    )) as { default?: unknown };
    expect(typeof module.default).toBe("function");
  });

  it("loads when the factory is called with the API object alone", async () => {
    // The exact contract of Pi's `initializeExtension`: `await factory(load.api)`.
    const module = (await import(
      `${pathToFileURL(packagePath(ENTRY_FILE)).href}?v=${Date.now()}`
    )) as { default: (api: unknown) => void | Promise<void> };
    const api = {
      on: () => () => undefined,
      appendEntry: () => undefined,
      registerCommand: () => undefined,
    };
    await expect(Promise.resolve(module.default(api))).resolves.toBeUndefined();
  });

  it("has no unresolved @earendil-works or relative import", async () => {
    const bundle = await readFile(packagePath(ENTRY_FILE), "utf8");
    expect(bundle).not.toMatch(/@earendil-works/);

    const specifiers = [...bundle.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
    const bare = specifiers.filter(
      (id) => id !== undefined && !id.startsWith(".") && !id.startsWith("/"),
    );
    expect(bare.filter((id) => !id?.startsWith("node:") && !id?.startsWith("file:"))).toEqual([]);

    // Every relative import was inlined; a surviving one would point at a source
    // file that is not shipped in the tarball.
    expect(specifiers.filter((id) => id?.startsWith("."))).toEqual([]);
  });

  it("declares the publishable identity and Pi entry", async () => {
    const manifest = JSON.parse(await readFile(packagePath("package.json"), "utf8")) as {
      name?: string;
      version?: string;
      private?: boolean;
      repository?: { url?: string; directory?: string };
      pi?: { extensions?: unknown };
      files?: string[];
      publishConfig?: { access?: string };
    };
    expect(manifest.name).toBe(PACKAGE_NAME);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest.private).not.toBe(true);
    expect(manifest.repository).toEqual({
      type: "git",
      url: REPOSITORY_URL,
      directory: REPOSITORY_DIRECTORY,
    });
    expect(manifest.pi?.extensions).toEqual(["./index.mjs"]);
    expect(manifest.files).toEqual(
      expect.arrayContaining([ENTRY_FILE, README_FILE, LICENSE_FILE, CHANGELOG_FILE]),
    );
    expect(manifest.publishConfig?.access).toBe("public");
  });

  it("has a tarball with the intended files only", async () => {
    const result = await execFileAsync(NPM.command, [...NPM.args, "pack", "--dry-run", "--json"], {
      cwd: PACKAGE_DIR,
      timeout: 60_000,
    });
    const text = String(result.stdout ?? "");
    const parsed = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)) as [
      { files?: { path?: string }[] },
    ];
    const files = (parsed[0]?.files ?? []).map((file) => String(file.path ?? ""));
    expect(validateTarballFiles(files)).toEqual([]);
    expect(files).toEqual(expect.arrayContaining([...REQUIRED_FILES]));
  });

  it("registers /checkpoint and not the workflow /rewind command", async () => {
    const source = await readFile(
      fileURLToPath(new URL("../../src/extensions/pi-checkpoints.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain('registerCommand("checkpoint"');
    expect(source).not.toContain('registerCommand("rewind"');
  });

  it("documents the install routes and the source of the package", async () => {
    const readme = await readFile(packagePath(README_FILE), "utf8");
    expect(readme).toContain("pi install npm:@dieulc/checkpoints");
    expect(readme).toContain("pi install path:");
    expect(readme).toContain("src/extensions/pi-checkpoints.ts");
    expect(readme).toMatch(/git/);
  });
});
