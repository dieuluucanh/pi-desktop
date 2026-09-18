import * as path from "node:path";

import { describe, expect, it } from "vitest";

import type { MemoryFsPort } from "../../src/main/fs-port";
import { createMemoryFsPort } from "../../src/main/fs-port";
import {
  bridgePackageDir,
  ensureBridgePackage,
  readBridgePackageState,
} from "../../src/main/office/bridge-install";
import type { InstallResult, PackageInstaller } from "../../src/main/packages/installer";
import { PI_OFFICE_BRIDGE } from "../../src/shared/office";

const AGENT_DIR = path.join("C:", "agent");
const CWD = path.join("C:", "work", "proj");
const SETTINGS = path.join(AGENT_DIR, "settings.json");
const NPM_ROOT = path.join(AGENT_DIR, "npm");
const NPM_ROOT_MANIFEST = path.join(NPM_ROOT, "package.json");
const PKG_DIR = bridgePackageDir(NPM_ROOT, PI_OFFICE_BRIDGE.packageName);
const PKG_JSON = path.join(PKG_DIR, "package.json");
const ENTRY = path.join(PKG_DIR, "src", "index.ts");
const PINNED = "npm:@dieulc/pi-office-bridge@^0.4.1";

interface FakeInstallerOptions {
  ok?: boolean;
  code?: number;
  stdout?: string;
  stderr?: string;
  missingRuntime?: boolean;
  /** Version materialized on success; null installs nothing. */
  installVersion?: string | null;
  extensions?: unknown;
}

function packageJsonText(version: string, extensions: unknown): string {
  return `${JSON.stringify(
    {
      name: PI_OFFICE_BRIDGE.packageName,
      version,
      type: "module",
      pi: { extensions },
    },
    null,
    2,
  )}\n`;
}

function makeInstaller(
  fs: MemoryFsPort,
  options: FakeInstallerOptions = {},
): { installer: PackageInstaller; calls: Array<{ root: string }> } {
  const calls: Array<{ root: string }> = [];
  const installer: PackageInstaller = {
    description: "fake npm (node npm-cli.js install)",
    async installAll(root): Promise<InstallResult> {
      calls.push({ root });
      const ok = options.ok ?? true;
      if (ok) {
        const version = options.installVersion ?? "0.4.1";
        if (version !== null) {
          const extensions = options.extensions ?? ["./src/index.ts"];
          await fs.writeTextFile(path.join(root, "node_modules", "@dieulc", "pi-office-bridge", "package.json"),
            packageJsonText(version, extensions));
          if (Array.isArray(extensions) && extensions.length > 0) {
            await fs.writeTextFile(
              path.join(root, "node_modules", "@dieulc", "pi-office-bridge", "src", "index.ts"),
              "export default function () {}\n",
            );
          }
        }
      }
      return {
        ok,
        code: ok ? 0 : (options.code ?? 1),
        command: "node",
        args: ["npm-cli.js", "install"],
        cwd: root,
        stdout: options.stdout ?? "added 1 package in 2s",
        stderr: options.stderr ?? "",
        missingRuntime: options.missingRuntime ?? false,
        durationMs: 5,
      };
    },
  };
  return { installer, calls };
}

function installedProfile(version: string): MemoryFsPort {
  return createMemoryFsPort({
    files: {
      [SETTINGS]: `${JSON.stringify({ packages: [PINNED] }, null, 2)}\n`,
      [PKG_JSON]: packageJsonText(version, ["./src/index.ts"]),
      [ENTRY]: "export default function () {}\n",
    },
  });
}

