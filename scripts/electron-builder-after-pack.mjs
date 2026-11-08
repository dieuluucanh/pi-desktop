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
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  assertNativeFloor,
  isUsableBinary,
  nativeCandidatePaths,
  parseReadelfVersionNeeds,
} from "./lib/node-pty-artifact.mjs";

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
export function buildInfoDocument({ version, channel, commit, builtAt, platform, macSigning }) {
  const validChannel = channel === "release" || channel === "local" ? channel : "unknown";
  return {
    channel: validChannel,
    version: typeof version === "string" && version.length > 0 ? version : null,
    commit: typeof commit === "string" && commit.length > 0 ? commit : null,
    builtAt: typeof builtAt === "string" && builtAt.length > 0 ? builtAt : null,
    macSigning: macSigningFor(platform, macSigning),
  };
}

/**
 * Reads how the package was signed from the build environment.
 *
 * The hook runs before electron-builder signs, so it cannot inspect the result;
 * the workflow states the identity it passed instead. `PI_MAC_SIGNING` is only
 * meaningful for a macOS target (`adhoc` in CI today, `developer-id` once an
 * Apple identity exists). The app uses it to decide whether Squirrel.Mac could
 * ever accept an in-app update, so "not set" must mean `none`, never `adhoc`.
 */
export function macSigningFromEnv(env = {}) {
  const explicit = env.PI_MAC_SIGNING;
  if (explicit === "developer-id" || explicit === "adhoc") return explicit;
  return "none";
}

