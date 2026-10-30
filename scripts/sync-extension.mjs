#!/usr/bin/env node
/**
 * Copy the built checkpoint extension into the `~/.pi` dotfiles package
 * (2026-10-30 plan step 13).
 *
 *   npm run build:extension
 *   npm run sync:extension                 # default ~/.pi
 *   npm run sync:extension -- --check      # fail when the package is stale
 *
 * The `~/.pi` package owns its `package.json`, README, LICENSE and CHANGELOG;
 * this script only replaces `index.mjs`. That keeps release metadata and the
 * generated bundle from fighting each other. Using a separate script (rather
 * than a runtime profile copy) means real Pi Desktop users still get the
 * bundled extension, while terminal users install the published npm package.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The default target package directory under a Pi dotfiles checkout. */
export function checkpointPackageDir(piRoot) {
  return join(piRoot, "agent", "extensions", "checkpoints");
}

/**
 * Synchronises one built artifact into an existing package.
 * Exported so a test can use temporary directories instead of the real profile.
 */
export async function syncCheckpointExtension(options) {
  const sourcePath = options.sourcePath;
  const targetDir = options.targetDir;
  const check = options.check === true;

  const manifestText = await readFile(join(targetDir, "package.json"), "utf8").catch(() => null);
  if (manifestText === null) {
    throw new Error(
      `refusing to sync: ${join(targetDir, "package.json")} is missing (is this the ~/.pi checkout?)`,
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error(`refusing to sync: ${join(targetDir, "package.json")} is not valid JSON`);
  }
  const entries = Array.isArray(manifest?.pi?.extensions) ? manifest.pi.extensions : [];
  if (!entries.includes("./index.mjs")) {
    throw new Error(
      `refusing to sync: ${join(targetDir, "package.json")} does not declare pi.extensions ["./index.mjs"]`,
    );
  }

  const source = await readFile(sourcePath, "utf8").catch(() => null);
  if (source === null) {
    throw new Error(`missing built artifact: ${sourcePath} (run npm run build:extension)`);
  }
  const targetPath = join(targetDir, "index.mjs");
  const current = await readFile(targetPath, "utf8").catch(() => null);
  if (current === source) {
    return { changed: false, stale: false, sourcePath, targetPath };
  }

  if (check) {
    return { changed: false, stale: true, sourcePath, targetPath };
  }

  await mkdir(targetDir, { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.tmp`;
  await writeFile(tempPath, source, "utf8");
  await rename(tempPath, targetPath);
  return { changed: true, stale: false, sourcePath, targetPath };
}

function parseArgs(argv) {
  let piRoot = join(homedir(), ".pi");
  let check = false;
  let sourcePath = join(repoRoot, "dist", "pi-checkpoints", "index.mjs");
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") check = true;
    else if (arg === "--pi-root") piRoot = resolve(String(argv[++index] ?? ""));
    else if (arg === "--source") sourcePath = resolve(String(argv[++index] ?? ""));
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/sync-extension.mjs [--pi-root <dir>] [--source <file>] [--check]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { piRoot, check, sourcePath };
}

async function main() {
  const { piRoot, check, sourcePath } = parseArgs(process.argv.slice(2));
  const result = await syncCheckpointExtension({
    sourcePath,
    targetDir: checkpointPackageDir(piRoot),
    check,
  });
  if (result.stale) {
    process.stderr.write(
      `sync-extension: STALE ${result.targetPath} (source ${result.sourcePath})\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `sync-extension: ${result.changed ? "updated" : "unchanged"} ${result.targetPath}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`sync-extension: ${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  });
}
