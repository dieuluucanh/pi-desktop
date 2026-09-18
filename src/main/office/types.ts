/**
 * Detection result types shared by the setup wizard, the troubleshooting panel
 * and the diagnostics bundle.
 */

import type { OfficeHost } from "../../shared/office";

export type OfficeOs = "windows" | "macos" | "linux";

export type InstallEvidence = "click-to-run" | "install-root" | "filesystem" | "app-bundle";

export interface OfficeAppInfo {
  host: OfficeHost;
  label: string;
  installed: boolean;
  /** Bundle directory (macOS) or executable path (Windows). */
  executablePath?: string;
  evidence?: InstallEvidence;
}

export type SideloadChannel = "registry" | "wef-folder";

export interface SideloadEntry {
  channel: SideloadChannel;
  /** Registry key path or directory that holds the entry. */
  location: string;
  /** Registry value name (registry channel only). */
  slot?: string;
  manifestPath: string;
  manifestExists: boolean;
  manifestId: string | null;
  manifestDisplayName: string | null;
  manifestSourceLocations: string[];
  hosts: string[];
  /** True when this entry is the Pi for Office add-in. */
  matchesPiForOffice: boolean;
  /** True when its task-pane source points at the Pi for Office hosting origin. */
  matchesProdSource: boolean;
}

export interface OfficeSideloadState {
  installed: boolean;
  entries: SideloadEntry[];
  /** Every registry key and directory probed (diagnostics). */
  searched: string[];
  /** Non-fatal problems worth showing in troubleshooting. */
  problems: string[];
}

export interface DetectedOfficeInstall {
  version: string | null;
  platform: string | null;
  products: string[];
  /** Registry key or heuristic that produced the info. */
  source: string | null;
}

export interface OfficeDetectionResult {
  os: OfficeOs;
  /** False on platforms with no desktop Office (Linux). */
  supported: boolean;
  isWsl: boolean;
  apps: OfficeAppInfo[];
  anyAppInstalled: boolean;
  office: DetectedOfficeInstall;
  sideload: OfficeSideloadState;
  officeOnTheWeb: { url: string; recommended: boolean };
  notes: string[];
  checkedAt: string;
}
