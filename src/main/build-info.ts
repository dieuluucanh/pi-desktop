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
}

export function readBuildInfo(input: ReadBuildInfoInput): BuildInfo {
  if (!input.isPackaged) return devBuildInfo();
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
