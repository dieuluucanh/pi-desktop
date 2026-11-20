import { join } from "node:path";
import {
  BUILD_INFO_FILE,
  devBuildInfo,
  parseBuildInfo,
  unknownBuildInfo,
  type BuildInfo,
} from "../shared/build-info";

/**
 * Reads the packaged build's provenance. Electron-free and filesystem-agnostic:
 * the caller injects the reader, so the fallback logic is unit-testable without
 * a packaged app.
 */
export interface ReadBuildInfoInput {
  isPackaged: boolean;
  /** `process.resourcesPath` (the directory `afterPack` wrote the file into). */
  resourcesDir: string;
  readTextFile: (path: string) => string | null;
  /**
   * Development only: the SDK's own `package.json`. A dev run has no packaged
   * provenance, but the bundled agent version is still a fact worth showing.
   */
  devPiPackageJson?: string;
}

export function readBuildInfo(input: ReadBuildInfoInput): BuildInfo {
  if (!input.isPackaged) return devBuildInfo(readDevPiVersion(input));
  let text: string | null;
  try {
    text = input.readTextFile(join(input.resourcesDir, BUILD_INFO_FILE));
  } catch {
    return unknownBuildInfo();
  }
  if (text === null) return unknownBuildInfo();
  try {
    return parseBuildInfo(JSON.parse(text));
  } catch {
    return unknownBuildInfo();
  }
}

/** The dev-run agent version; a missing/unreadable manifest is simply null. */
function readDevPiVersion(input: ReadBuildInfoInput): string | null {
  if (!input.devPiPackageJson) return null;
  try {
    const text = input.readTextFile(input.devPiPackageJson);
    if (text === null) return null;
    const parsed: unknown = JSON.parse(text);
    const version = (parsed as { version?: unknown } | null)?.version;
    return typeof version === "string" && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}
