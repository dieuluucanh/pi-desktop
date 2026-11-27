import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  applyNpmOverride,
  createNpmLatestVersionReader,
  createSdkPackagePort,
  npmOverrideCommand,
  NPM_CAPTURE_CLI_ENV,
  NPM_CAPTURE_LOG_ENV,
  NPM_CAPTURE_SHIM,
  parseNpmVersionOutput,
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
    checkForAvailableUpdates: async () => [],
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

describe("createSdkPackagePort update checks", () => {
  it("maps Pi's updates, normalises the source and drops what it cannot route", async () => {
    const fake = fakeManager({
      checkForAvailableUpdates: async () => [
        { source: "foo", displayName: "foo", type: "npm", scope: "user" },
        {
          source: "git:github.com/owner/repo",
          displayName: "owner/repo",
          type: "git",
          scope: "project",
        },
        { source: "npm:../../evil", displayName: "evil", type: "npm", scope: "user" },
        { source: "./local-extension", displayName: "local", type: "npm", scope: "user" },
      ],
    });
    const port = fakePort(fake);

    expect(await port.checkUpdates(null)).toEqual({
      offline: false,
      updates: [
        { source: "npm:foo", name: "foo", kind: "npm", scope: "user", latestVersion: null },
        {
          source: "git:github.com/owner/repo",
          name: "owner/repo",
          kind: "git",
          scope: "project",
          latestVersion: null,
        },
      ],
    });
  });

  it("falls back to the parsed name when Pi reports no display name", async () => {
    const fake = fakeManager({
      checkForAvailableUpdates: async () => [
        { source: "@scope/name", displayName: "", type: "npm", scope: "user" },
      ],
    });
    expect((await fakePort(fake).checkUpdates(null)).updates[0]).toMatchObject({
      source: "npm:@scope/name",
      name: "@scope/name",
    });
  });

  it("checks the project's own context", async () => {
    const fake = fakeManager();
    let seenCwd: string | null = null;
    const port = createSdkPackagePort({
      agentDir,
      defaultCwd: projectDir,
      npmCommand: null,
      createSettingsManager: () => SettingsManager.inMemory(),
      createManager: (options) => {
        seenCwd = options.cwd;
        return fake.manager;
      },
    });
    await port.checkUpdates(projectDir);
    expect(seenCwd).toBe(projectDir);
  });

  it("reports offline before asking the manager", async () => {
    const previous = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = "1";
    let asked = false;
    try {
      const fake = fakeManager({
        checkForAvailableUpdates: async () => {
          asked = true;
          return [];
        },
      });
      expect(await fakePort(fake).checkUpdates(null)).toEqual({ updates: [], offline: true });
      expect(asked).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = previous;
    }
  });

  it("classifies a sweep failure with a hint", async () => {
    const fake = fakeManager({
      checkForAvailableUpdates: async () => {
        throw new Error("npm ERR! code ENOTFOUND");
      },
    });
    await expect(fakePort(fake).checkUpdates(null)).rejects.toMatchObject({
      code: "offline",
      message: expect.stringContaining("Hint:"),
    });
  });
});

describe("the display-version enrichment", () => {
  function portWith(
    fake: FakeManager,
    readLatestVersion: (name: string) => Promise<string | null>,
  ) {
    return createSdkPackagePort({
      agentDir,
      defaultCwd: projectDir,
      npmCommand: null,
      createSettingsManager: () => SettingsManager.inMemory(),
      createManager: () => fake.manager,
      readVersion: async () => null,
      readLatestVersion,
    });
  }

  const sources = [
    {
      source: "npm:floating",
      displayName: "floating",
      type: "npm" as const,
      scope: "user" as const,
    },
    {
      source: "npm:pinned@1.2.3",
      displayName: "pinned",
      type: "npm" as const,
      scope: "user" as const,
    },
    {
      source: "npm:ranged@^1.2.0",
      displayName: "ranged",
      type: "npm" as const,
      scope: "user" as const,
    },
    {
      source: "git:github.com/owner/repo",
      displayName: "owner/repo",
      type: "git" as const,
      scope: "user" as const,
    },
  ];

  it("names the target only for a floating npm source", async () => {
    const fake = fakeManager({ checkForAvailableUpdates: async () => sources });
    const asked: string[] = [];
    const port = portWith(fake, async (name) => {
      asked.push(name);
      return "9.9.9";
    });

    const result = await port.checkUpdates(null);
    expect(asked).toEqual(["floating"]);
    expect(result.updates.map((entry) => [entry.name, entry.latestVersion])).toEqual([
      ["floating", "9.9.9"],
      ["pinned", null],
      ["ranged", null],
      ["owner/repo", null],
    ]);
  });

  it("keeps the entry, without a number, when the lookup fails", async () => {
    const fake = fakeManager({
      checkForAvailableUpdates: async () => [sources[0]!],
    });
    const port = portWith(fake, async () => {
      throw new Error("npm ERR! code E404");
    });
    expect((await port.checkUpdates(null)).updates).toEqual([
      expect.objectContaining({ name: "floating", latestVersion: null }),
    ]);
  });

  it("does nothing when no reader can be built (no bundled npm)", async () => {
    const fake = fakeManager({ checkForAvailableUpdates: async () => [sources[0]!] });
    expect((await fakePort(fake).checkUpdates(null)).updates[0]?.latestVersion).toBeNull();
  });

  it("parses npm's string, array and garbage answers", () => {
    expect(parseNpmVersionOutput('"1.2.3"')).toBe("1.2.3");
    expect(parseNpmVersionOutput('["1.2.3","1.10.0","1.9.9"]')).toBe("1.10.0");
    expect(parseNpmVersionOutput("[]")).toBeNull();
    expect(parseNpmVersionOutput("null")).toBeNull();
    expect(parseNpmVersionOutput("not json")).toBeNull();
    expect(parseNpmVersionOutput('"  "')).toBeNull();
  });

  it("builds a reader only from a complete npm command", () => {
    expect(createNpmLatestVersionReader(null)).toBeNull();
    expect(createNpmLatestVersionReader([])).toBeNull();
    expect(createNpmLatestVersionReader(["/runtime/node"])).toBeNull();
    expect(createNpmLatestVersionReader(["/runtime/node", "/runtime/npm-cli.js"])).toBeTypeOf(
      "function",
    );
  });

  it("runs the configured npm CLI and reports its answer", async () => {
    const fakeCli = join(root, "fake-version-cli.js");
    await writeFile(fakeCli, 'process.stdout.write(JSON.stringify("2.5.0"));', "utf8");
    const read = createNpmLatestVersionReader([process.execPath, fakeCli]);
    expect(await read?.("anything")).toBe("2.5.0");
  });

  it("answers null when the CLI fails", async () => {
    const fakeCli = join(root, "failing-version-cli.js");
    await writeFile(fakeCli, "process.exit(7);", "utf8");
    const read = createNpmLatestVersionReader([process.execPath, fakeCli]);
    expect(await read?.("anything")).toBeNull();
  });
});
