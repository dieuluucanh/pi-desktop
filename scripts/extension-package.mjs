#!/usr/bin/env node
/**
 * Shared facts and pure helpers for the publishable checkpoint package.
 *
 * `packages/checkpoints` is the source of truth for release metadata. The build
 * script, the verification gate and the release tool all read the same manifest
 * and apply the same rules, so a package can never be built, packed or
 * published against a second, guessed identity.
 *
 * Nothing here spawns a process or touches the network.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const PACKAGE_DIR = join(REPO_ROOT, "packages", "checkpoints");
export const PACKAGE_NAME = "@dieulc/checkpoints";
export const ENTRY_FILE = "index.mjs";
export const README_FILE = "README.md";
export const LICENSE_FILE = "LICENSE";
export const CHANGELOG_FILE = "CHANGELOG.md";
export const REQUIRED_FILES = [ENTRY_FILE, README_FILE, LICENSE_FILE, CHANGELOG_FILE];
export const REPOSITORY_URL = "git+https://github.com/dieuluucanh/pi-desktop.git";
export const REPOSITORY_DIRECTORY = "packages/checkpoints";
export const HOMEPAGE = "https://github.com/dieuluucanh/pi-desktop#readme";
export const BUGS_URL = "https://github.com/dieuluucanh/pi-desktop/issues";
export const PUBLISH_ACCESS = "public";
export const MIN_NODE_VERSION = "22.19.0";
export const TAG_PREFIX = `${PACKAGE_NAME}@`;
export const DEFAULT_BRANCH = "main";
export const DEFAULT_NPM_USER = "dieulc";
export const BUMP_KINDS = ["none", "patch", "minor", "major"];

export const CHANGELOG_HEADER =
  "# Changelog\n\nAll notable changes to this package are documented in this file.\n";

/**
 * Paths whose commits belong in the package changelog. The extension bundles
 * the checkpoint store and git runner, so their changes affect the package even
 * though they live outside `packages/checkpoints`.
 */
export const RELEASE_FILE_PATHS = [
  "packages/checkpoints/package.json",
  "packages/checkpoints/CHANGELOG.md",
];

export const PACKAGE_PATHS = [
  "packages/checkpoints",
  "src/extensions/pi-checkpoints.ts",
  "src/checkpoints",
  "src/git/runner.ts",
  "src/shared/checkpoints.ts",
  "src/shared/checkpoint-extension.ts",
  "scripts/build-extension.mjs",
  "scripts/verify-extension.mjs",
  "scripts/release-extension.mjs",
  "scripts/extension-package.mjs",
  "tests/checkpoints",
  "tests/packaging/extension-artifact.test.ts",
  "tests/packaging/extension-package.test.ts",
  "tests/packaging/extension-release.test.ts",
];

