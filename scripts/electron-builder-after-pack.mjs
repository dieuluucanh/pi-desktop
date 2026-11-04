/**
 * electron-builder `afterPack` hook — finish the packaged runtime shims.
 *
 * `scripts/gen-shims.mjs` writes the shims when the runtime is *fetched*, so the
 * copies that travel in `extraResources` carry development paths:
 *
 *   dev shim:      <repo>/resources/runtime/bin/pi -> <repo>/out/host/index.mjs
 *   packaged app:  <resources>/runtime/bin/pi      -> <resources>/app.asar.unpacked/out/host/index.mjs
 *
 * Both the app's own PATH prefix (`runtimeEnvOverrides`) and any extension that
 * shells out to `pi`/`node`/`npm`/`npx` resolve through those shims, so without
 * this hook a packaged install runs a host from `out/host` *inside the repo it
 * was built in* — which exists on the builder's machine and nowhere else.
 *
 * `afterPack` is the earliest hook that can do this: `extraResources` is copied
 * after the asar is packed, and the shim directory only exists once that has
 * happened (`platformPackager.js`: `copyAppFiles` -> extra resources ->
 * `emitAfterPack`). The hook re-runs the same generator with `--mode packaged`,
 * so there is still one definition of what a shim looks like.
 *
 * The hook also prunes the bundled runtimes down to the one this package runs
 * (see {@link pruneForeignRuntimes}); `extraResources` copies `resources/runtime`
 * wholesale, which is too much when the checkout holds more than one platform.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** `Arch` from `builder-util`, inlined so the hook needs no extra dependency. */
const ARCH_NAMES = new Map([
  [0, "ia32"],
  [1, "x64"],
  [2, "armv7l"],
  [3, "arm64"],
]);

/**
 * `context.electronPlatformName` + the arch -> the runtime directory name.
 *
 * A universal macOS build is refused rather than guessed at: one
 * `runtime/node/<platform>-<arch>` directory cannot serve both slices, and this
 * repo's `mac.target` lists arm64 and x64 separately anyway.
 */
function runtimeTarget(context) {
  const arch = ARCH_NAMES.get(context.arch);
  if (!arch) {
    throw new Error(
      `afterPack: unsupported arch ${context.arch} (a universal build has no single bundled runtime).`,
    );
  }
  return `${context.electronPlatformName}-${arch}`;
}

/**
 * Deletes every bundled runtime except the one this package runs.
 *
 * `extraResources` copies `resources/runtime` wholesale, and a checkout may hold
 * runtimes for other platforms: `package:linux`/`package:mac` fetch several, and
 * a Windows checkout can inherit a foreign one. Shipping them is wrong twice
 * over — every installer grows by roughly 100 MB per runtime, and on Windows the
 * NSIS step runs 7za over the packaged app, which exits 1 on the Linux tarball's
 * `bin/{npm,npx,corepack}` symlinks ("The directory name is invalid"), so no
 * installer is produced at all. Pruning here keeps each package to its own
 * platform/arch; `node.lock.json` and the runtime README are files and stay.
 *
 * Staging directories left by an interrupted `runtime:fetch` are directories too,
 * so they are removed as well.
 */
export function pruneForeignRuntimes(nodeDir, target) {
  const removed = [];
  for (const entry of readdirSync(nodeDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === target) continue;
    rmSync(join(nodeDir, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed.sort();
}

/** The file this hook writes; `src/shared/build-info.ts` is the reader. */
export const BUILD_INFO_FILE = "build-info.json";

/**
 * Decides whether this package came from a local checkout or release CI.
 *
 * Explicit `PI_BUILD_CHANNEL` wins so a release workflow can be unambiguous;
 * otherwise GitHub Actions means release and every other environment means
 * local. A local package is still a valid build, it just has no published feed.
 */
export function buildChannelFromEnv(env = {}) {
  const explicit = env.PI_BUILD_CHANNEL;
  if (explicit === "release" || explicit === "local") return explicit;
  if (env.GITHUB_ACTIONS === "true") return "release";
  return "local";
}

/** The JSON document written into `resources/build-info.json`. */
export function buildInfoDocument({ version, channel, commit, builtAt }) {
  const validChannel = channel === "release" || channel === "local" ? channel : "unknown";
  return {
    channel: validChannel,
    version: typeof version === "string" && version.length > 0 ? version : null,
    commit: typeof commit === "string" && commit.length > 0 ? commit : null,
    builtAt: typeof builtAt === "string" && builtAt.length > 0 ? builtAt : null,
  };
}

/** Writes the provenance file; returns its path so the hook can log it. */
export function writeBuildInfo(resourcesDir, info) {
  const target = join(resourcesDir, BUILD_INFO_FILE);
  writeFileSync(target, `${JSON.stringify(buildInfoDocument(info), null, 2)}\n`, "utf8");
  return target;
}

/** Short commit when the build host has a git checkout; null otherwise. */
function gitCommit(projectDir) {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return commit.length > 0 ? commit : null;
  } catch {
    return null;
  }
}

/**
 * Rewrites the shims inside the packaged app. Only the platform being packed has
 * to have a fetched runtime, so a missing one is named rather than silently
 * producing an app whose every session fails to start.
 */
export default async function afterPack(context) {
  const { packager } = context;
  const resourcesDir = packager.getResourcesDir(context.appOutDir);
  const packagedRuntime = join(resourcesDir, "runtime");
  const target = runtimeTarget(context);

  if (!existsSync(join(packagedRuntime, "node", target))) {
    throw new Error(
      `afterPack: no bundled runtime for ${target} in ${packagedRuntime}. ` +
        `Run \`npm run runtime:fetch -- --platform ${target}\` first.`,
    );
  }

  const pruned = pruneForeignRuntimes(join(packagedRuntime, "node"), target);
  if (pruned.length > 0) {
    process.stdout.write(
      `afterPack: pruned foreign runtime(s) ${pruned.join(", ")} (keeping ${target})\n`,
    );
  }

  execFileSync(
    process.execPath,
    [
      join(packager.projectDir, "scripts", "gen-shims.mjs"),
      "--platform",
      target,
      "--mode",
      "packaged",
      "--runtime-dir",
      packagedRuntime,
      "--out",
      join(packagedRuntime, "bin"),
      "--app-root",
      resourcesDir,
    ],
    { stdio: "inherit", cwd: packager.projectDir },
  );

  process.stdout.write(
    `afterPack: packaged shims written for ${target} in ${join(packagedRuntime, "bin")}\n`,
  );

  // Provenance is written last, after extraResources has been copied: the file
  // has to describe the final packaged app, not an intermediate staging tree.
  // A write failure cannot be allowed to break packaging; a missing file simply
  // degrades the updater to `unknown` (which still suppresses the old banner).
  const channel = buildChannelFromEnv(process.env);
  const commit = gitCommit(packager.projectDir);
  try {
    const targetFile = writeBuildInfo(resourcesDir, {
      version: packager.appInfo?.version,
      channel,
      commit,
      builtAt: new Date().toISOString(),
    });
    process.stdout.write(
      `afterPack: build-info ${channel} ${commit ?? "unknown"} -> ${targetFile}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `afterPack: could not write build info: ${error instanceof Error ? error.message : error}\n`,
    );
  }
}
