/**
 * Copy the brand assets from the repository's `assets/` directory into the
 * site's public directory. The originals stay the only editable copy; this
 * script is idempotent and only writes when the bytes differ.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(SITE_ROOT, "..");
const SOURCE = join(REPO_ROOT, "assets");
const DESTINATION = join(SITE_ROOT, "public", "brand");
const SOURCE_DESTINATION = join(SITE_ROOT, "src", "assets", "brand");

const FILES = [
  "pi-desktop-logo-full.svg",
  "pi-desktop-icon.svg",
  "icon-32.png",
  "icon-256.png",
  "icon-512.png",
];

export function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function syncBrand({
  source = SOURCE,
  destination = DESTINATION,
  sourceDestination = SOURCE_DESTINATION,
} = {}) {
  mkdirSync(destination, { recursive: true });
  mkdirSync(sourceDestination, { recursive: true });
  const copied = [];
  for (const name of FILES) {
    const from = join(source, name);
    if (!existsSync(from)) throw new Error(`brand asset missing: ${from}`);
    const to = join(destination, name);
    copyFileSync(from, to);
    copyFileSync(from, join(sourceDestination, name));
    if (name === "pi-desktop-icon.svg") {
      copyFileSync(from, join(SITE_ROOT, "public", "favicon.svg"));
    }
    copied.push({ name, hash: hashFile(to) });
  }
  return copied;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const copied = syncBrand();
    console.log(`sync-brand: ${copied.length} assets`);
  } catch (error) {
    console.error(`sync-brand: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
