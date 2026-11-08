#!/usr/bin/env node
/**
 * Builds `node-pty` for Linux inside a pinned old-glibc container
 * (2026-11-08 linux-terminal plan, step 5).
 *
 * Why this exists: `node-pty@1.1.0` publishes no Linux prebuild, so a Linux
 * package must carry a binary compiled somewhere. The 0.8.0 release compiled it
 * on `ubuntu-latest` (glibc 2.42) and every user on an older distribution got
 * `Failed to load native module: pty.node` — the loader only showed the last
 * candidate, and the real error was `version 'GLIBC_2.42' not found`.
 *
 * This script compiles in `debian:bullseye` (glibc 2.31, GCC 10 →
 * `GLIBCXX_3.4.28`), writes the result to
 * `node_modules/node-pty/prebuilds/linux-<arch>/pty.node`, measures the ELF's
 * version needs with `readelf`, and deletes `build/` so node-pty's loader (which
 * checks `build/Release` first) cannot prefer an unpinned runner build.
 *
 *   npm run pty:linux                        # the host arch
 *   npm run pty:linux -- --arch x64 --arch arm64
 *   npm run pty:linux -- --check-only        # verify without Docker
 *   npm run pty:linux -- --print-plan        # show the docker command
 *
 * The image tag can be overridden with `--image` or `PI_PTY_IMAGE`; the release
 * workflow pins a digest there. The resolved digest is recorded in
 * `prebuilds/linux-<arch>/BUILD-INFO.json` for auditability.
 */

import { execFileSync } from "node:child_process";
import { chownSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  NATIVE_FLOOR,
  assertNativeFloor,
  isPtyPrebuildFresh,
  isUsableBinary,
  linuxPtyContainer,
  parseReadelfVersionNeeds,
  ptyBuildInfo,
} from "./lib/node-pty-artifact.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_IMAGE = "debian:bullseye";

/**
 * Parses the CLI. Exported for the unit test: argument handling is the part a
 * release run cannot afford to get wrong.
 */
export function parseBuildArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      arch: { type: "string", multiple: true },
      force: { type: "boolean", default: false },
      "check-only": { type: "boolean", default: false },
      "print-plan": { type: "boolean", default: false },
      image: { type: "string" },
    },
  });

  const requested = values.arch?.length ? values.arch : [process.arch];
  const arches = [];
  for (const arch of requested) {
    if (arch !== "x64" && arch !== "arm64") {
      throw new Error(`pty:linux: unsupported arch "${arch}" (expected x64 or arm64)`);
    }
    if (!arches.includes(arch)) arches.push(arch);
  }

  return {
    arches,
    force: values.force,
    checkOnly: values["check-only"],
    printPlan: values["print-plan"],
    image: values.image ?? process.env.PI_PTY_IMAGE?.trim() ?? DEFAULT_IMAGE,
  };
}

function readJson(target) {
  let text;
  try {
    text = readFileSync(target, "utf8");
  } catch (error) {
    throw new Error(
      `pty:linux: cannot read ${target} (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`pty:linux: ${target} is not valid JSON`, { cause: error });
  }
}

/** The installed and locked node-pty versions must agree before compiling. */
export function resolveNodePtyVersion(repoDir = REPO) {
  const lock = readJson(join(repoDir, "package-lock.json"));
  const locked = lock.packages?.["node_modules/node-pty"]?.version ?? null;
  const installedPath = join(repoDir, "node_modules", "node-pty", "package.json");
  if (!existsSync(installedPath)) {
    throw new Error("pty:linux: node_modules/node-pty is missing; run `npm ci` first");
  }
  const installed = readJson(installedPath).version ?? null;
  if (!locked || locked !== installed) {
    throw new Error(
      `pty:linux: node-pty lock/install mismatch (lock ${locked ?? "?"}, installed ${installed ?? "?"}); run \`npm ci\``,
    );
  }
  return installed;
}

/** The bundled Node for a Linux target, from the fetched runtime. */
export function resolveBundledNode(repoDir, arch) {
  const nodePath = join(repoDir, "resources", "runtime", "node", `linux-${arch}`, "bin", "node");
  if (!existsSync(nodePath)) {
    throw new Error(
      `pty:linux: no bundled Node at ${nodePath}; run \`npm run runtime:fetch -- --platform linux-${arch}\` first`,
    );
  }
  if (!existsSync(join(repoDir, "node_modules", "node-gyp", "bin", "node-gyp.js"))) {
    throw new Error("pty:linux: node-gyp is missing; run `npm ci` first");
  }
  const lock = readJson(join(repoDir, "resources", "runtime", "node.lock.json"));
  const version = lock.node?.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("pty:linux: resources/runtime/node.lock.json has no node.version");
  }
  return { path: nodePath, version };
}

