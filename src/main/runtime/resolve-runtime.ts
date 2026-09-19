import { isAbsolute, join } from "node:path";
import {
  MINIMUM_NODE_VERSION,
  meetsMinimumNodeVersion,
  nodeBinaryRelativePath,
  npmCliRelativePath,
  parseNodeVersion,
  prependToPath,
  runtimeTarget,
  type RuntimeSource,
} from "./layout";

/**
 * Resolves the runtime the app uses to spawn Pi hosts and to run npm installs
 * (plan D3): the bundled Node 24 when present, an explicit override, or — in
 * development only — a system Node that satisfies the engine gate.
 *
 * Everything the module needs is injected, so it has no `electron` import
 * (AGENTS rule 1) and is fully unit testable.
 */

export interface RuntimeEnvironment {
  platform: string;
  arch: string;
  isPackaged: boolean;
  /** Electron `process.resourcesPath` (production). */
  resourcesPath: string;
  /** Repository root in development. */
  appRoot: string;
  env: Record<string, string | undefined>;
  exists(target: string): boolean;
  /** Runs `<node> --version`; returns its stdout, or null when it cannot run. */
  probeVersion(nodePath: string): string | null;
  /** Extra node binaries to try, in order (absolute paths or PATH names). */
  fallbackNodes?: readonly string[];
}

export interface RuntimeResolution {
  ok: boolean;
  source: RuntimeSource | null;
  target: string;
  runtimeDir: string;
  binDir: string;
  nodeDir: string;
  nodePath: string | null;
  nodeVersion: string | null;
  npmCliPath: string | null;
  /** Ready for `SettingsManager.applyOverrides({ npmCommand })` (plan D20). */
  npmCommand: string[] | null;
  /** The `out/host/index.mjs` bundle the shims and the supervisor execute. */
  piHostPath: string;
  problems: string[];
  hint: string | null;
}

interface Candidate {
  source: RuntimeSource;
  nodePath: string;
  npmCliPath: string | null;
  npmCommand: string[];
}

export const NPM_COMMAND_ONLY = ["npm"] as const;

function resolveRuntimeDir(env: RuntimeEnvironment): string {
  const override = env.env.PI_DESKTOP_RUNTIME_DIR?.trim();
  if (override) return override;
  return env.isPackaged
    ? join(env.resourcesPath, "runtime")
    : join(env.appRoot, "resources", "runtime");
}

function resolveHostEntry(env: RuntimeEnvironment): string {
  const override = env.env.PI_DESKTOP_HOST_ENTRY?.trim();
  if (override) return override;
  return env.isPackaged
    ? join(env.resourcesPath, "app.asar.unpacked", "out", "host", "index.mjs")
    : join(env.appRoot, "out", "host", "index.mjs");
}

function buildCandidates(
  env: RuntimeEnvironment,
  nodeDir: string,
  problems: string[],
): Candidate[] {
  const candidates: Candidate[] = [];

  const overrideNode = env.env.PI_DESKTOP_NODE?.trim();
  const overrideNpmCli = env.env.PI_DESKTOP_NPM_CLI?.trim();
  if (overrideNode) {
    candidates.push({
      source: "override",
      nodePath: overrideNode,
      npmCliPath: overrideNpmCli ?? null,
      npmCommand: overrideNpmCli ? [overrideNode, overrideNpmCli] : [...NPM_COMMAND_ONLY],
    });
  }

  const bundledNode = join(nodeDir, nodeBinaryRelativePath(env.platform));
  if (env.exists(bundledNode)) {
    const bundledNpmCli = join(nodeDir, npmCliRelativePath(env.platform));
    if (env.exists(bundledNpmCli)) {
      candidates.push({
        source: "bundled",
        nodePath: bundledNode,
        npmCliPath: bundledNpmCli,
        npmCommand: [bundledNode, bundledNpmCli],
      });
    } else {
      problems.push(`the bundled runtime has no npm CLI at ${bundledNpmCli}`);
      candidates.push({
        source: "bundled",
        nodePath: bundledNode,
        npmCliPath: null,
        npmCommand: [...NPM_COMMAND_ONLY],
      });
    }
  } else {
    problems.push(`no bundled runtime at ${bundledNode}`);
  }

  for (const fallback of env.fallbackNodes ?? []) {
    if (fallback && fallback !== bundledNode) {
      candidates.push({
        source: "system",
        nodePath: fallback,
        npmCliPath: null,
        npmCommand: [...NPM_COMMAND_ONLY],
      });
    }
  }

  return candidates;
}

export function resolveRuntime(env: RuntimeEnvironment): RuntimeResolution {
  const target = runtimeTarget(env.platform, env.arch);
  const runtimeDir = resolveRuntimeDir(env);
  const binDir = join(runtimeDir, "bin");
  const nodeDir = join(runtimeDir, "node", target);
  const piHostPath = resolveHostEntry(env);
  const problems: string[] = [];

  let selected: Candidate | null = null;
  let selectedVersion: string | null = null;

  for (const candidate of buildCandidates(env, nodeDir, problems)) {
    if (isAbsolute(candidate.nodePath) && !env.exists(candidate.nodePath)) {
      problems.push(`${candidate.nodePath} does not exist`);
      continue;
    }
    const version = parseNodeVersion(env.probeVersion(candidate.nodePath));
    if (!version) {
      problems.push(`could not run ${candidate.nodePath} --version`);
      continue;
    }
    if (!meetsMinimumNodeVersion(version)) {
      problems.push(
        `${candidate.nodePath} is Node ${version}, below the required ${MINIMUM_NODE_VERSION}`,
      );
      continue;
    }
    selected = candidate;
    selectedVersion = version;
    break;
  }

  if (!selected) {
    return {
      ok: false,
      source: null,
      target,
      runtimeDir,
      binDir,
      nodeDir,
      nodePath: null,
      nodeVersion: null,
      npmCliPath: null,
      npmCommand: null,
      piHostPath,
      problems,
      hint: "Run `npm run runtime:fetch` to install the bundled Node runtime (add --force to repair an existing one).",
    };
  }

  if (selected.source === "system") {
    problems.push(
      `using a system Node (${selected.nodePath}) for development; packaged builds always use the bundled runtime`,
    );
  }
  if (selected.source === "bundled" && selected.npmCliPath === null) {
    problems.push(
      "npm installs will fall back to the npm on PATH because the bundled npm CLI is missing",
    );
  }

  return {
    ok: true,
    source: selected.source,
    target,
    runtimeDir,
    binDir,
    nodeDir,
    nodePath: selected.nodePath,
    nodeVersion: selectedVersion,
    npmCliPath: selected.npmCliPath,
    npmCommand: selected.npmCommand,
    piHostPath,
    problems,
    hint: null,
  };
}

export interface RuntimeEnvOverridesInput {
  basePath: string;
  platform: string;
}

/**
 * Environment overrides for spawning a host process: the shim directory first on
 * PATH (so extensions shelling out to `pi` hit our runtime), and the exact node
 * and host entry so shims never have to guess (plan D16, risk R4).
 */
export function runtimeEnvOverrides(
  resolution: RuntimeResolution,
  input: RuntimeEnvOverridesInput,
): Record<string, string> {
  const overrides: Record<string, string> = {
    PI_DESKTOP_HOST_ENTRY: resolution.piHostPath,
    PATH: prependToPath(resolution.binDir, input.basePath, input.platform),
  };
  if (resolution.nodePath) overrides.PI_DESKTOP_NODE = resolution.nodePath;
  return overrides;
}
