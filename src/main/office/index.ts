/**
 * Pi for Office integration surface (main process).
 *
 * Step 1: environment detection. Steps 2–5 (bridge install, sideloading,
 * verification, troubleshooting) build on these primitives.
 */

export {
  MAX_MANIFEST_BYTES,
  createDefaultDetectDeps,
  detectOfficeEnvironment,
  detectOfficeWith,
  formatDetectionReport,
  isManifestFileName,
  manifestPathFromRegistryValue,
  productsAllowHost,
  toOfficeOs,
  type DetectDeps,
  type DirectoryEntry,
  type PathKind,
} from "./detect";
export {
  createCommandRunner,
  createFakeCommandRunner,
  DEFAULT_COMMAND_TIMEOUT_MS,
  type CommandResult,
  type CommandRunner,
  type FakeCommandSpec,
} from "./exec";
export {
  dedupePaths,
  macOfficeBundleCandidates,
  macWefLocations,
  PRIMARY_OFFICE_REGISTRY_VERSION,
  primaryWindowsWefDirectory,
  windowsDeveloperRegistryKeys,
  windowsExeCandidates,
  windowsWefDirectories,
  type MacWefLocation,
  type WindowsPathContext,
} from "./locations";
export {
  manifestHostsToOfficeHosts,
  manifestMatchesPiForOffice,
  manifestSourceMatchesProd,
  parseManifest,
  sourceLocationMatchesHostedProd,
  sourceLocationMatchesPiForOffice,
  type ParsedManifest,
} from "./manifest";
export {
  REG_EXE,
  addRegistryValue,
  deleteRegistryValue,
  listRegistrySubkeys,
  parseRegQueryOutput,
  queryRegistryKey,
  queryRegistryTree,
  readRegistryValue,
  type RegistryKey,
  type RegistryValue,
} from "./registry";
export type {
  DetectedOfficeInstall,
  InstallEvidence,
  OfficeAppInfo,
  OfficeDetectionResult,
  OfficeOs,
  OfficeSideloadState,
  SideloadChannel,
  SideloadEntry,
} from "./types";
export {
  SIDELOAD_MANIFEST_FILE_NAME,
  SIDELOAD_REGISTRY_VERSIONS,
  createDefaultSideloadDeps,
  planSideload,
  sideloadAddIn,
  sideloadHostSummary,
  unsideloadAddIn,
  type SideloadAction,
  type SideloadCommandRunner,
  type SideloadDeps,
  type SideloadOptions,
  type SideloadPlan,
  type SideloadPlanEntry,
  type SideloadResult,
  type UnsideloadResult,
} from "./sideload";
export {
  bridgeHealthUrl,
  buildSetupChecklist,
  checkBridgeHealth,
  checklistFailed,
  createDefaultVerifyDeps,
  openOfficeHost,
  parseBridgeHealth,
  waitForPane,
  type BridgeHealth,
  type BridgeHealthCheck,
  type BridgePane,
  type ChecklistInput,
  type ChecklistStatus,
  type ChecklistStep,
  type FetchLike,
  type OpenOfficeOptions,
  type OpenOfficeResult,
  type VerifyDeps,
  type WaitForPaneOptions,
  type WaitForPaneResult,
} from "./verify";
