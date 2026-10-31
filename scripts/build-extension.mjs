#!/usr/bin/env node
/**
 * Build the publishable checkpoint package (git-checkpoint plan step 26).
 *
 *   npm run build:extension
 *
 * Produces `packages/checkpoints/index.mjs` from
 * `src/extensions/pi-checkpoints.ts`. The package manifest, README, LICENSE and
 * CHANGELOG are tracked source; this script never rewrites them.
 *
 * The package is both the npm artifact and the path-install artifact:
 *
 *   pi install npm:@dieulc/checkpoints
 *   pi install path:<abs path>/packages/checkpoints
 *
 * The bundling policy is deliberately the same as `vite.host.config.ts`:
 * relative imports are inlined, bare specifiers stay external. The extension is
 * written so all of its imports *are* relative (see its own doc comment), which
 * is what makes the artifact self-contained.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";

import {
  ENTRY_FILE,
  PACKAGE_DIR,
  REPO_ROOT,
  readManifest,
  validateManifest,
} from "./extension-package.mjs";

const tempDir = join(REPO_ROOT, "out", "extension-package");
const targetPath = join(PACKAGE_DIR, ENTRY_FILE);

async function main() {
  const manifest = readManifest(PACKAGE_DIR);
  const errors = validateManifest(manifest);
  if (errors.length > 0) {
    throw new Error(`packages/checkpoints/package.json is invalid:\n  - ${errors.join("\n  - ")}`);
  }

  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });

  await build({
    root: REPO_ROOT,
    // A config-less build: this script is the config, so `npm run build:extension`
    // cannot be affected by whatever `vite.config.*` a future step adds.
    configFile: false,
    logLevel: "warn",
    build: {
      ssr: true,
      target: "node22",
      outDir: tempDir,
      emptyOutDir: true,
      copyPublicDir: false,
      minify: false,
      sourcemap: false,
      lib: {
        entry: resolve(REPO_ROOT, "src/extensions/pi-checkpoints.ts"),
        formats: ["es"],
        fileName: () => ENTRY_FILE,
      },
      rollupOptions: {
        // Bare specifiers are external; relative, absolute and `file:` entries are
        // bundled. The absolute check matters: the *entry* is an absolute path, and
        // treating it as external makes rollup refuse the build outright.
        external: (id) =>
          !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("file:") && !isAbsolute(id),
        output: { entryFileNames: ENTRY_FILE },
      },
    },
  });

  // Stage the bundle and replace the previous one only after a complete build.
  // A failed build must never leave a half-written publishable artifact.
  const built = await readFile(join(tempDir, ENTRY_FILE));
  const staged = join(PACKAGE_DIR, `.${ENTRY_FILE}.${process.pid}.tmp`);
  await writeFile(staged, built);
  await rm(targetPath, { force: true });
  await rename(staged, targetPath);

  // Loader-contract smoke test. Pi calls a default export with the API object
  // alone (`await factory(load.api)`), so a bundle that needs a second argument
  // would ship fine and then abort every `pi` startup. Fail the build instead.
  const artifact = await import(`${pathToFileURL(targetPath).href}?v=${Date.now()}`);
  const api = {
    on: () => () => undefined,
    appendEntry: () => undefined,
    registerCommand: () => undefined,
  };
  await artifact.default(api);

  const stat = await readFile(targetPath, "utf8");
  process.stdout.write(
    `build-extension: ${relative(REPO_ROOT, targetPath)} (${stat.length} bytes)\n`,
  );
  process.stdout.write(`build-extension: install with \`pi install path:${PACKAGE_DIR}\`\n`);
}

main().catch((error) => {
  process.stderr.write(`build-extension: ${error instanceof Error ? error.stack : error}\n`);
  process.exit(1);
});
