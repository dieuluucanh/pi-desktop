#!/usr/bin/env node
/**
 * Pi agent status and bump tool (2026-11-15 update-channels plan, step 10).
 *
 * Why a script instead of Dependabot: the app must pin the SDK *family* and
 * `typebox` to exactly what the SDK itself declares, update the versions
 * document, and report a major bump instead of taking it. Those are four
 * invariants a generic dependency bot cannot check.
 *
 * Dependency-free on purpose (`node:*` + the `npm` binary only): the release
 * workflow's `prepare` job runs `--status` before `npm ci`.
 *
 * Usage:
 *   node scripts/pi-agent.mjs [--status|--check|--update] [flags]
 *
 * Flags:
 *   --json             machine-readable report
 *   --dry-run          print what --update would write, write nothing
 *   --force            allow --update on a dirty git tree
 *   --major            allow a major bump (otherwise it is reported and refused)
 *   --no-install       skip `npm install --package-lock-only` after a bump
 *   --root <dir>       project root (default: this repository)
 *   --registry <file>  read a registry fixture instead of asking npm (hermetic)
 *
 * Exit codes for --check: 0 in sync / local-ahead / major-behind,
 * 1 behind, 2 registry error.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PI_AGENT_PACKAGE,
  PiAgentError,
  classifyPiStatus,
  isExactVersion,
  readPiPins,
  renderVersionsDoc,
  resolveTargetPins,
  rewritePiPins,
  satisfiesFloor,
} from "./pi-agent-package.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, "..");
const VERSIONS_DOC = join("docs", "architecture", "versions.md");
const NODE_LOCK = join("resources", "runtime", "node.lock.json");

const HELP = `Pi agent status and bump tool

  node scripts/pi-agent.mjs [--status|--check|--update] [flags]

  --status           report the pinned vs latest agent (default)
  --check            exit 1 when behind, 2 when the registry cannot be read
  --update           bump the family + typebox and the versions document
  --json             machine-readable report
  --dry-run          with --update: show the change, write nothing
  --force            with --update: allow a dirty git tree
  --major            with --update/--check: treat a major bump as actionable
  --no-install       with --update: skip the lockfile refresh
  --root <dir>       project root (default: this repository)
  --registry <file>  read a registry fixture instead of asking npm
`;

/** Reads an argument's value, refusing a missing one. */
function requireValue(argv, index, flag) {
  const value = argv[index];
  if (typeof value !== "string" || value.startsWith("--")) {
    throw new PiAgentError(`${flag} needs a value`);
  }
  return value;
}

/** Parses the flags; an unknown one is an error, not a guess. */
export function parseArgs(argv) {
  const options = {
    command: "status",
    json: false,
    dryRun: false,
    force: false,
    major: false,
    install: true,
    root: DEFAULT_ROOT,
    registryFile: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--status":
        options.command = "status";
        break;
      case "--check":
        options.command = "check";
        break;
      case "--update":
        options.command = "update";
        break;
      case "--json":
        options.json = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--major":
        options.major = true;
        break;
      case "--no-install":
        options.install = false;
        break;
      case "--root":
        index += 1;
        options.root = resolve(requireValue(argv, index, "--root"));
        break;
      case "--registry":
        index += 1;
        options.registryFile = resolve(requireValue(argv, index, "--registry"));
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new PiAgentError(`unknown argument: ${String(arg)}`);
    }
  }
  return options;
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** Runs a command and returns stdout, retrying transient npm/registry failures. */
function runWithRetries(run, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return run();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) sleepSync(attempt * 2_000);
    }
  }
  throw lastError;
}

export function npmInvocation(platform = process.platform, env = process.env) {
  if (platform === "win32") {
    return { cmd: env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "npm"] };
  }
  return { cmd: "npm", args: [] };
}

