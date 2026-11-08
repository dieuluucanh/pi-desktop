/**
 * Pure helpers for the packaged `node-pty` binary (2026-11-08 linux-terminal
 * plan, step 4).
 *
 * `node-pty@1.1.0` ships no Linux prebuild, so every Linux package carries a
 * binary compiled somewhere. That binary is loaded by the bundled Node with the
 * *host's* glibc, which is why the runner that compiled it must be older than
 * every supported distribution. The 0.8.0 package was built on `ubuntu-latest`
 * (glibc 2.42) and failed on Linux Mint 22 (glibc 2.39) with
 * `version 'GLIBC_2.42' not found`.
 *
 * These helpers are kept out of the hook so they are unit-testable with a
 * `readelf` fixture and no packaging run: path resolution, version parsing and
 * the floor assertion.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The oldest runtime a package may require (Debian 11 / Ubuntu 20.04):
 * glibc 2.31 and GCC 10's `GLIBCXX_3.4.28`. Both are documented in
 * `docs/architecture/terminal.md`.
 */
export const NATIVE_FLOOR = Object.freeze({ glibc: "2.31", glibcxx: "3.4.28" });

/**
 * Where `node-pty`'s loader looks, in its order. `target` is the
 * `<platform>-<arch>` string `runtimeTarget()` produces (`linux-x64`, …).
 */
export function nativeCandidatePaths(moduleDir, target) {
  return [
    join(moduleDir, "prebuilds", target, "pty.node"),
    join(moduleDir, "build", "Release", "pty.node"),
  ];
}

/** True for a non-empty regular file; an empty `.node` is a failed copy. */
export function isUsableBinary(target) {
  try {
    return existsSync(target) && statSync(target).isFile() && statSync(target).size > 0;
  } catch {
    return false;
  }
}

/**
 * Reads the version needs out of `readelf --version-info` output. Only the
 * `Name:` columns matter; `GLIBC_PRIVATE` carries no version and is ignored.
 */
export function parseReadelfVersionNeeds(text) {
  const needs = { glibc: [], glibcxx: [], cxxabi: [] };
  for (const match of text.matchAll(/\b(GLIBC|GLIBCXX|CXXABI)_([0-9][0-9.]*)\b/g)) {
    const family = match[1];
    const version = match[2];
    if (!family || !version) continue;
    const list =
      family === "GLIBC" ? needs.glibc : family === "GLIBCXX" ? needs.glibcxx : needs.cxxabi;
    if (!list.includes(version)) list.push(version);
  }
  return needs;
}

function segments(version) {
  return version.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

/** Numeric dotted-version comparison; `2.2.5` < `2.31` (not lexicographic). */
export function compareVersions(left, right) {
  const a = segments(left);
  const b = segments(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const one = a[index] ?? 0;
    const other = b[index] ?? 0;
    if (one !== other) return one < other ? -1 : 1;
  }
  return 0;
}

export function maxVersion(versions) {
  let best = null;
  for (const version of versions) {
    if (best === null || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

/**
 * Throws when the binary needs a newer runtime than {@link NATIVE_FLOOR}.
 * Returns the measured maxima so the hook can print them.
 */
export function assertNativeFloor(needs, floor = NATIVE_FLOOR) {
  const glibc = maxVersion(needs.glibc);
  const glibcxx = maxVersion(needs.glibcxx);
  const problems = [];
  if (glibc !== null && compareVersions(glibc, floor.glibc) > 0) {
    problems.push(`GLIBC_${glibc} > GLIBC_${floor.glibc}`);
  }
  if (glibcxx !== null && compareVersions(glibcxx, floor.glibcxx) > 0) {
    problems.push(`GLIBCXX_${glibcxx} > GLIBCXX_${floor.glibcxx}`);
  }
  if (problems.length > 0) {
    throw new Error(
      `node-pty requires a newer runtime than the support floor (${problems.join(", ")}). ` +
        `Build it in the pinned container: \`npm run pty:linux -- --arch <x64|arm64>\`.`,
    );
  }
  return { glibc, glibcxx };
}

/**
 * What `scripts/build-node-pty.mjs` records next to the binary. It is the input
 * to the freshness check: a node-pty bump, a Node bump or a different container
 * image invalidates the artifact instead of silently reusing it.
 */
export function ptyBuildInfo(input) {
  return {
    nodePty: input.nodePtyVersion,
    node: input.nodeVersion,
    image: input.image,
    imageDigest: input.imageDigest ?? null,
    floor: input.floor ?? NATIVE_FLOOR,
    builtAt: input.builtAt ?? new Date().toISOString(),
  };
}

/** True when an existing artifact was built for exactly this toolchain. */
export function isPtyPrebuildFresh(existing, expected) {
  if (!existing || typeof existing !== "object") return false;
  return (
    existing.nodePty === expected.nodePty &&
    existing.node === expected.node &&
    existing.image === expected.image &&
    existing.floor?.glibc === expected.floor.glibc &&
    existing.floor?.glibcxx === expected.floor.glibcxx
  );
}

/**
 * The docker invocation for one architecture. Pure so the test suite can assert
 * the platform mapping, the mount and the build/copy/readelf steps without
 * running a container.
 *
 * The module is copied to `/tmp` inside the container, so node-gyp's build tree
 * never lands in the mounted workspace as root; only `pty.node` and the readelf
 * report are written back.
 */
export function linuxPtyContainer(input) {
  const platform = input.arch === "x64" ? "linux/amd64" : "linux/arm64";
  const script = [
    "set -euo pipefail",
    "module_dir=$1; node_path=$2; node_gyp=$3; node_version=$4; output_dir=$5",
    "apt-get update -qq",
    "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends " +
      "build-essential python3 ca-certificates binutils",
    "rm -rf /tmp/node-pty",
    'cp -a "$module_dir" /tmp/node-pty',
    "cd /tmp/node-pty",
    '"$node_path" "$node_gyp" rebuild --target="$node_version" --release',
    'mkdir -p "$output_dir"',
    'cp build/Release/pty.node "$output_dir/pty.node"',
    'chmod 0755 "$output_dir/pty.node"',
    'readelf --version-info "$output_dir/pty.node" > "$output_dir/readelf.txt"',
  ].join("\n");

  const args = [
    "run",
    "--rm",
    "--platform",
    platform,
    "-v",
    `${input.repoDir}:/work`,
    "-w",
    "/work",
    "-e",
    "HOME=/tmp",
    input.image,
    "bash",
    "-c",
    script,
    "_",
    input.moduleDir,
    input.nodePath,
    input.nodeGyp,
    input.nodeVersion,
    input.outputDir,
  ];
  return { platform, args, script };
}