/** Best-effort image digest; a missing inspect must not fail the build. */
function imageDigest(image) {
  try {
    const value = execFileSync(
      "docker",
      ["image", "inspect", "--format", "{{index .RepoDigests 0}}", image],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function readBuildInfo(target) {
  try {
    return JSON.parse(readFileSync(target, "utf8"));
  } catch {
    return null;
  }
}

function describe(arch, binary, info) {
  return (
    `pty:linux: ${arch} -> ${binary} ` +
    `(node-pty ${info.nodePty}, node ${info.node}, GLIBC ≤ ${info.floor.glibc}, ` +
    `GLIBCXX ≤ ${info.floor.glibcxx})`
  );
}

/** Verifies an existing artifact without running Docker. */
export function checkPrebuild(repoDir, arch) {
  const moduleDir = join(repoDir, "node_modules", "node-pty");
  const binary = join(moduleDir, "prebuilds", `linux-${arch}`, "pty.node");
  const infoPath = join(moduleDir, "prebuilds", `linux-${arch}`, "BUILD-INFO.json");
  if (!isUsableBinary(binary)) {
    throw new Error(
      `pty:linux: ${binary} is missing or empty; run \`npm run pty:linux -- --arch ${arch}\``,
    );
  }
  const info = readBuildInfo(infoPath);
  if (!info) {
    throw new Error(
      `pty:linux: ${infoPath} is missing; an artifact without provenance is not shippable`,
    );
  }
  assertNativeFloor(
    {
      glibc: [info.floor?.glibc ?? "0"],
      glibcxx: [info.floor?.glibcxx ?? "0"],
      cxxabi: [],
    },
    NATIVE_FLOOR,
  );
  return { binary, info };
}

function buildFor(arch, options) {
  const moduleDir = join(REPO, "node_modules", "node-pty");
  const outputDir = join(moduleDir, "prebuilds", `linux-${arch}`);
  const binary = join(outputDir, "pty.node");
  const infoPath = join(outputDir, "BUILD-INFO.json");
  const nodePtyVersion = resolveNodePtyVersion(REPO);
  const node = resolveBundledNode(REPO, arch);
  const expected = ptyBuildInfo({
    nodePtyVersion,
    nodeVersion: node.version,
    image: options.image,
  });

  if (!options.force && isPtyPrebuildFresh(readBuildInfo(infoPath), expected)) {
    process.stdout.write(`pty:linux: ${arch} is current (${binary}); use --force to rebuild\n`);
    return;
  }

  const container = linuxPtyContainer({
    arch,
    repoDir: REPO,
    image: options.image,
    moduleDir: "/work/node_modules/node-pty",
    nodePath: `/work/resources/runtime/node/linux-${arch}/bin/node`,
    nodeGyp: "/work/node_modules/node-gyp/bin/node-gyp.js",
    nodeVersion: node.version,
    outputDir: `/work/node_modules/node-pty/prebuilds/linux-${arch}`,
  });

  if (options.printPlan) {
    process.stdout.write(`pty:linux: docker ${container.args.map(shellQuote).join(" ")}\n`);
    return;
  }
  if (process.platform !== "linux") {
    throw new Error(
      "pty:linux: run this on Linux (or pass --print-plan); Docker on macOS/Windows cannot " +
        "mount the Linux runtime reliably",
    );
  }

  mkdirSync(outputDir, { recursive: true });
  rmSync(binary, { force: true });
  rmSync(join(outputDir, "readelf.txt"), { force: true });

  process.stdout.write(`pty:linux: building ${arch} in ${options.image} …\n`);
  execFileSync("docker", container.args, { cwd: REPO, stdio: ["ignore", "inherit", "inherit"] });

  if (!isUsableBinary(binary)) {
    throw new Error(`pty:linux: the container did not produce a usable ${binary}`);
  }

  const readelfPath = join(outputDir, "readelf.txt");
  const measured = assertNativeFloor(parseReadelfVersionNeeds(readFileSync(readelfPath, "utf8")));
  rmSync(readelfPath, { force: true });

  // The container writes as root; hand the two files back to the caller.
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid !== undefined && gid !== undefined) {
    try {
      chownSync(binary, uid, gid);
    } catch {
      // A rootless/userns docker may already have mapped it; not fatal.
    }
  }

  // node-pty checks build/ first, so an unpinned runner build must not survive.
  rmSync(join(moduleDir, "build"), { recursive: true, force: true });

  const info = ptyBuildInfo({
    nodePtyVersion,
    nodeVersion: node.version,
    image: options.image,
    imageDigest: imageDigest(options.image),
    floor: {
      glibc: measured.glibc ?? NATIVE_FLOOR.glibc,
      glibcxx: measured.glibcxx ?? NATIVE_FLOOR.glibcxx,
    },
  });
  writeFileSync(infoPath, `${JSON.stringify(info, null, 2)}\n`, "utf8");
  if (uid !== undefined && gid !== undefined) {
    try {
      chownSync(infoPath, uid, gid);
    } catch {
      // Same as above.
    }
  }

  process.stdout.write(`${describe(arch, binary, info)}\n`);
}

function shellQuote(value) {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function main(argv) {
  const options = parseBuildArgs(argv);

  if (options.checkOnly) {
    for (const arch of options.arches) {
      const checked = checkPrebuild(REPO, arch);
      process.stdout.write(`${describe(arch, checked.binary, checked.info)}\n`);
    }
    return;
  }

  if (options.printPlan) {
    for (const arch of options.arches) buildFor(arch, options);
    return;
  }

  for (const arch of options.arches) buildFor(arch, options);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