describe("readBridgePackageState", () => {
  it("reports a missing package", async () => {
    const fs = createMemoryFsPort();
    const state = await readBridgePackageState(fs, NPM_ROOT, PI_OFFICE_BRIDGE.packageName);
    expect(state.installed).toBe(false);
    expect(state.version).toBeNull();
    expect(state.problems[0]).toContain("is not installed in");
  });

  it("reports a corrupt package manifest", async () => {
    const fs = createMemoryFsPort({ files: { [PKG_JSON]: "{ nope" } });
    const state = await readBridgePackageState(fs, NPM_ROOT, PI_OFFICE_BRIDGE.packageName);
    expect(state.installed).toBe(false);
    expect(state.problems[0]).toContain("not valid JSON");
  });

  it("reports a missing declared entry point", async () => {
    const fs = createMemoryFsPort({
      files: { [PKG_JSON]: packageJsonText("0.4.1", ["./src/index.ts"]) },
    });
    const state = await readBridgePackageState(fs, NPM_ROOT, PI_OFFICE_BRIDGE.packageName);
    expect(state.installed).toBe(false);
    expect(state.problems[0]).toContain("Declared extension entry is missing");
  });

  it("reports a package that does not declare pi.extensions", async () => {
    const fs = createMemoryFsPort({ files: { [PKG_JSON]: packageJsonText("0.4.1", []) } });
    const state = await readBridgePackageState(fs, NPM_ROOT, PI_OFFICE_BRIDGE.packageName);
    expect(state.installed).toBe(false);
    expect(state.problems[0]).toContain("does not declare pi.extensions");
  });

  it("accepts a healthy install and resolves the entry path", async () => {
    const fs = installedProfile("0.4.1");
    const state = await readBridgePackageState(fs, NPM_ROOT, PI_OFFICE_BRIDGE.packageName);
    expect(state).toMatchObject({ installed: true, version: "0.4.1", extensionEntry: ENTRY });
    expect(state.problems).toEqual([]);
  });
});

