import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  NPM_ROOT_GITIGNORE,
  NPM_ROOT_PACKAGE_NAME,
  npmRootPaths,
} from "../../src/main/packages/npm-root";
import {
  parsePackageSource as parseMainSource,
  samePackage as mainSamePackage,
} from "../../src/main/packages/spec";
import {
  normalizePackageSource,
  parsePackageSource as parseSharedSource,
} from "../../src/shared/packages";

/**
 * Package parity (plan step 14).
 *
 * The Office bootstrap (`src/main/packages/*`) and the SDK package manager must
 * not diverge: they share the same `settings.json#packages` entries and the same
 * `~/.pi/agent/npm` / `<cwd>/.pi/npm` layout. This test compares the two
 * implementations directly, and then installs through the *real* SDK manager with
 * a fake npm to prove the on-disk root and manifest are the ones the app's own
 * helper describes.
 */

let root: string;
let agentDir: string;
let projectDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-desktop-parity-"));
  agentDir = join(root, "agent");
  projectDir = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("source normalisation parity", () => {
  const npmInputs = [
    "lodash",
    "@dieulc/pi-office-bridge",
    "@dieulc/workflow@0.3.2",
    "npm:@dieulc/workflow",
    "npm:@dieulc/workflow@^0.3.0",
    "npm:lodash@4.17.21",
  ];

  it("writes the same settings entry for every npm form", () => {
    for (const input of npmInputs) {
      expect(normalizePackageSource(input)).toBe(parseMainSource(input).source);
      expect(parseSharedSource(input).source).toBe(parseMainSource(input).source);
    }
  });

  it("agrees on which sources refer to the same package", () => {
    // Both parsers expose the same dedupe identity for the npm forms the app
    // writes; `src/main/packages/spec.ts` is the Office bootstrap's copy.
    for (const input of npmInputs) {
      expect(parseSharedSource(input).identity).toBe(parseMainSource(input).identity);
    }
    expect(mainSamePackage("@dieulc/workflow", "npm:@dieulc/workflow@0.3.2")).toBe(true);
    expect(mainSamePackage("npm:foo", "npm:bar")).toBe(false);
  });

  it("never mistakes a bare npm name for a local path", () => {
    // The SDK treats a bare string as a path, which is why the app normalises it.
    expect(normalizePackageSource("@dieulc/pi-office-bridge")).toBe("npm:@dieulc/pi-office-bridge");
    expect(parseMainSource("@dieulc/pi-office-bridge").kind).toBe("npm");
  });
});

describe("npm-root layout parity", () => {
  it("the app's helper points at the same root the SDK installs into", async () => {
    const manager = new DefaultPackageManager({
      cwd: projectDir,
      agentDir,
      settingsManager: SettingsManager.create(projectDir, agentDir, { projectTrusted: true }),
    });

    // `getInstalledPath` only answers for a package that exists, so create the
    // folder the app's helper describes and let the SDK find it there.
    const userPaths = npmRootPaths({ agentDir, cwd: projectDir, scope: "user" });
    const userInstalled = join(userPaths.nodeModulesPath, "@dieulc/pi-office-bridge");
    await mkdir(userInstalled, { recursive: true });
    expect(manager.getInstalledPath("npm:@dieulc/pi-office-bridge", "user")).toBe(userInstalled);

    const projectPaths = npmRootPaths({ agentDir, cwd: projectDir, scope: "project" });
    const projectInstalled = join(projectPaths.nodeModulesPath, "@dieulc/pi-office-bridge");
    await mkdir(projectInstalled, { recursive: true });
    expect(manager.getInstalledPath("npm:@dieulc/pi-office-bridge", "project")).toBe(
      projectInstalled,
    );
    expect(projectPaths.root).toBe(join(projectDir, ".pi", "npm"));
  });

  it("a real SDK install creates the manifest and gitignore the app expects", async () => {
    const fakeNpm = join(root, "fake-npm.js");
    await writeFile(fakeNpm, "process.exit(0);\n", "utf8");

    const settings = SettingsManager.create(projectDir, agentDir);
    // The same runtime override shape the host applies, without the capture shim.
    settings.applyOverrides({ npmCommand: [process.execPath, fakeNpm] });
    const manager = new DefaultPackageManager({
      cwd: projectDir,
      agentDir,
      settingsManager: settings,
    });

    const source = normalizePackageSource("@dieulc/pi-office-bridge");
    await manager.installAndPersist(source);

    const paths = npmRootPaths({ agentDir, cwd: projectDir, scope: "user" });
    const manifest = JSON.parse(await readFile(paths.packageJsonPath, "utf8")) as {
      name?: string;
      private?: boolean;
    };
    expect(manifest.name).toBe(NPM_ROOT_PACKAGE_NAME);
    expect(manifest.private).toBe(true);
    expect(await readFile(paths.gitignorePath, "utf8")).toBe(NPM_ROOT_GITIGNORE);

    // The settings entry is exactly the normalised source both parsers produce.
    const written = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as {
      packages?: string[];
    };
    expect(written.packages).toEqual([source]);
    expect(written.packages?.[0]).toBe(parseMainSource(source).source);
  });
});
