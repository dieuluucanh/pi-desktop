import { join, normalize } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveRuntime,
  runtimeEnvOverrides,
  type RuntimeEnvironment,
} from "../../src/main/runtime/resolve-runtime";

const APP_ROOT = normalize("C:/repo");
const RESOURCES = normalize("C:/repo/resources");

interface FakeOptions {
  platform?: string;
  arch?: string;
  isPackaged?: boolean;
  env?: Record<string, string | undefined>;
  files?: string[];
  versions?: Record<string, string | null>;
}

function fakeEnv(options: FakeOptions = {}): RuntimeEnvironment {
  const platform = options.platform ?? "win32";
  const files = new Set((options.files ?? []).map(normalize));
  const versions = options.versions ?? {};

  return {
    platform,
    arch: options.arch ?? "x64",
    isPackaged: options.isPackaged ?? false,
    resourcesPath: RESOURCES,
    appRoot: APP_ROOT,
    env: options.env ?? {},
    exists: (target) => files.has(normalize(target)),
    probeVersion: (nodePath) => versions[normalize(nodePath)] ?? null,
    fallbackNodes: [],
  };
}

const NODE_DIR = join(RESOURCES, "runtime", "node", "win32-x64");
const NODE = join(NODE_DIR, "node.exe");
const NPM_CLI = join(NODE_DIR, "node_modules", "npm", "bin", "npm-cli.js");
const NODE_V24 = "v24.21.0\n";

