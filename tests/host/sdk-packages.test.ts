import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  applyNpmOverride,
  createSdkPackagePort,
  npmOverrideCommand,
  NPM_CAPTURE_CLI_ENV,
  NPM_CAPTURE_LOG_ENV,
  NPM_CAPTURE_SHIM,
  tailNpmOutput,
  type PackageManagerLike,
  type PackageManagerProgress,
} from "../../src/host/sdk/packages";
import { PackageError } from "../../src/host/packages";
import type { PackageSummary } from "../../src/shared/packages";

/**
 * The real `PackagePort` over Pi's package manager (plan step 14).
 *
 * The plan's explicit test lives here: applying the bundled npm as a runtime
 * override must not write `npmCommand` into the shared profile when the manager
 * flushes. The rest pins the mapping (scope → `local`), the progress frames and
 * the failure decoration.
 */

let root: string;
let agentDir: string;
let projectDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-desktop-packages-"));
  agentDir = join(root, "agent");
  projectDir = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const globalPath = (): string => join(agentDir, "settings.json");

async function readGlobal(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(globalPath(), "utf8")) as Record<string, unknown>;
}

describe("the bundled-npm runtime override", () => {
  it("is visible to the manager but never persisted by flush", async () => {
    await writeFile(globalPath(), JSON.stringify({ theme: "dark" }, null, 2), "utf8");
    const manager = SettingsManager.create(projectDir, agentDir);

    applyNpmOverride(manager, ["/runtime/node", "/runtime/npm-cli.js"]);
    expect(manager.getNpmCommand()).toEqual(["/runtime/node", "/runtime/npm-cli.js"]);

    await manager.flush();
    const written = await readGlobal();
    expect(written.theme).toBe("dark");
    expect(written).not.toHaveProperty("npmCommand");
  });

  it("wraps the runtime npm in the capture shim and refuses an incomplete command", () => {
    const wrapped = npmOverrideCommand(["/runtime/node", "/runtime/npm-cli.js"]);
    expect(wrapped?.[0]).toBe("/runtime/node");
    expect(wrapped?.[1]).toBe("-e");
    expect(wrapped?.[2]).toBe(NPM_CAPTURE_SHIM);
    expect(npmOverrideCommand(["/runtime/node"])).toBeNull();
    expect(npmOverrideCommand(null)).toBeNull();
  });
});

describe("createSdkPackagePort over the real package manager", () => {
  it("lists configured packages with scope, pin state and installed version", async () => {
    await writeFile(
      globalPath(),
      JSON.stringify({
        packages: ["npm:foo", "npm:@scope/bar@1.2.3"],
      }),
      "utf8",
    );
    // A package that is "installed" on disk, so the version reader is exercised.
    const installedDir = join(agentDir, "npm", "node_modules", "foo");
    await mkdir(installedDir, { recursive: true });
    await writeFile(
      join(installedDir, "package.json"),
      JSON.stringify({ version: "9.9.9" }),
      "utf8",
    );

    const port = createSdkPackagePort({ agentDir, defaultCwd: projectDir });
    const packages = await port.list(null);

    const foo = packages.find((entry) => entry.name === "foo");
    expect(foo).toMatchObject({ scope: "user", pinned: false, installed: true, version: "9.9.9" });
    const bar = packages.find((entry) => entry.name === "@scope/bar");
    expect(bar).toMatchObject({ pinned: true, installed: false, version: null });
  });

  it("reads the project scope from the project's own settings", async () => {
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeFile(
      join(projectDir, ".pi", "settings.json"),
      JSON.stringify({ packages: ["npm:project-pkg"] }),
      "utf8",
    );

    const port = createSdkPackagePort({
      agentDir,
      defaultCwd: projectDir,
      isProjectTrusted: () => true,
    });
    const packages = await port.list(projectDir);
    expect(packages).toEqual([
      expect.objectContaining({ source: "npm:project-pkg", scope: "project" }),
    ]);
  });
});

interface FakeManager {
  manager: PackageManagerLike;
  calls: Array<{ method: string; args: unknown[] }>;
  progress: PackageManagerProgress[];
}

