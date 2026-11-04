export const REPO_ROOT: string;
export const PACKAGE_DIR: string;
export const PACKAGE_NAME: string;
export const ENTRY_FILE: string;
export const README_FILE: string;
export const LICENSE_FILE: string;
export const CHANGELOG_FILE: string;
export const REQUIRED_FILES: readonly string[];
export const REPOSITORY_URL: string;
export const REPOSITORY_DIRECTORY: string;
export const HOMEPAGE: string;
export const BUGS_URL: string;
export const PUBLISH_ACCESS: string;
export const MIN_NODE_VERSION: string;
export const TAG_PREFIX: string;
export const DEFAULT_BRANCH: string;
export const DEFAULT_NPM_USER: string;
export const BUMP_KINDS: readonly string[];
export const CHANGELOG_HEADER: string;
export const PACKAGE_PATHS: readonly string[];
export const RELEASE_FILE_PATHS: readonly string[];

export interface PackageManifest {
  name?: string;
  version?: string;
  private?: boolean;
  type?: string;
  license?: string;
  keywords?: string[];
  description?: string;
  repository?: { type?: string; url?: string; directory?: string };
  bugs?: { url?: string };
  homepage?: string;
  pi?: { extensions?: string[] };
  files?: string[];
  publishConfig?: { access?: string };
  engines?: { node?: string };
}

export interface ReleaseArgs {
  status: boolean;
  check: boolean;
  dryRun: boolean;
  bump: "none" | "patch" | "minor" | "major" | null;
  yes: boolean;
  noPush: boolean;
  continueMode: boolean;
  branch: string;
  npmUser: string;
  help: boolean;
}

export function parseReleaseArgs(argv?: string[]): ReleaseArgs;
export function readJson(file: string): unknown;
export function readManifest(dir?: string): PackageManifest;
export function readChangelog(dir?: string): string;
export function isSemver(version: string): boolean;
export function bumpVersion(version: string, kind: "none" | "patch" | "minor" | "major"): string;
export function tagFor(version: string): string;
export function validateManifest(manifest: PackageManifest): string[];
export function validateTarballFiles(files: string[]): string[];
export function classifyRegistryState(input: {
  kind: string;
  nextVersion: string;
  state: "published" | "absent" | "unknown";
}): { status: "publish" | "skip" | "blocked"; reason: string; tagEligible: boolean };
export function classifyStatus(localVersion: string, latestVersion: string | null): string;
export function parseConventionalSubject(subject: string): {
  type: string;
  scope: string;
  breaking: boolean;
  description: string;
};
export function changelogSection(version: string, subjects: string[], date: string): string;
export function documentsVersion(changelog: string, version: string): boolean;
export function finalizeUnreleased(changelog: string, version: string, date: string): string | null;
export function prependChangelog(existing: string, section: string): string;
export function changedPaths(status: string): string[];
export function onlyReleaseFilesChanged(status: string): boolean;
export function writeVersionText(source: string, version: string): string;
