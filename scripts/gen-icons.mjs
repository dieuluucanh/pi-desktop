#!/usr/bin/env node
/**
 * Generate `assets/icon.ico` — the Windows app and installer icon — from the
 * committed PNG rasters.
 *
 *   npm run icons:gen
 *
 * The output is committed, so `npm run package:*` never depends on a converter
 * at package time and a release can be reproduced offline.
 *
 * `png-to-ico` embeds each PNG at its native size and never resizes, so the size
 * list is exactly the rasters that exist for Windows: 16, 32, 128 and 256. The
 * 512 px file is excluded because an ICO directory entry stores its dimensions
 * in a single byte (256 is the ceiling), and the 80 px file is excluded because
 * it is the Pi for Office add-in's hosted size, not a Windows icon size. Windows
 * scales the 32 px entry up to 48 when it wants one.
 *
 * macOS `.icns` and the Linux icon set are not generated here: electron-builder
 * derives both from `assets/icon-512.png` (see `electron-builder.yml`).
 */

import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pngToIco from "png-to-ico";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = join(repoRoot, "assets");
const icoPath = join(assetsDir, "icon.ico");

/** In the order Windows prefers to find them. */
const SIZES = [16, 32, 128, 256];

function fail(message) {
  process.stderr.write(`gen-icons: ${message}\n`);
  process.exit(1);
}

function log(message) {
  process.stderr.write(`${message}\n`);
}

/**
 * PNG stores its dimensions in the IHDR chunk, which is always the first chunk:
 * 8 signature bytes, 4 length, 4 type, then width and height as big-endian u32.
 *
 * Read rather than trusted, so a mislabelled asset fails here instead of
 * producing an `.ico` whose directory lies about the image inside it.
 */
function pngSize(bytes, file) {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) {
    fail(`${file} is not a PNG`);
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function main() {
  const sources = [];
  for (const size of SIZES) {
    const file = join(assetsDir, `icon-${size}.png`);
    let bytes;
    try {
      bytes = await readFile(file);
    } catch (error) {
      fail(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const { width, height } = pngSize(bytes, file);
    if (width !== size || height !== size) {
      fail(`${file} is ${width}x${height}, expected ${size}x${size}`);
    }
    sources.push(file);
  }

  const ico = await pngToIco(sources);
  verify(ico);

  // Write through a temp file and rename, so an interrupted run never leaves a
  // half-written icon where the build expects a complete one (repo convention).
  const tempPath = `${icoPath}.tmp`;
  try {
    await writeFile(tempPath, ico);
    await rename(tempPath, icoPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    fail(`cannot write ${icoPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  log(`gen-icons: wrote ${icoPath} (${ico.length} bytes, ${SIZES.join("/")})`);
}

/** The ICO container: a 6-byte header, then one 16-byte entry per image. */
function verify(ico) {
  if (ico.length < 6 || ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) {
    fail("generated .ico does not start with the 0/1 ICO header");
  }
  const count = ico.readUInt16LE(4);
  if (count !== SIZES.length) fail(`generated .ico has ${count} entries, expected ${SIZES.length}`);
  const widths = [];
  for (let index = 0; index < count; index += 1) {
    // 0 means 256: the field is a single byte.
    widths.push(ico.readUInt8(6 + index * 16) || 256);
  }
  if (!widths.includes(256)) fail(`generated .ico has no 256px entry (${widths.join("/")})`);
}

await main();