function fakeManager(overrides: Partial<PackageManagerLike> = {}): FakeManager {
  const calls: FakeManager["calls"] = [];
  const progress: PackageManagerProgress[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  const manager: PackageManagerLike = {
    installAndPersist: async (source, options) => record("installAndPersist")(source, options),
    removeAndPersist: async (source, options) => {
      record("removeAndPersist")(source, options);
      return true;
    },
    update: async (source) => record("update")(source),
    listConfiguredPackages: () => [],
    getInstalledPath: () => undefined,
    setProgressCallback: (callback) => {
      // The real manager emits progress while an operation runs; the fake emits a
      // single start frame the moment a callback is installed.
      if (callback) {
        const event: PackageManagerProgress = {
          type: "start",
          action: "install",
          source: "npm:foo",
        };
        progress.push(event);
        callback(event);
      }
    },
    ...overrides,
  };
  return { manager, calls, progress };
}

function fakePort(fake: FakeManager) {
  return createSdkPackagePort({
    agentDir,
    defaultCwd: projectDir,
    npmCommand: null,
    createSettingsManager: () => SettingsManager.inMemory(),
    createManager: () => fake.manager,
    readVersion: async () => null,
  });
}

describe("createSdkPackagePort mapping", () => {
  it("maps user/project scope onto Pi's local flag and reports progress", async () => {
    const fake = fakeManager();
    const port = fakePort(fake);
    const seen: string[] = [];

    await port.install("npm:foo", { cwd: null, scope: "user" }, (event) =>
      seen.push(`${event.action}:${event.phase}`),
    );
    await port.install("npm:foo", { cwd: projectDir, scope: "project" });

    expect(fake.calls).toEqual([
      { method: "installAndPersist", args: ["npm:foo", { local: false }] },
      { method: "installAndPersist", args: ["npm:foo", { local: true }] },
    ]);
    expect(seen).toEqual(["install:start"]);
  });

  it("removes in the requested scope and updates one or all", async () => {
    const fake = fakeManager();
    const port = fakePort(fake);

    await port.remove("npm:foo", { cwd: projectDir, scope: "project" });
    await port.update("npm:foo", { cwd: null, scope: "user" });
    await port.update(null, { cwd: null, scope: "user" });

    expect(fake.calls).toEqual([
      { method: "removeAndPersist", args: ["npm:foo", { local: true }] },
      { method: "update", args: ["npm:foo"] },
      { method: "update", args: [undefined] },
    ]);
  });

  it("decorates a failure with a classified code and hint", async () => {
    const fake = fakeManager({
      installAndPersist: async () => {
        throw new Error("npm ERR! code ENOTFOUND");
      },
    });
    const port = fakePort(fake);
    await expect(port.install("npm:foo", { cwd: null, scope: "user" })).rejects.toMatchObject({
      code: "offline",
      message: expect.stringContaining("Hint:"),
    });
  });

  it("treats an untrusted project's packages as not installed instead of throwing", async () => {
    const fake = fakeManager({
      listConfiguredPackages: () => [{ source: "npm:foo", scope: "project", filtered: false }],
      getInstalledPath: () => {
        throw new Error("Project is not trusted");
      },
    });
    const port = fakePort(fake);
    const packages = (await port.list(projectDir)) as PackageSummary[];
    expect(packages).toEqual([
      expect.objectContaining({ source: "npm:foo", installed: false, installedPath: null }),
    ]);
  });

  it("keeps the last characters of a long npm output", () => {
    const output = tailNpmOutput("a".repeat(5_000), 100);
    expect(output.startsWith("…(truncated)")).toBe(true);
    expect(output.length).toBeLessThan(150);
    expect(tailNpmOutput("short")).toBe("short");
  });
});

describe("the npm capture shim", () => {
  it("routes installs to stderr, queries to stdout, and tees both to the log", async () => {
    const fakeCli = join(root, "fake-npm.js");
    await writeFile(
      fakeCli,
      [
        "const command = process.argv[2];",
        'if (command === "view") { process.stdout.write("\\"1.2.3\\""); }',
        'else { process.stdout.write("added 1 package"); process.stderr.write("npm warn deprecated"); }',
        "process.exit(0);",
      ].join("\n"),
      "utf8",
    );
    const logPath = join(root, "npm.log");
    const env = {
      ...process.env,
      [NPM_CAPTURE_CLI_ENV]: fakeCli,
      [NPM_CAPTURE_LOG_ENV]: logPath,
    };

    const install = spawnSync(process.execPath, ["-e", NPM_CAPTURE_SHIM, "install", "foo"], {
      env,
      encoding: "utf8",
    });
    expect(install.status).toBe(0);
    expect(install.stdout).toBe("");
    expect(install.stderr).toContain("added 1 package");
    expect(install.stderr).toContain("npm warn deprecated");

    const view = spawnSync(process.execPath, ["-e", NPM_CAPTURE_SHIM, "view", "foo", "version"], {
      env,
      encoding: "utf8",
    });
    expect(view.stdout).toBe('"1.2.3"');

    const log = await readFile(logPath, "utf8");
    expect(log).toContain("added 1 package");
    expect(log).toContain("npm warn deprecated");
    expect(log).toContain('"1.2.3"');
  });

  it("fails readably when the runtime npm is not configured", () => {
    const env = { ...process.env };
    delete env[NPM_CAPTURE_CLI_ENV];
    const result = spawnSync(process.execPath, ["-e", NPM_CAPTURE_SHIM, "install"], {
      env,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("bundled npm CLI is not configured");
  });
});

describe("package failure decoration", () => {
  it("keeps a PackageError's own code", async () => {
    const fake = fakeManager({
      installAndPersist: async () => {
        throw new PackageError("refused", "consent_required");
      },
    });
    const port = fakePort(fake);
    await expect(port.install("npm:foo", { cwd: null, scope: "user" })).rejects.toMatchObject({
      code: "consent_required",
    });
    expect(vi.isMockFunction(port.install)).toBe(false);
  });
});