export function parseReleaseArgs(argv = []) {
  const opts = {
    status: false,
    check: false,
    dryRun: false,
    bump: null,
    yes: false,
    noPush: false,
    continueMode: false,
    branch: DEFAULT_BRANCH,
    npmUser: DEFAULT_NPM_USER,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--status") opts.status = true;
    else if (arg === "--check") opts.check = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--yes" || arg === "-y") opts.yes = true;
    else if (arg === "--no-push") opts.noPush = true;
    else if (arg === "--continue") opts.continueMode = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--bump") {
      const kind = String(argv[++index] ?? "");
      if (!BUMP_KINDS.includes(kind))
        throw new Error(`--bump must be one of ${BUMP_KINDS.join(", ")}`);
      opts.bump = kind;
    } else if (arg === "--branch") {
      const branch = String(argv[++index] ?? "").trim();
      if (!branch) throw new Error("--branch needs a value");
      opts.branch = branch;
    } else if (arg === "--npm-user") {
      const user = String(argv[++index] ?? "").trim();
      if (!user) throw new Error("--npm-user needs a value");
      opts.npmUser = user;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `cannot read JSON from ${file}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function readManifest(dir = PACKAGE_DIR) {
  return readJson(join(dir, "package.json"));
}

export function readChangelog(dir = PACKAGE_DIR) {
  return readFileSync(join(dir, CHANGELOG_FILE), "utf8");
}

function semverParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(String(version ?? ""));
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isSemver(version) {
  return semverParts(version) !== null;
}

export function bumpVersion(version, kind) {
  const parts = semverParts(version);
  if (!parts) throw new Error(`not a semver version: ${version}`);
  const [major, minor, patch] = parts;
  switch (kind) {
    case "none":
      return version;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "major":
      return `${major + 1}.0.0`;
    default:
      throw new Error(`unknown bump kind: ${kind}`);
  }
}

export function tagFor(version) {
  return `${TAG_PREFIX}${version}`;
}

/** The manifest fields the build, npm and Pi's loader rely on. */
export function validateManifest(manifest) {
  const errors = [];
  const need = (condition, message) => {
    if (!condition) errors.push(message);
  };

  need(manifest?.name === PACKAGE_NAME, `name must be ${PACKAGE_NAME}`);
  need(isSemver(manifest?.version), `version must be semver (got ${manifest?.version})`);
  need(manifest?.private !== true, "package must not be private");
  need(manifest?.type === "module", 'type must be "module"');
  need(manifest?.license === "MIT", `license must be MIT (got ${manifest?.license})`);
  need(
    Array.isArray(manifest?.keywords) && manifest.keywords.includes("pi-package"),
    'keywords must include "pi-package"',
  );
  need(
    manifest?.repository?.url === REPOSITORY_URL,
    `repository.url must be "${REPOSITORY_URL}" (got ${manifest?.repository?.url})`,
  );
  need(
    manifest?.repository?.directory === REPOSITORY_DIRECTORY,
    `repository.directory must be "${REPOSITORY_DIRECTORY}" (got ${manifest?.repository?.directory})`,
  );
  need(manifest?.bugs?.url === BUGS_URL, `bugs.url must be "${BUGS_URL}"`);
  need(manifest?.homepage === HOMEPAGE, `homepage must be "${HOMEPAGE}"`);
  need(
    manifest?.publishConfig?.access === PUBLISH_ACCESS,
    `publishConfig.access must be "${PUBLISH_ACCESS}"`,
  );
  need(
    Array.isArray(manifest?.pi?.extensions) &&
      manifest.pi.extensions.length === 1 &&
      manifest.pi.extensions[0] === `./${ENTRY_FILE}`,
    `pi.extensions must be ["./${ENTRY_FILE}"]`,
  );
  need(
    Array.isArray(manifest?.files) && REQUIRED_FILES.every((file) => manifest.files.includes(file)),
    `files[] must include ${REQUIRED_FILES.join(", ")}`,
  );
  need(
    typeof manifest?.engines?.node === "string" && manifest.engines.node.includes("22.19.0"),
    'engines.node must require ">=22.19.0"',
  );
  return errors;
}

/** Tarball contents, from `npm pack --dry-run --json`. */
export function validateTarballFiles(files) {
  const errors = [];
  const normalized = files.map((file) => String(file).replace(/\\/g, "/"));
  const has = (name) => normalized.includes(name);

  for (const file of REQUIRED_FILES) {
    if (!has(file)) errors.push(`tarball is missing ${file}`);
  }
  for (const file of normalized) {
    if (file.includes("node_modules/"))
      errors.push(`tarball must not contain node_modules: ${file}`);
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file))
      errors.push(`tarball must not contain test files: ${file}`);
    if (file === "package-lock.json") errors.push("tarball must not contain package-lock.json");
  }
  return errors;
}

/**
 * Release decision for one target version, from the registry state.
 * `unknown` is never treated as "not published".
 */
export function classifyRegistryState({ kind, nextVersion, state }) {
  if (state === "unknown") {
    return { status: "blocked", reason: "registry query failed", tagEligible: false };
  }
  if (state === "published") {
    return kind === "none"
      ? {
          status: "skip",
          reason: `already on npm at ${nextVersion} — no bump requested`,
          tagEligible: true,
        }
      : {
          status: "skip",
          reason: `${nextVersion} is already on npm — bump further`,
          tagEligible: false,
        };
  }
  return { status: "publish", reason: "not on npm", tagEligible: true };
}

export function classifyStatus(localVersion, latestVersion) {
  if (!latestVersion) return "never-published";
  const local = semverParts(localVersion);
  const latest = semverParts(latestVersion);
  if (!local) return "invalid-version";
  if (!latest) return "registry-error";
  const compare = local[0] - latest[0] || local[1] - latest[1] || local[2] - latest[2];
  if (compare === 0) return "in-sync";
  return compare > 0 ? "local-ahead" : "local-behind";
}

/** Conventional commit subject → `{ type, scope, breaking, description }`. */
export function parseConventionalSubject(subject) {
  const match = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.*)$/.exec(String(subject ?? "").trim());
  if (!match)
    return { type: "other", scope: "", breaking: false, description: String(subject ?? "") };
  return {
    type: match[1],
    scope: match[2] ?? "",
    breaking: match[3] === "!",
    description: match[4] ?? "",
  };
}

const CHANGELOG_GROUPS = [
  ["feat", "Features"],
  ["fix", "Fixes"],
  ["perf", "Performance"],
  ["refactor", "Refactoring"],
  ["revert", "Reverts"],
  ["docs", "Documentation"],
  ["test", "Tests"],
  ["build", "Build"],
  ["ci", "CI"],
  ["style", "Style"],
  ["chore", "Chores"],
  ["other", "Other changes"],
];

export function changelogSection(version, subjects, date) {
  const groups = new Map();
  for (const subject of subjects) {
    const parsed = parseConventionalSubject(subject);
    const label = CHANGELOG_GROUPS.find(([type]) => type === parsed.type)?.[1] ?? "Other changes";
    const lines = groups.get(label) ?? [];
    const scope = parsed.scope ? `**${parsed.scope}:** ` : "";
    const breaking = parsed.breaking ? "**Breaking:** " : "";
    lines.push(`- ${breaking}${scope}${parsed.description}`);
    groups.set(label, lines);
  }

  const sections = CHANGELOG_GROUPS.map(([, label]) => {
    const lines = groups.get(label);
    if (!lines || lines.length === 0) return "";
    return `### ${label}\n\n${lines.join("\n")}`;
  }).filter(Boolean);

  return `## [${version}] - ${date}\n\n${sections.length > 0 ? sections.join("\n\n") : "_No changes recorded._"}\n`;
}

