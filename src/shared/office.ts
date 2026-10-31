/**
 * Shared Pi for Office constants and host descriptors.
 *
 * These values mirror the pi-for-office repo (packages/add-in/manifest.prod.xml
 * and packages/protocol). Keep them in one place: detection, sideloading and the
 * bridge installer all key off them.
 */

export type OfficeHost = "excel" | "word" | "powerpoint";

export const OFFICE_HOSTS: readonly OfficeHost[] = ["excel", "word", "powerpoint"] as const;

export interface OfficeHostDescriptor {
  host: OfficeHost;
  /** Human readable host name used in the UI. */
  label: string;
  /** Windows executable (Office 2016+ Click-to-Run layout). */
  winExe: string;
  /** macOS application bundle name. */
  macApp: string;
  /** macOS container used for sideloading the task pane add-in. */
  macContainer: string;
  /** Office.js requirement note shown in diagnostics. */
  requirementNote: string;
}

export const OFFICE_HOST_DESCRIPTORS: readonly OfficeHostDescriptor[] = [
  {
    host: "excel",
    label: "Excel",
    winExe: "EXCEL.EXE",
    macApp: "Microsoft Excel.app",
    macContainer: "com.microsoft.Excel",
    requirementNote: "ExcelApi 1.x (workbook read/write)",
  },
  {
    host: "word",
    label: "Word",
    winExe: "WINWORD.EXE",
    macApp: "Microsoft Word.app",
    macContainer: "com.microsoft.Word",
    requirementNote: "WordApi 1.x (document read/write)",
  },
  {
    host: "powerpoint",
    label: "PowerPoint",
    winExe: "POWERPNT.EXE",
    macApp: "Microsoft PowerPoint.app",
    macContainer: "com.microsoft.PowerPoint",
    requirementNote: "PowerPointApi 1.x (slide read/write)",
  },
] as const;

/**
 * The Pi for Office add-in identity.
 *
 * `addInId` is the <Id> of packages/add-in/manifest.prod.xml. Sideload detection
 * matches on this id (not on the file name) so a renamed manifest is still found.
 */
export const PI_FOR_OFFICE = {
  addInId: "BC61CAF2-821A-47FD-9D6A-9D96C8F852FE",
  displayName: "Pi for Office",
  providerName: "Pi for Office",
  /** Task pane SPA served from GitHub Pages. */
  sourceLocation: "https://dieuluucanh.github.io/pi-for-office/src/taskpane.html",
  /** Hosts accepted as "the Pi for Office add-in" when an id match is impossible. */
  sourceHosts: ["dieuluucanh.github.io", "localhost", "127.0.0.1"] as readonly string[],
  docsUrl: "https://github.com/dieuluucanh/pi-for-office",
  officeOnTheWebUrl: "https://www.office.com/",
} as const;

/** The bridge extension that owns port 38617 and exposes the office_* tools. */
export const PI_OFFICE_BRIDGE = {
  packageName: "@dieulc/pi-office-bridge",
  /** Pinned version range the app installs and tests against. */
  pinnedVersion: "^0.6.0",
  /** The first bridge that stays off until `/office connect`. */
  manualLifecycleVersion: "0.6.0",
  /** Last known protocol/catalog versions of the bridge (diagnostics only). */
  knownProtocolVersion: 3,
  knownCatalogVersion: 3,
  defaultPort: 38617,
  flag: "office-bridge-port",
  envPort: "PI_OFFICE_BRIDGE_PORT",
  healthPath: "/health",
} as const;

/** Office data-registry versions probed on Windows. */
export const OFFICE_REGISTRY_VERSIONS: readonly string[] = ["16.0", "15.0"] as const;

function versionParts(version: string | null | undefined): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec((version ?? "").trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every((part) => Number.isFinite(part))) return null;
  return [major, minor, patch];
}

/**
 * True when the bridge supports the on-demand lifecycle (0.6+).
 *
 * Used as a defensive fallback when `/health` omits the `manual-lifecycle`
 * capability; a bridge that advertises the capability wins even if its version
 * string is unusual. Prereleases sort with their numeric core, which is what we
 * want here (0.6.0-rc.1 already behaves as 0.6).
 */
export function bridgeSupportsManualLifecycle(version: string | null | undefined): boolean {
  const parts = versionParts(version);
  if (!parts) return false;
  const [major, minor] = parts;
  return major > 0 || (major === 0 && minor >= 6);
}

export function officeHostLabel(host: OfficeHost): string {
  return OFFICE_HOST_DESCRIPTORS.find((d) => d.host === host)?.label ?? host;
}

export function officeHostDescriptor(host: OfficeHost): OfficeHostDescriptor {
  const found = OFFICE_HOST_DESCRIPTORS.find((d) => d.host === host);
  if (!found) throw new Error(`Unknown Office host: ${host}`);
  return found;
}
