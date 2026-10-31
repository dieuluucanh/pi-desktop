#!/usr/bin/env node
/**
 * Local release tool for `@dieulc/checkpoints` (2026-10-31 re-home plan).
 *
 *   npm run release:extension:status
 *   npm run release:extension -- --bump patch --branch dev --yes
 *   npm run release:extension -- --continue --branch dev --yes
 *
 * One package, one version line, one tag format. The tool reads
 * `packages/checkpoints/package.json`, builds and verifies the tarball, updates
 * the changelog, publishes, tags and pushes. It never touches the app version.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  BUMP_KINDS,
  CHANGELOG_FILE,
  DEFAULT_BRANCH,
  DEFAULT_NPM_USER,
  MIN_NODE_VERSION,
  PACKAGE_DIR,
  PACKAGE_NAME,
  PACKAGE_PATHS,
  REPO_ROOT,
  TAG_PREFIX,
  bumpVersion,
  changelogSection,
  classifyRegistryState,
  classifyStatus,
  documentsVersion,
  finalizeUnreleased,
  onlyReleaseFilesChanged,
  parseReleaseArgs,
  prependChangelog,
  readChangelog,
  readManifest,
  tagFor,
  validateManifest,
  writeVersionText,
} from "./extension-package.mjs";

const NPM =
  process.platform === "win32"
    ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "npm"] }
    : { command: "npm", args: [] };

class ReleaseError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function run(command, args, { cwd = PACKAGE_DIR, stdio = "pipe" } = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio,
    timeout: 15 * 60_000,
  });
}

function git(args, options = {}) {
  return run("git", args, { cwd: REPO_ROOT, ...options });
}

function npm(args, options = {}) {
  return run(NPM.command, [...NPM.args, ...args], options);
}

function out(result) {
  return String(result.stdout ?? "").trim();
}

function tail(result, lines = 10) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    .trim()
    .split(/\r?\n/)
    .slice(-lines)
    .join("\n");
}

function must(result, what) {
  if (result.status !== 0) throw new ReleaseError(`${what} failed:\n${tail(result)}`);
  return result;
}

function compareVersions(left, right) {
  const a = String(left).split(".").map(Number);
  const b = String(right).split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function requireNodeVersion() {
  if (compareVersions(process.versions.node, MIN_NODE_VERSION) < 0) {
    throw new ReleaseError(
      `Node >= ${MIN_NODE_VERSION} required (running ${process.versions.node})`,
    );
  }
}

function preflight(opts) {
  requireNodeVersion();
  const branch = out(must(git(["rev-parse", "--abbrev-ref", "HEAD"]), "git rev-parse"));
  if (branch !== opts.branch) {
    throw new ReleaseError(`must release from "${opts.branch}" (currently on "${branch}")`);
  }
  const status = out(must(git(["status", "--porcelain"]), "git status"));
  if (status.length > 0) {
    if (!opts.continueMode || !onlyReleaseFilesChanged(status)) {
      throw new ReleaseError("working tree is not clean — commit or stash first");
    }
    console.log("Resuming with uncommitted package release files");
  }
  must(git(["fetch", "origin", opts.branch]), `git fetch origin ${opts.branch}`);
  const behind = Number(
    out(must(git(["rev-list", "--count", `HEAD..origin/${opts.branch}`]), "git rev-list")),
  );
  if (behind > 0) {
    throw new ReleaseError(
      `branch is ${behind} commit(s) behind origin/${opts.branch} — pull first`,
    );
  }
  if (!opts.dryRun) {
    const who = npm(["whoami"]);
    const user = out(who);
    if (who.status !== 0 || user !== opts.npmUser) {
      throw new ReleaseError(
        `npm auth check failed: expected "${opts.npmUser}", got "${user || "not logged in"}"`,
      );
    }
    console.log(`Preflight ok — branch ${branch}, npm user ${user}\n`);
  } else {
    console.log(`Preflight ok — branch ${branch} (dry run, npm auth not checked)\n`);
  }
}

function registryState(version) {
  const result = npm(["view", `${PACKAGE_NAME}@${version}`, "version", "--json"]);
  if (result.status === 0) return "published";
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/E404|404 Not Found|No match found/i.test(text)) return "absent";
  return "unknown";
}

function latestVersion() {
  const result = npm(["view", PACKAGE_NAME, "version", "--json"]);
  if (result.status === 0) {
    try {
      return { ok: true, version: JSON.parse(out(result)) };
    } catch {
      return { ok: false, version: null };
    }
  }
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/E404|404 Not Found|No match found/i.test(text)) return { ok: true, version: null };
  return { ok: false, version: null };
}

function printStatus(opts) {
  const manifest = readManifest();
  const errors = validateManifest(manifest);
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`  - ${error}\n`);
    return 2;
  }
  const latest = latestVersion();
  const verdict = latest.ok ? classifyStatus(manifest.version, latest.version) : "registry-error";
  process.stdout.write(
    `@dieulc/checkpoints  local ${manifest.version}  latest ${latest.version ?? "—"}  ${verdict}\n`,
  );
  if (opts.check && verdict !== "in-sync") return verdict === "registry-error" ? 2 : 1;
  return 0;
}

function runGate() {
  for (const script of ["format:check", "typecheck", "lint", "test", "build"]) {
    console.log(`\nGate: npm run ${script}`);
    must(npm(["run", script], { cwd: REPO_ROOT, stdio: "inherit" }), `npm run ${script}`);
  }
}

function buildAndVerify() {
  console.log("\nBuilding the package artifact");
  must(
    npm(["run", "build:extension"], { cwd: REPO_ROOT, stdio: "inherit" }),
    "npm run build:extension",
  );
  must(
    npm(["run", "verify:extension"], { cwd: REPO_ROOT, stdio: "inherit" }),
    "npm run verify:extension",
  );
}

function lastTag() {
  const result = git(["describe", "--tags", "--abbrev=0", "--match", `${TAG_PREFIX}*`]);
  return result.status === 0 ? out(result) : null;
}

function commitsSinceLastTag() {
  const tag = lastTag();
  const range = tag ? `${tag}..HEAD` : "HEAD";
  const result = git(["log", "--no-merges", "--format=%s", range, "--", ...PACKAGE_PATHS]);
  if (result.status !== 0) throw new ReleaseError(`git log failed:\n${tail(result)}`);
  return out(result)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function prepareChangelog(nextVersion, opts) {
  const now = new Date().toISOString().slice(0, 10);
  const changelogPath = join(PACKAGE_DIR, CHANGELOG_FILE);
  let changelog = readChangelog();
  if (opts.continueMode) return;

  if (documentsVersion(changelog, nextVersion)) {
    console.log(`Changelog already documents ${nextVersion}`);
  } else {
    const finalized = finalizeUnreleased(changelog, nextVersion, now);
    if (finalized) {
      changelog = finalized;
      console.log(`Finalized [Unreleased] as ${nextVersion}`);
    } else {
      const section = changelogSection(nextVersion, commitsSinceLastTag(), now);
      changelog = prependChangelog(changelog, section);
      console.log(`Generated the ${nextVersion} changelog section`);
    }
    writeFileSync(changelogPath, changelog, "utf8");
  }

  const manifestPath = join(PACKAGE_DIR, "package.json");
  const source = readFileSync(manifestPath, "utf8");
  writeFileSync(manifestPath, writeVersionText(source, nextVersion), "utf8");
  console.log(`Wrote ${PACKAGE_NAME}@${nextVersion} to packages/checkpoints/package.json`);
}

function formatReleaseFiles() {
  must(
    npm(
      [
        "exec",
        "--",
        "prettier",
        "--write",
        "packages/checkpoints/package.json",
        "packages/checkpoints/CHANGELOG.md",
      ],
      { cwd: REPO_ROOT, stdio: "inherit" },
    ),
    "prettier --write",
  );
}

function commitRelease(version) {
  must(
    git(["add", "packages/checkpoints/package.json", "packages/checkpoints/CHANGELOG.md"]),
    "git add",
  );
  const staged = out(must(git(["diff", "--cached", "--name-only"]), "git diff --cached"));
  if (!staged) {
    console.log("Nothing to commit — the release is already recorded.");
    return;
  }
  must(git(["commit", "-m", `chore(release): ${PACKAGE_NAME}@${version}`]), "git commit");
  console.log(`Committed: chore(release): ${PACKAGE_NAME}@${version}`);
}

function publishPackage(opts) {
  console.log(`\nPublishing ${PACKAGE_NAME} …`);
  const result = npm(["publish"], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new ReleaseError(
      "npm publish failed. Fix the credential/network problem and resume with:\n" +
        `  npm run release:extension -- --continue --branch ${opts.branch} --yes`,
    );
  }
}

function tagAndPush(version, opts) {
  const tag = tagFor(version);
  if (git(["rev-parse", "--verify", `refs/tags/${tag}`]).status === 0) {
    console.log(`Tag already exists: ${tag}`);
  } else {
    must(git(["tag", "-a", tag, "-m", tag]), `git tag ${tag}`);
    console.log(`Tagged ${tag}`);
  }

  if (opts.noPush) {
    console.log(
      `\n--no-push set. Push with:\n  git push origin ${opts.branch} && git push origin ${tag}`,
    );
    return;
  }
  must(git(["push", "origin", opts.branch]), `git push origin ${opts.branch}`);
  must(git(["push", "origin", tag]), `git push origin ${tag}`);
  console.log(`\nPushed ${opts.branch} and ${tag}`);
}

function printHelp() {
  process.stdout.write(`Usage: npm run release:extension -- [flags]

Package: @dieulc/checkpoints (packages/checkpoints)

Flags:
  --status              read-only: local version vs the npm registry
  --check               with --status: exit 1 on drift or an unknown registry state
  --dry-run             preflight and print the release plan; writes nothing
  --bump <kind>         none | patch | minor | major (required unless --continue)
  --branch <name>       release branch (default: ${DEFAULT_BRANCH})
  --npm-user <name>     required npm user (default: ${DEFAULT_NPM_USER})
  --yes, -y             non-interactive; required for a real release
  --no-push             stop after tagging
  --continue            publish the current manifest version and repair its tag
  --help, -h            this help

Examples:
  npm run release:extension:status -- --check
  npm run release:extension -- --bump patch --branch dev --dry-run
  npm run release:extension -- --bump patch --branch dev --yes
  npm run release:extension -- --continue --branch dev --yes
`);
}

function main() {
  const opts = parseReleaseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return 0;
  }
  if (opts.status) return printStatus(opts);

  const manifest = readManifest();
  const errors = validateManifest(manifest);
  if (errors.length > 0) {
    throw new ReleaseError(
      `packages/checkpoints/package.json is invalid:\n  - ${errors.join("\n  - ")}`,
    );
  }

  preflight(opts);

  const kind = opts.continueMode ? "none" : opts.bump;
  if (!kind) throw new ReleaseError("--bump is required (or use --continue)");
  if (!BUMP_KINDS.includes(kind))
    throw new ReleaseError(`--bump must be one of ${BUMP_KINDS.join(", ")}`);
  const nextVersion = bumpVersion(manifest.version, kind);
  const state = registryState(nextVersion);
  const decision = classifyRegistryState({ kind, nextVersion, state });
  console.log(
    `Target: ${PACKAGE_NAME}@${nextVersion}  registry: ${state}  decision: ${decision.status} (${decision.reason})`,
  );

  if (opts.dryRun) {
    const tag = tagFor(nextVersion);
    console.log(
      `\nWould ${decision.status === "publish" ? "publish" : "skip publishing"} ${PACKAGE_NAME}@${nextVersion}`,
    );
    console.log(`Tag: ${tag}`);
    console.log(
      `Push: ${opts.noPush ? "skipped (--no-push)" : `git push origin ${opts.branch} && git push origin ${tag}`}`,
    );
    return 0;
  }

  if (!opts.yes) throw new ReleaseError("refusing a real release without --yes");
  if (decision.status === "blocked") throw new ReleaseError(decision.reason);
  if (decision.status === "skip" && !opts.continueMode) {
    throw new ReleaseError(
      `${decision.reason}\n${decision.tagEligible ? `(use --continue to repair tag ${tagFor(nextVersion)})` : ""}`,
    );
  }

  if (!opts.continueMode) runGate();
  buildAndVerify();
  if (!opts.continueMode) {
    prepareChangelog(nextVersion, opts);
    formatReleaseFiles();
    must(
      npm(["run", "verify:extension"], { cwd: REPO_ROOT, stdio: "inherit" }),
      "npm run verify:extension",
    );
    commitRelease(nextVersion);
  } else if (out(git(["status", "--porcelain"])).length > 0) {
    // A previous run failed after writing the version/changelog but before the
    // commit (for example a bad local tool invocation). Resume by committing
    // exactly those two files, then publishing the same version.
    formatReleaseFiles();
    must(
      npm(["run", "verify:extension"], { cwd: REPO_ROOT, stdio: "inherit" }),
      "npm run verify:extension",
    );
    commitRelease(nextVersion);
  }

  if (state === "published") {
    console.log(`Already on npm, skipping publish: ${PACKAGE_NAME}@${nextVersion}`);
  } else if (state === "absent") {
    publishPackage(opts);
  } else {
    throw new ReleaseError("registry state is unknown — refusing to publish");
  }

  tagAndPush(nextVersion, opts);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  const releaseError = error instanceof ReleaseError ? error : null;
  process.stderr.write(
    `release-extension: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = releaseError?.exitCode ?? 1;
}
