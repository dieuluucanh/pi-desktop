/**
 * Release-asset guard: does this `release/` directory hold what the release
 * workflow is about to upload?
 *
 * The two failure modes this catches are silent and expensive:
 *
 *  1. an artefact the target should have produced is missing (a skipped arch, a
 *     failed `.blockmap`, a portable exe that never got renamed), and
 *  2. an `electron-updater` manifest names a file that is not there — the feed
 *     then serves a download URL that 404s for every installed app, which no
 *     amount of "the build succeeded" detects.
 *
 * It is a script, not app code: it runs before `gh release upload` in the
 * release workflow and locally after `npm run package:*`. The expected names are
 * the ones electron-builder actually writes (verified against the 0.1.0–0.4.0
 * artefacts): `${os}` renders as `win`/`linux`/`mac`, and `${arch}` as `x64`,
 * `x86_64`, `amd64` or `arm64` depending on the target.
 */

import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** The platforms the release workflow builds. */
export const RELEASE_PLATFORMS = ["win", "linux", "mac"];

/**
 * The artefacts a platform's job must leave in `release/`.
 *
 * Deliberately exact: a tolerant "any .dmg" check would pass while the arm64
 * dmg was the only one produced. Linux is built as one job per architecture, so
 * `arch` narrows the list to that job's artefacts; omitting it asks for both
 * (what a local `npm run package:linux` produces).
 */
export function expectedAssets(platform, version, arch) {
  const base = `Pi-Desktop-${version}`;
  if (arch !== undefined && arch !== "x64" && arch !== "arm64") {
    throw new Error(`release-assets: unsupported arch "${arch}" (expected x64 or arm64)`);
  }
  if (arch !== undefined && platform !== "linux") {
    throw new Error(
      `release-assets: --arch scopes the Linux matrix only (${platform} builds its arches in one job)`,
    );
  }
  switch (platform) {
    case "win":
      return [
        `${base}-win-x64-setup.exe`,
        `${base}-win-x64-setup.exe.blockmap`,
        `${base}-win-x64-portable.exe`,
        "latest.yml",
      ];
    case "linux": {
      const x64 = [
        `${base}-linux-x86_64-appimage.AppImage`,
        `${base}-linux-amd64-deb.deb`,
        "latest-linux.yml",
      ];
      const arm64 = [
        `${base}-linux-arm64-appimage.AppImage`,
        `${base}-linux-arm64-deb.deb`,
        "latest-linux-arm64.yml",
      ];
      if (arch === "x64") return x64;
      if (arch === "arm64") return arm64;
      return [x64[0], x64[1], arm64[0], arm64[1], x64[2], arm64[2]];
    }
    case "mac":
      return [
        `${base}-mac-arm64.dmg`,
        `${base}-mac-x64.dmg`,
        `${base}-mac-arm64.zip`,
        `${base}-mac-x64.zip`,
        "latest-mac.yml",
      ];
    default:
      throw new Error(
        `release-assets: unsupported platform "${platform}" (expected ${RELEASE_PLATFORMS.join(", ")})`,
      );
  }
}

/**
 * The `electron-updater` manifests a platform owns. Windows and macOS have one
 * per release; Linux writes one per architecture.
 */
export function platformManifests(platform, arch) {
  switch (platform) {
    case "win":
      return ["latest.yml"];
    case "linux":
      if (arch === "x64") return ["latest-linux.yml"];
      if (arch === "arm64") return ["latest-linux-arm64.yml"];
      return ["latest-linux.yml", "latest-linux-arm64.yml"];
    case "mac":
      return ["latest-mac.yml"];
    default:
      throw new Error(`release-assets: unsupported platform "${platform}"`);
  }
}

function unquote(value) {
  const trimmed = (value ?? "").trim();
  return trimmed.replace(/^['"]|['"]$/g, "");
}

/**
 * Reads the handful of keys this guard needs out of an `electron-updater`
 * manifest (`version`, `files[].url`, `path`). A full YAML parser would be a
 * dependency for three scalars and a list.
 */
export function parseManifest(text) {
  const version = /^version:\s*(.+)$/m.exec(text)?.[1];
  const urls = [...text.matchAll(/^\s*(?:-\s*)?url:\s*(.+)$/gm)].map((match) => unquote(match[1]));
  const path = /^path:\s*(.+)$/m.exec(text)?.[1];
  return {
    version: version === undefined ? null : unquote(version),
    // The updater downloads `path`; `files` carries the checksum list. Both must
    // resolve on disk, and a manifest that repeats a name is not a failure.
    urls: [...new Set([...urls, ...(path === undefined ? [] : [unquote(path)])])],
  };
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Inspects a release directory for one platform.
 *
 * Returns every problem it found instead of throwing on the first one: a broken
 * release is usually broken in more than one place, and the workflow log should
 * say so in one pass.
 */
export function inspectRelease({ dir, platform, version, arch }) {
  const root = resolve(dir);
  const expected = expectedAssets(platform, version, arch);
  const missing = expected.filter((name) => !isFile(join(root, name)));

  const manifests = {};
  const problems = [];
  for (const name of platformManifests(platform, arch)) {
    const file = join(root, name);
    if (!isFile(file)) continue; // already reported as missing
    const parsed = parseManifest(readFileSync(file, "utf8"));
    manifests[name] = parsed;
    if (parsed.version !== version) {
      problems.push(`${name}: version is ${parsed.version ?? "(missing)"}, expected ${version}`);
    }
    if (parsed.urls.length === 0) {
      problems.push(`${name}: lists no download url`);
    }
    for (const url of parsed.urls) {
      if (!isFile(join(root, url))) {
        problems.push(`${name}: names ${url}, which is not in ${root}`);
      }
    }
  }

  return { ok: missing.length === 0 && problems.length === 0, missing, problems, manifests };
}

function packageVersion() {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  return typeof packageJson.version === "string" ? packageJson.version : "";
}

function main() {
  const { values } = parseArgs({
    options: {
      platform: { type: "string" },
      dir: { type: "string", default: "release" },
      version: { type: "string" },
      // Linux only: the release matrix builds one architecture per job, so the
      // guard must not demand the other arch's artefacts (and its manifest).
      arch: { type: "string" },
    },
    allowPositionals: false,
  });

  const platform = values.platform;
  if (!platform) {
    process.stderr.write(
      `release-assets: --platform is required (${RELEASE_PLATFORMS.join(", ")})\n`,
    );
    process.exit(2);
  }

  let result;
  try {
    result = inspectRelease({
      dir: values.dir,
      platform,
      version: values.version ?? packageVersion(),
      arch: values.arch,
    });
  } catch (error) {
    process.stderr.write(`release-assets: ${error instanceof Error ? error.message : error}\n`);
    process.exit(2);
  }

  if (result.ok) {
    const counts = Object.entries(result.manifests)
      .map(([name, manifest]) => `${name} (${manifest.urls.length} file(s))`)
      .join(", ");
    process.stdout.write(
      `release-assets: ${platform} ok — ${expectedAssets(platform, values.version ?? packageVersion(), values.arch).length} asset(s); ${counts}\n`,
    );
    return;
  }

  for (const name of result.missing) process.stderr.write(`release-assets: missing ${name}\n`);
  for (const problem of result.problems) process.stderr.write(`release-assets: ${problem}\n`);
  process.exit(1);
}

// Importable from the tests without running the CLI.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
