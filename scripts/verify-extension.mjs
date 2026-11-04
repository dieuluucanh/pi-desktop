#!/usr/bin/env node
/**
 * Pre-publish gate for `packages/checkpoints` (2026-10-31 re-home plan).
 *
 *   npm run verify:extension
 *
 * `npm run build:extension` must have produced `index.mjs` first. This gate
 * checks the manifest identity, the tracked files, the npm tarball, the loader
 * contract and that the changelog documents the manifest version. It never
 * writes, tags or publishes.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CHANGELOG_FILE,
  ENTRY_FILE,
  PACKAGE_DIR,
  REQUIRED_FILES,
  documentsVersion,
  readChangelog,
  readManifest,
  validateManifest,
  validateTarballFiles,
} from "./extension-package.mjs";

const NPM =
  process.platform === "win32"
    ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "npm"] }
    : { command: "npm", args: [] };

function runNpm(args) {
  return spawnSync(NPM.command, [...NPM.args, ...args], {
    cwd: PACKAGE_DIR,
    encoding: "utf8",
    timeout: 120_000,
  });
}

function parsePackJson(stdout) {
  const text = String(stdout ?? "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function loadSmokeTest(errors) {
  const entry = join(PACKAGE_DIR, ENTRY_FILE);
  const code = `
    const module = await import(${JSON.stringify(pathToFileURL(entry).href)});
    await module.default({
      on: () => () => undefined,
      appendEntry: () => undefined,
      registerCommand: () => undefined,
    });
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: PACKAGE_DIR,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) {
    const tail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().split(/\r?\n/).slice(-8);
    errors.push(`loader smoke test failed:\n${tail.join("\n")}`);
  }
}

function main() {
  const manifest = readManifest();
  const errors = validateManifest(manifest);

  for (const file of REQUIRED_FILES) {
    if (!existsSync(join(PACKAGE_DIR, file))) errors.push(`missing tracked package file: ${file}`);
  }
  for (const entry of manifest.pi?.extensions ?? []) {
    if (!existsSync(join(PACKAGE_DIR, entry))) {
      errors.push(`pi.extensions entry does not exist: ${entry}`);
    }
  }
  if (!existsSync(join(PACKAGE_DIR, ENTRY_FILE))) {
    errors.push(
      "missing built artifact packages/checkpoints/index.mjs (run npm run build:extension)",
    );
  }

  let packed = 0;
  if (errors.length === 0) {
    const result = runNpm(["pack", "--dry-run", "--json"]);
    if (result.status !== 0) {
      const tail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().split(/\r?\n/).slice(-8);
      errors.push(`npm pack --dry-run --json failed:\n${tail.join("\n")}`);
    } else {
      const parsed = parsePackJson(result.stdout);
      const files = (parsed?.[0]?.files ?? []).map((file) => String(file.path ?? ""));
      if (files.length === 0) errors.push("could not parse the npm pack file list");
      else {
        packed = files.length;
        errors.push(...validateTarballFiles(files));
      }
    }

    const changelog = readChangelog();
    if (!documentsVersion(changelog, manifest.version)) {
      errors.push(`${CHANGELOG_FILE} does not document ${manifest.version}`);
    }
    loadSmokeTest(errors);
  }

  if (errors.length > 0) {
    process.stderr.write(
      `verify-extension: ${manifest.name}@${manifest.version} is not publishable\n`,
    );
    for (const error of errors) process.stderr.write(`  - ${error}\n`);
    return 1;
  }

  process.stdout.write(
    `verify-extension: ${manifest.name}@${manifest.version} ok (${packed} files packed)\n`,
  );
  return 0;
}

process.exitCode = main();