function npmView(args, root) {
  const npm = npmInvocation();
  return runWithRetries(() =>
    execFileSync(npm.cmd, [...npm.args, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

/**
 * The registry facts the check needs. A fixture file keeps tests and offline
 * runs hermetic; otherwise `npm view` is the only network access.
 */
export function readRegistry({ root, registryFile }) {
  if (registryFile) {
    const parsed = JSON.parse(readFileSync(registryFile, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.latest !== "string") {
      throw new PiAgentError(`${registryFile} is not a registry fixture with a "latest"`);
    }
    return {
      latest: parsed.latest,
      dependencies:
        parsed.dependencies && typeof parsed.dependencies === "object" ? parsed.dependencies : {},
      engines:
        parsed.engines && typeof parsed.engines === "object" ? (parsed.engines.node ?? null) : null,
    };
  }
  const latestRaw = npmView(["view", PI_AGENT_PACKAGE, "dist-tags.latest", "--json"], root).trim();
  const latest = JSON.parse(latestRaw);
  if (typeof latest !== "string" || !isExactVersion(latest)) {
    throw new PiAgentError(`npm view returned an unusable latest: ${String(latest)}`);
  }
  const metaRaw = npmView(
    ["view", `${PI_AGENT_PACKAGE}@${latest}`, "dependencies", "engines", "--json"],
    root,
  ).trim();
  const meta = JSON.parse(metaRaw);
  return {
    latest,
    dependencies:
      meta && typeof meta === "object" && meta.dependencies && typeof meta.dependencies === "object"
        ? meta.dependencies
        : {},
    engines:
      meta && typeof meta === "object" && meta.engines && typeof meta.engines === "object"
        ? (meta.engines.node ?? null)
        : null,
  };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new PiAgentError(
      `cannot read ${path}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

/** The bundled Node version, or null when the runtime was never fetched. */
export function bundledNodeVersion(root) {
  const path = join(root, NODE_LOCK);
  if (!existsSync(path)) return null;
  try {
    const lock = JSON.parse(readFileSync(path, "utf8"));
    const version = lock?.node?.version;
    return typeof version === "string" && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

/** Builds the report both the text and `--json` output use. */
export function buildReport({ root, registry }) {
  const manifest = readJson(join(root, "package.json"));
  const pins = readPiPins(manifest);
  const current = pins.family[PI_AGENT_PACKAGE];
  const { latest } = registry;
  const status = classifyPiStatus(current, latest);
  const node = bundledNodeVersion(root);
  const enginesOk = satisfiesFloor(node, registry.engines);

  let targets = null;
  let targetError = null;
  try {
    targets = resolveTargetPins({ sdkVersion: latest, sdkDependencies: registry.dependencies });
  } catch (error) {
    targetError = error instanceof Error ? error.message : String(error);
  }

  return {
    current,
    latest,
    status,
    pins: pins.family,
    typebox: { current: pins.typebox, latest: targets?.typebox ?? null },
    targets,
    targetError,
    bundledNode: node,
    engines: registry.engines,
    enginesOk,
  };
}

function printReport(report, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const lines = [
    `Pi agent  ${report.current ?? "unknown"}  ->  ${report.latest}  ${report.status}`,
  ];
  if (report.typebox.current || report.typebox.latest) {
    lines.push(
      `typebox   ${report.typebox.current ?? "unknown"}${
        report.typebox.latest ? `  ->  ${report.typebox.latest}` : ""
      }`,
    );
  }
  lines.push(
    `bundled   Node ${report.bundledNode ?? "unknown"}${
      report.engines ? `  (SDK needs ${report.engines})` : ""
    }`,
  );
  if (report.targetError) lines.push(`target    ${report.targetError}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

/** `--check`'s contract: 0 fine, 1 behind, 2 registry error. */
export function checkExitCode(report, options) {
  if (report.status === "registry-error") return 2;
  if (report.status === "behind") return 1;
  if (report.status === "major-behind") return options.major ? 1 : 0;
  return 0;
}

function gitStatus(root) {
  try {
    return execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // Not a git checkout (or git is unavailable): there is nothing to protect.
    return null;
  }
}

function assertCleanTree(root, force) {
  if (force) return;
  const status = gitStatus(root);
  if (status !== null && status.trim().length > 0) {
    throw new PiAgentError(
      "the working tree has uncommitted changes; commit them or pass --force to bump anyway",
    );
  }
}

function describeChange(changed) {
  return changed
    .map((entry) => `  ${entry.name}  ${entry.from ?? "(missing)"} -> ${entry.to}`)
    .join("\n");
}

function runUpdate(options) {
  assertCleanTree(options.root, options.force);

  let registry;
  try {
    registry = readRegistry({ root: options.root, registryFile: options.registryFile });
  } catch (error) {
    throw new PiAgentError(
      `cannot read the registry: ${error instanceof Error ? error.message : error}`,
    );
  }

  const manifestPath = join(options.root, "package.json");
  const manifest = readJson(manifestPath);
  const pins = readPiPins(manifest);
  const current = pins.family[PI_AGENT_PACKAGE];
  const status = classifyPiStatus(current, registry.latest);

  if (status === "in-sync") {
    process.stdout.write(`Pi agent ${current} is already the latest published version.\n`);
    return 0;
  }
  if (status === "local-ahead") {
    process.stdout.write(
      `The pinned Pi agent ${current} is newer than npm latest ${registry.latest}; not downgrading.\n`,
    );
    return 0;
  }
  if (status === "major-behind" && !options.major) {
    throw new PiAgentError(
      `Pi agent ${registry.latest} is a major bump from ${current}; review it and re-run with --major`,
    );
  }

  const targets = resolveTargetPins({
    sdkVersion: registry.latest,
    sdkDependencies: registry.dependencies,
  });

  const node = bundledNodeVersion(options.root);
  const enginesOk = satisfiesFloor(node, registry.engines);
  if (enginesOk === false) {
    throw new PiAgentError(
      `the target SDK needs Node ${registry.engines}, but the bundled runtime is ${
        node ?? "unknown"
      }`,
    );
  }
  if (enginesOk === null) {
    process.stderr.write(
      `warning: cannot compare the bundled Node (${node ?? "unknown"}) with ${
        registry.engines ?? "an unstated engine range"
      }\n`,
    );
  }

  const { manifest: nextManifest, changed } = rewritePiPins(manifest, targets);
  const docPath = join(options.root, VERSIONS_DOC);
  const doc = readFileSync(docPath, "utf8");
  const nextDoc = renderVersionsDoc(doc, targets);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          from: current,
          to: registry.latest,
          status,
          changed,
          typebox: { from: pins.typebox, to: targets.typebox },
          wrote: !options.dryRun,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(
      `Pi agent ${current} -> ${registry.latest} (${status})\n${describeChange(changed)}\n`,
    );
  }

  if (options.dryRun) {
    if (!options.json) process.stdout.write("dry run: nothing was written\n");
    return 0;
  }

  writeFileSync(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");
  writeFileSync(docPath, nextDoc, "utf8");

  if (options.install) {
    const npm = npmInvocation();
    execFileSync(npm.cmd, [...npm.args, "install", "--package-lock-only", "--ignore-scripts"], {
      cwd: options.root,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });
  }

  if (!options.json) {
    process.stdout.write(
      [
        "",
        "Next:",
        "  npm ci",
        "  npm run typecheck && npm run lint && npm test && npm run build:host",
        "  git add package.json package-lock.json docs/architecture/versions.md",
        `  git commit -m "chore(deps): bump Pi agent to ${registry.latest}"`,
        "",
      ].join("\n"),
    );
  }
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`pi-agent: ${error instanceof Error ? error.message : error}\n`);
    return 1;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.command === "update") {
    try {
      return runUpdate(options);
    } catch (error) {
      process.stderr.write(`pi-agent: ${error instanceof Error ? error.message : error}\n`);
      return 1;
    }
  }

  let report;
  try {
    const registry = readRegistry({
      root: options.root,
      registryFile: options.registryFile,
    });
    report = buildReport({ root: options.root, registry });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ status: "registry-error", error: message })}\n`);
    }
    process.stderr.write(`pi-agent: ${message}\n`);
    return options.command === "check" ? 2 : 2;
  }

  printReport(report, options.json);
  return options.command === "check" ? checkExitCode(report, options) : 0;
}

// Only run when invoked directly; the tests import the pure parts.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
