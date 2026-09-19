import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolveRuntime, type RuntimeEnvironment, type RuntimeResolution } from "./resolve-runtime";

/**
 * The Node-bound implementation of {@link RuntimeEnvironment}. Still free of
 * `electron`: the caller passes `process.resourcesPath` and the app root, so
 * this module stays unit testable and host-process safe.
 */

export interface HostEnvironmentInput {
  isPackaged: boolean;
  resourcesPath: string;
  appRoot: string;
  platform?: string;
  arch?: string;
  env?: Record<string, string | undefined>;
}

export function createRuntimeEnvironment(input: HostEnvironmentInput): RuntimeEnvironment {
  const env = input.env ?? process.env;

  // `process.execPath` is Electron in a packaged or dev app, whose --version
  // reports the Electron release, not Node. Only trust it when we are plain Node.
  const fallbacks = process.versions.electron ? ["node"] : [process.execPath, "node"];

  return {
    platform: input.platform ?? process.platform,
    arch: input.arch ?? process.arch,
    isPackaged: input.isPackaged,
    resourcesPath: input.resourcesPath,
    appRoot: input.appRoot,
    env,
    exists: (target) => existsSync(target),
    probeVersion: (nodePath) => {
      const result = spawnSync(nodePath, ["--version"], {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      });
      return result.status === 0 && typeof result.stdout === "string" ? result.stdout : null;
    },
    fallbackNodes: fallbacks,
  };
}

export function resolveAppRuntime(input: HostEnvironmentInput): RuntimeResolution {
  return resolveRuntime(createRuntimeEnvironment(input));
}