export function documentsVersion(changelog, version) {
  const escaped = String(version).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^## \\[${escaped}\\]`, "m").test(changelog);
}

/** Replace `## [Unreleased]` with the release section, preserving its content. */
export function finalizeUnreleased(changelog, version, date) {
  const match = /^## \[Unreleased\][^\n]*\n/m.exec(changelog);
  if (!match) return null;
  const start = match.index;
  const rest = changelog.slice(start + match[0].length);
  const next = /^## \[/m.exec(rest);
  const bodyEnd = next ? start + match[0].length + next.index : changelog.length;
  const body = changelog.slice(start + match[0].length, bodyEnd).trimEnd();
  const replaced = `## [${version}] - ${date}\n${body ? `\n${body}\n` : ""}`;
  const tail = changelog.slice(bodyEnd);
  return `${changelog.slice(0, start)}${replaced}${tail ? `\n${tail.replace(/^\n+/, "")}` : ""}`;
}

/** Insert a generated section after the header, before older releases. */
export function prependChangelog(existing, section) {
  const text = existing.trim().length > 0 ? existing : CHANGELOG_HEADER;
  const marker = "All notable changes to this package are documented in this file.";
  const index = text.indexOf(marker);
  if (index === -1) return `${CHANGELOG_HEADER}\n${section}\n${text}`;
  const after = index + marker.length;
  return `${text.slice(0, after)}\n\n${section}\n${text.slice(after).replace(/^\n+/, "")}`;
}

/** Rewrite only the manifest's version field, preserving formatting. */
/** Paths in a `git status --porcelain` result, without the XY letters. */
export function changedPaths(status) {
  return String(status ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => line.slice(3).trim().replace(/^"|"$/g, ""));
}

/** True when the only dirty files are the two files a release writes before committing. */
export function onlyReleaseFilesChanged(status) {
  const paths = changedPaths(status);
  return paths.length > 0 && paths.every((file) => RELEASE_FILE_PATHS.includes(file));
}

export function writeVersionText(source, version) {
  const field = /^(\s*"version":\s*)"[^"]*"/m;
  if (!field.test(source)) throw new Error("could not find the version field");
  return source.replace(field, `$1"${version}"`);
}