/** Signing is only recorded for macOS; every other target reports `none`. */
function macSigningFor(platform, signing) {
  if (platform !== "darwin") return "none";
  return signing === "developer-id" || signing === "adhoc" ? signing : "none";
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

export function pruneNodePty(resourcesDir, target) {
  const root = join(resourcesDir, "app.asar.unpacked", "node_modules", "node-pty");
  if (!existsSync(root))
    return {
      found: false,
      removed: [],
      kept: null,
      binary: null,
      helper: null,
      helperPatched: false,
    };

  const removed = [];
  // Sources, vendored deps and the prebuild scripts are build-time only; the
  // tarball is ~64 MB unpacked and every installer would otherwise carry all of
  // it. `lib/` and the target platform's binaries are what actually runs.
  for (const name of ["deps", "src", "third_party", "scripts", "typings"]) {
    const candidate = join(root, name);
    if (!existsSync(candidate)) continue;
    rmSync(candidate, { recursive: true, force: true });
    removed.push(name);
  }
  for (const name of readdirSync(root)) {
    if (!name.endsWith(".pdb")) continue;
    rmSync(join(root, name), { force: true });
    removed.push(name);
  }

  const prebuilds = join(root, "prebuilds");
  if (existsSync(prebuilds)) {
    for (const entry of readdirSync(prebuilds, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === target) continue;
      rmSync(join(prebuilds, entry.name), { recursive: true, force: true });
      removed.push(`prebuilds/${entry.name}`);
    }
  }

  // A copy/repack can drop the executable bit, and macOS fails at spawn time
  // rather than at package time. Re-apply it here, then require it: node-pty
  // runs `prebuilds/<target>/spawn-helper` to create the PTY, and an
  // unexecutable or missing helper surfaces as the opaque
  // `posix_spawnp failed` on the first terminal open.
  const helper = join(root, "prebuilds", target, "spawn-helper");
  if (target.startsWith("darwin-")) {
    if (!existsSync(helper)) {
      throw new Error(
        `afterPack: ${target} has no node-pty spawn-helper at ${helper}. ` +
          `macOS cannot open a PTY without it; the npm tarball ships ` +
          `prebuilds/${target}/spawn-helper next to pty.node.`,
      );
    }
    chmodSync(helper, 0o755);
    // Windows has no executable bit, so the mode check is only meaningful on a
    // POSIX host — which is the only place a darwin package is ever built.
    if (process.platform !== "win32" && (statSync(helper).mode & 0o111) === 0) {
      throw new Error(
        `afterPack: ${helper} is not executable after chmod; macOS refuses to spawn it.`,
      );
    }
  }

  // node-pty computes the macOS helper path at require() time; the packaged
  // copy needs the idempotent rewrite (see patchNodePtyHelperPath).
  const helperPatch = patchNodePtyHelperPath(root);

  // Fail-closed (2026-11-08 linux-terminal plan, step 4): a package that cannot
  // open a PTY must never be published. The 2026-11-05 plan asked for this
  // throw; the implementation only pruned, so a Linux artifact shipped without
  // a loadable binary and the terminal died at the first click.
  const candidates = nativeCandidatePaths(root, target);
  const binary = candidates.find((candidate) => isUsableBinary(candidate)) ?? null;
  if (!binary) {
    throw new Error(
      `afterPack: node-pty has no usable binary for ${target} (searched: ${candidates.join(", ")}). ` +
        `Linux packages must run \`npm run pty:linux -- --arch <x64|arm64>\` first; ` +
        `Windows/macOS use the prebuild from the npm tarball.`,
    );
  }
  if (target.startsWith("linux-")) {
    const runnerBuild = candidates[1];
    if (existsSync(runnerBuild)) {
      throw new Error(
        `afterPack: ${target} must ship the pinned prebuild (${candidates[0]}), not ${runnerBuild}. ` +
          `A runner-compiled binary is linked against the runner's glibc and breaks older ` +
          `distributions; run \`npm run pty:linux -- --arch <x64|arm64>\`.`,
      );
    }
    if (binary !== candidates[0]) {
      throw new Error(
        `afterPack: ${target} must ship the pinned prebuild (${candidates[0]}) ` +
          `but the package only contains ${binary}. Run \`npm run pty:linux -- --arch <x64|arm64>\`.`,
      );
    }
  }

  return {
    found: true,
    removed: removed.sort(),
    kept: target,
    binary,
    helper: target.startsWith("darwin-") ? helper : null,
    helperPatched: helperPatch.patched,
  };
}

/** The `app.asar` rewrite node-pty 1.1.0 ships, verbatim from `lib/unixTerminal.js`. */
const ASAR_HELPER_REWRITE = [
  "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
  "helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');",
].join("\n");

/** The idempotent rewrite that replaces it. */
const ASAR_HELPER_REWRITE_FIXED = [
  "// Pi Desktop: node-pty@1.1.0 rewrote app.asar -> app.asar.unpacked",
  "// unconditionally. When the module already lives in app.asar.unpacked (the",
  "// host runs under plain Node, not Electron's asar shim) the path became",
  "// app.asar.unpacked.unpacked and macOS rejected every terminal.open with",
  "// the opaque 'posix_spawnp failed'. Mirrors node-pty PR #924.",
  "if (",
  "  !helperPath.includes('app.asar.unpacked') &&",
  "  !helperPath.includes('node_modules.asar.unpacked')",
  ") {",
  "  helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
  "  helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');",
  "}",
].join("\n");

/**
 * Makes node-pty's `spawn-helper` path resolution idempotent in the packaged
 * copy.
 *
 * Only macOS execs the helper, but the rewrite runs on every platform and the
 * patch keeps the installed package identical everywhere. Fail-closed: when the
 * expected lines are gone, node-pty changed and the bug has to be re-evaluated
 * rather than silently shipped.
 */
export function patchNodePtyHelperPath(moduleDir) {
  const file = join(moduleDir, "lib", "unixTerminal.js");
  if (!existsSync(file)) {
    throw new Error(`afterPack: node-pty has no lib/unixTerminal.js at ${file}.`);
  }
  const source = readFileSync(file, "utf8");
  if (source.includes("Pi Desktop: node-pty@1.1.0 rewrote app.asar")) {
    return { patched: false, file, reason: "already-patched" };
  }
  if (!source.includes(ASAR_HELPER_REWRITE)) {
    throw new Error(
      `afterPack: ${file} no longer contains node-pty's helper rewrite. ` +
        `Re-check the app.asar.unpacked.unpacked bug (node-pty PR #924) before shipping.`,
    );
  }
  writeFileSync(file, source.replace(ASAR_HELPER_REWRITE, ASAR_HELPER_REWRITE_FIXED));
  return { patched: true, file, reason: "patched" };
}

/** The terminal host bundle must be inside the asar-unpacked tree. */
export function assertTerminalBundle(resourcesDir) {
  const bundle = join(resourcesDir, "app.asar.unpacked", "out", "host", "terminal.mjs");
  if (!existsSync(bundle)) {
    throw new Error(
      `afterPack: the terminal host bundle is missing at ${bundle}. ` +
        `Run \`npm run build\`: the terminal entry is part of the host build.`,
    );
  }
  return bundle;
}

/**
 * Reads the ELF's version needs and fails the package when it needs a newer
 * runtime than {@link NATIVE_FLOOR}. A missing `readelf` is an error, not a
 * skip: the floor check is part of the deliverable.
 */
export function verifyNativeFloor(binary) {
  let output;
  try {
    output = execFileSync("readelf", ["--version-info", binary], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    throw new Error(
      `afterPack: could not run readelf on ${binary} ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        `Install binutils (readelf) to package Linux.`,
      { cause: error },
    );
  }
  const measured = assertNativeFloor(parseReadelfVersionNeeds(output));
  return { binary, ...measured };
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

  // The terminal is a separate binary + host bundle; check both before the
  // installers exist, so a broken package fails here instead of on a user's
  // first "New terminal" click (2026-11-08 linux-terminal plan, step 4).
  assertTerminalBundle(resourcesDir);
  const pty = pruneNodePty(resourcesDir, target);
  if (pty.found) {
    process.stdout.write(
      `afterPack: node-pty pruned (${pty.removed.length} entries, keeping prebuilds/${pty.kept}) ` +
        `-> ${pty.binary}\n`,
    );
    if (context.electronPlatformName === "linux") {
      const floor = verifyNativeFloor(pty.binary);
      process.stdout.write(
        `afterPack: node-pty requires GLIBC ≤ ${floor.glibc ?? "none"} / ` +
          `GLIBCXX ≤ ${floor.glibcxx ?? "none"}\n`,
      );
    }
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
  const macSigning = macSigningFromEnv(process.env);
  try {
    const targetFile = writeBuildInfo(resourcesDir, {
      version: packager.appInfo?.version,
      channel,
      commit,
      builtAt: new Date().toISOString(),
      platform: context.electronPlatformName,
      macSigning,
    });
    process.stdout.write(
      `afterPack: build-info ${channel} ${commit ?? "unknown"} -> ${targetFile}\n`,
    );
    if (context.electronPlatformName === "darwin") {
      process.stdout.write(`afterPack: macOS signing recorded as ${macSigning}\n`);
    }
  } catch (error) {
    process.stderr.write(
      `afterPack: could not write build info: ${error instanceof Error ? error.message : error}\n`,
    );
  }
}