describe("resolveRuntime — bundled runtime", () => {
  it("prefers the bundled runtime and wires npm to the bundled CLI", () => {
    const resolution = resolveRuntime(
      fakeEnv({ files: [NODE, NPM_CLI], versions: { [normalize(NODE)]: NODE_V24 } }),
    );

    expect(resolution.ok).toBe(true);
    expect(resolution.source).toBe("bundled");
    expect(resolution.nodePath).toBe(NODE);
    expect(resolution.nodeVersion).toBe("24.21.0");
    expect(resolution.npmCliPath).toBe(NPM_CLI);
    expect(resolution.npmCommand).toEqual([NODE, NPM_CLI]);
    expect(resolution.target).toBe("win32-x64");
    expect(resolution.runtimeDir).toBe(join(RESOURCES, "runtime"));
    expect(resolution.binDir).toBe(join(RESOURCES, "runtime", "bin"));
    expect(resolution.nodeBinDir).toBe(NODE_DIR);
    expect(resolution.piHostPath).toBe(join(APP_ROOT, "out", "host", "index.mjs"));
    expect(resolution.hint).toBeNull();
    expect(resolution.problems).toEqual([]);
  });

  it("falls back to the npm on PATH when the bundled CLI is missing", () => {
    const resolution = resolveRuntime(
      fakeEnv({ files: [NODE], versions: { [normalize(NODE)]: NODE_V24 } }),
    );

    expect(resolution.ok).toBe(true);
    expect(resolution.npmCliPath).toBeNull();
    expect(resolution.npmCommand).toEqual(["npm"]);
    expect(resolution.problems.join(" ")).toContain("no npm CLI");
  });

  it("resolves production paths from the resources directory", () => {
    const resolution = resolveRuntime(
      fakeEnv({
        isPackaged: true,
        files: [NODE, NPM_CLI],
        versions: { [normalize(NODE)]: NODE_V24 },
      }),
    );

    expect(resolution.runtimeDir).toBe(join(RESOURCES, "runtime"));
    expect(resolution.piHostPath).toBe(
      join(RESOURCES, "app.asar.unpacked", "out", "host", "index.mjs"),
    );
  });

  it("uses linux distribution paths when the target is linux", () => {
    const node = join(RESOURCES, "runtime", "node", "linux-x64", "bin", "node");
    const npmCli = join(
      RESOURCES,
      "runtime",
      "node",
      "linux-x64",
      "lib",
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    const resolution = resolveRuntime(
      fakeEnv({
        platform: "linux",
        files: [node, npmCli],
        versions: { [normalize(node)]: NODE_V24 },
      }),
    );

    expect(resolution.ok).toBe(true);
    expect(resolution.npmCommand).toEqual([node, npmCli]);
    expect(resolution.nodeBinDir).toBe(join(RESOURCES, "runtime", "node", "linux-x64", "bin"));
  });
});

describe("resolveRuntime — overrides", () => {
  it("lets PI_DESKTOP_RUNTIME_DIR relocate the runtime", () => {
    const dir = normalize("D:/runtime");
    const node = join(dir, "node", "win32-x64", "node.exe");
    const resolution = resolveRuntime(
      fakeEnv({
        env: { PI_DESKTOP_RUNTIME_DIR: dir },
        files: [node],
        versions: { [normalize(node)]: NODE_V24 },
      }),
    );

    expect(resolution.runtimeDir).toBe(dir);
    expect(resolution.source).toBe("bundled");
  });

  it("lets PI_DESKTOP_NODE win over the bundled runtime", () => {
    const custom = normalize("C:/tools/node/node.exe");
    const resolution = resolveRuntime(
      fakeEnv({
        env: { PI_DESKTOP_NODE: custom, PI_DESKTOP_NPM_CLI: normalize("C:/tools/node/npm-cli.js") },
        files: [NODE, NPM_CLI, custom],
        versions: { [normalize(custom)]: "v23.0.0\n" },
      }),
    );

    expect(resolution.source).toBe("override");
    expect(resolution.nodePath).toBe(custom);
    expect(resolution.nodeBinDir).toBe(normalize("C:/tools/node"));
    expect(resolution.npmCommand).toEqual([custom, normalize("C:/tools/node/npm-cli.js")]);
  });

  it("lets PI_DESKTOP_HOST_ENTRY relocate the host bundle", () => {
    const entry = normalize("D:/build/host.mjs");
    const resolution = resolveRuntime(fakeEnv({ env: { PI_DESKTOP_HOST_ENTRY: entry } }));

    expect(resolution.piHostPath).toBe(entry);
  });
});

describe("resolveRuntime — system fallback and failure", () => {
  it("falls back to a system node that passes the gate, with a problem noted", () => {
    const env = fakeEnv();
    const withFallback: RuntimeEnvironment = {
      ...env,
      fallbackNodes: ["node"],
      probeVersion: (nodePath) => (nodePath === "node" ? "v24.21.0\n" : null),
    };

    const resolution = resolveRuntime(withFallback);

    expect(resolution.ok).toBe(true);
    expect(resolution.source).toBe("system");
    expect(resolution.nodeBinDir).toBeNull();
    expect(resolution.npmCommand).toEqual(["npm"]);
    expect(resolution.problems.join(" ")).toContain("no bundled runtime");
    expect(resolution.problems.join(" ")).toContain("system Node");
  });

  it("skips a system node that is below the engine gate", () => {
    const withFallback: RuntimeEnvironment = {
      ...fakeEnv(),
      fallbackNodes: ["node"],
      probeVersion: () => "v22.18.0\n",
    };

    const resolution = resolveRuntime(withFallback);

    expect(resolution.ok).toBe(false);
    expect(resolution.nodePath).toBeNull();
    expect(resolution.nodeBinDir).toBeNull();
    expect(resolution.npmCommand).toBeNull();
    expect(resolution.problems.join(" ")).toContain("below the required 22.19.0");
    expect(resolution.hint).toContain("npm run runtime:fetch");
  });

  it("falls through a too-old bundled runtime to a working system node", () => {
    const calls: string[] = [];
    const resolution = resolveRuntime({
      ...fakeEnv({ files: [NODE, NPM_CLI] }),
      fallbackNodes: ["node"],
      probeVersion: (nodePath) => {
        calls.push(nodePath);
        return nodePath === NODE ? "v22.10.0\n" : "v24.21.0\n";
      },
    });

    expect(calls).toEqual([NODE, "node"]);
    expect(resolution.ok).toBe(true);
    expect(resolution.source).toBe("system");
    expect(resolution.problems.join(" ")).toContain("Node 22.10.0");
  });

  it("ignores a candidate that cannot run", () => {
    const resolution = resolveRuntime({
      ...fakeEnv({ files: [NODE, NPM_CLI] }),
      probeVersion: () => null,
    });

    expect(resolution.ok).toBe(false);
    expect(resolution.problems.join(" ")).toContain("could not run");
    expect(resolution.hint).toContain("runtime:fetch");
  });

  it("reports an explicit override path that does not exist", () => {
    const resolution = resolveRuntime(
      fakeEnv({ env: { PI_DESKTOP_NODE: normalize("C:/nope/node.exe") } }),
    );

    expect(resolution.ok).toBe(false);
    expect(resolution.problems.join(" ")).toContain("does not exist");
  });
});

describe("runtimeEnvOverrides", () => {
  it("puts the shim directory first on PATH and pins node and the host entry", () => {
    const resolution = resolveRuntime(
      fakeEnv({ files: [NODE, NPM_CLI], versions: { [normalize(NODE)]: NODE_V24 } }),
    );

    const overrides = runtimeEnvOverrides(resolution, {
      basePath: "C:\\Windows\\System32",
      platform: "win32",
    });

    expect(overrides.PI_DESKTOP_NODE).toBe(NODE);
    expect(overrides.PI_DESKTOP_HOST_ENTRY).toBe(resolution.piHostPath);
    expect(overrides.PATH).toBe(`${resolution.binDir};${NODE_DIR};C:\\Windows\\System32`);
  });

  it("omits PI_DESKTOP_NODE when no runtime resolved", () => {
    const resolution = resolveRuntime(fakeEnv({}));
    const overrides = runtimeEnvOverrides(resolution, { basePath: "", platform: "linux" });

    expect(overrides.PI_DESKTOP_NODE).toBeUndefined();
    expect(overrides.PATH).toBe(resolution.binDir);
  });
});