describe("ensureBridgePackage", () => {
  it("installs the pinned bridge on a fresh profile and verifies it", async () => {
    const fs = createMemoryFsPort();
    const { installer, calls } = makeInstaller(fs);
    const phases: string[] = [];

    const result = await ensureBridgePackage({
      fs,
      installer,
      agentDir: AGENT_DIR,
      cwd: CWD,
      onProgress: (event) => phases.push(event.phase),
    });

    expect(result.status).toBe("installed");
    expect(result.spec).toBe(PINNED);
    expect(result.error).toBeNull();
    expect(result.settingsChanged).toBe(true);
    expect(result.state).toMatchObject({ installed: true, version: "0.4.1", extensionEntry: ENTRY });
    expect(result.steps.map((step) => [step.name, step.ok])).toEqual([
      ["settings", true],
      ["npm-root", true],
      ["install", true],
      ["verify", true],
    ]);
    expect(phases).toEqual(["settings", "install", "verify", "done"]);

    // npm ran inside the Pi npm root.
    expect(calls).toEqual([{ root: NPM_ROOT }]);

    // settings.json is pinned, and unrelated content is preserved.
    const settings = JSON.parse((await fs.readTextFile(SETTINGS)) ?? "{}") as { packages: string[] };
    expect(settings.packages).toEqual([PINNED]);

    // The npm root matches Pi's layout.
    const rootManifest = JSON.parse((await fs.readTextFile(NPM_ROOT_MANIFEST)) ?? "{}") as {
      name: string;
      private: boolean;
      dependencies: Record<string, string>;
    };
    expect(rootManifest).toMatchObject({
      name: "pi-extensions",
      private: true,
      dependencies: { "@dieulc/pi-office-bridge": "^0.4.1" },
    });
    expect(await fs.readTextFile(path.join(NPM_ROOT, ".gitignore"))).toBe("*\n!.gitignore\n");
  });

  it("does nothing when the pinned bridge is already installed", async () => {
    const fs = installedProfile("0.4.1");
    const { installer, calls } = makeInstaller(fs);

    const result = await ensureBridgePackage({ fs, installer, agentDir: AGENT_DIR, cwd: CWD });

    expect(result.status).toBe("already-installed");
    expect(result.settingsChanged).toBe(false);
    expect(calls).toHaveLength(0);
    expect(result.steps.map((step) => step.name)).toEqual(["settings", "install", "verify"]);
  });

  it("pins an unpinned settings entry", async () => {
    const fs = installedProfile("0.4.1");
    await fs.writeTextFile(
      SETTINGS,
      `${JSON.stringify({ packages: ["npm:@dieulc/pi-office-bridge", "npm:pi-lens"] }, null, 2)}\n`,
    );
    const { installer, calls } = makeInstaller(fs);

    const result = await ensureBridgePackage({ fs, installer, agentDir: AGENT_DIR, cwd: CWD });

    expect(result.previousSpec).toBe("npm:@dieulc/pi-office-bridge");
    expect(result.status).toBe("updated");
    expect(calls).toHaveLength(1);
    const settings = JSON.parse((await fs.readTextFile(SETTINGS)) ?? "{}") as { packages: string[] };
    expect(settings.packages).toEqual([PINNED, "npm:pi-lens"]);
  });

  it("reinstalls when the installed version is outside the pinned range", async () => {
    const fs = installedProfile("0.3.0");
    const { installer, calls } = makeInstaller(fs);

    const result = await ensureBridgePackage({ fs, installer, agentDir: AGENT_DIR, cwd: CWD });

    expect(result.status).toBe("updated");
    expect(calls).toHaveLength(1);
    expect(result.state.version).toBe("0.4.1");
  });

  it("fails with the npm output when the install fails", async () => {
    const fs = createMemoryFsPort();
    const { installer } = makeInstaller(fs, {
      ok: false,
      code: 1,
      stderr: "npm ERR! 404 Not Found - GET https://registry.npmjs.org/@dieulc%2fpi-office-bridge",
      installVersion: null,
    });

    const result = await ensureBridgePackage({ fs, installer, agentDir: AGENT_DIR, cwd: CWD });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("404 Not Found");
    expect(result.installLog).toContain("404 Not Found");
    expect(result.steps.at(-1)).toMatchObject({ name: "install", ok: false });
  });

  it("fails when the bundled runtime cannot be launched", async () => {
    const fs = createMemoryFsPort();
    const { installer } = makeInstaller(fs, { ok: false, missingRuntime: true, installVersion: null });

    const result = await ensureBridgePackage({ fs, installer, agentDir: AGENT_DIR, cwd: CWD });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("bundled Node/npm runtime");
  });

  it("fails verification when the install does not declare an extension", async () => {
    const fs = createMemoryFsPort();
    const { installer } = makeInstaller(fs, { extensions: [] });

    const result = await ensureBridgePackage({ fs, installer, agentDir: AGENT_DIR, cwd: CWD });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("pi.extensions");
    expect(result.state.installed).toBe(false);
  });

  it("refuses to modify an invalid settings.json", async () => {
    const broken = "{ nope";
    const fs = createMemoryFsPort({ files: { [SETTINGS]: broken } });
    const { installer, calls } = makeInstaller(fs);

    const result = await ensureBridgePackage({ fs, installer, agentDir: AGENT_DIR, cwd: CWD });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Invalid JSON");
    expect(await fs.readTextFile(SETTINGS)).toBe(broken);
    expect(calls).toHaveLength(0);
  });

  it("backs up settings.json before the first write", async () => {
    const backupDir = path.join(AGENT_DIR, "backups");
    const fs = createMemoryFsPort({
      files: { [SETTINGS]: `${JSON.stringify({ theme: "dark" }, null, 2)}\n` },
    });
    const { installer } = makeInstaller(fs);

    const result = await ensureBridgePackage({
      fs,
      installer,
      agentDir: AGENT_DIR,
      cwd: CWD,
      backupDir,
      now: () => new Date("2026-09-18T10:00:00.000Z"),
    });

    expect(result.status).toBe("installed");
    const backupPath = path.join(backupDir, "settings.json.2026-09-18T10-00-00-000Z.bak");
    expect(await fs.readTextFile(backupPath)).toContain("\"theme\": \"dark\"");
    const settings = JSON.parse((await fs.readTextFile(SETTINGS)) ?? "{}") as Record<string, unknown>;
    expect(settings.theme).toBe("dark");
    expect(settings.packages).toEqual([PINNED]);
  });

  it("writes to the project settings when project scope is used", async () => {
    const fs = createMemoryFsPort();
    const { installer } = makeInstaller(fs);
    const projectSettings = path.join(CWD, ".pi", "settings.json");

    const result = await ensureBridgePackage({
      fs,
      installer,
      agentDir: AGENT_DIR,
      cwd: CWD,
      scope: "project",
    });

    expect(result.settingsPath).toBe(projectSettings);
    expect(result.paths.root).toBe(path.join(CWD, ".pi", "npm"));
    expect(await fs.readTextFile(projectSettings)).toContain(PINNED);
    expect(await fs.readTextFile(SETTINGS)).toBeNull();
  });

  it("keeps working when a custom version range is supplied", async () => {
    const fs = createMemoryFsPort();
    const { installer } = makeInstaller(fs, { installVersion: "0.9.0" });

    const result = await ensureBridgePackage({
      fs,
      installer,
      agentDir: AGENT_DIR,
      cwd: CWD,
      versionRange: ">=0.4.1 <1.0.0",
    });

    expect(result.spec).toBe("npm:@dieulc/pi-office-bridge@>=0.4.1 <1.0.0");
    expect(result.status).toBe("installed");
    const rootManifest = JSON.parse((await fs.readTextFile(NPM_ROOT_MANIFEST)) ?? "{}") as {
      dependencies: Record<string, string>;
    };
    expect(rootManifest.dependencies["@dieulc/pi-office-bridge"]).toBe(">=0.4.1 <1.0.0");
  });
});
