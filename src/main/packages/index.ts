/** Package management surface (steps 2, 15). */

export {
  DEFAULT_INSTALL_TIMEOUT_MS,
  MAX_LOG_CHARS,
  createNpmPackageInstaller,
  tailLog,
  type InstallResult,
  type NpmPackageInstallerOptions,
  type PackageInstaller,
} from "./installer";
export {
  NPM_ROOT_GITIGNORE,
  NPM_ROOT_PACKAGE_NAME,
  NpmRootManifestError,
  buildNpmRootPackageJson,
  ensureNpmRoot,
  npmRootPaths,
  serializeNpmRootPackageJson,
  syncNpmRootManifest,
  type NpmRootPackageJson,
  type NpmRootPaths,
} from "./npm-root";
export {
  SettingsParseError,
  addPackageToSettings,
  backupFile,
  hasPackageSource,
  readPackageEntries,
  readSettingsDocument,
  removePackageFromSettings,
  removePackageSource,
  serializeSettingsDocument,
  upsertPackageSource,
  writeSettingsDocument,
  type AddPackageResult,
  type PackageEntry,
  type SettingsDocument,
  type UpsertOutcome,
} from "./settings";
export {
  PackageSourceError,
  parsePackageSource,
  samePackage,
  tryParsePackageSource,
  withPinnedVersion,
  type PackageSourceKind,
  type ParsedPackageSource,
} from "./spec";
