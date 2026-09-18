import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { createMemoryFsPort } from "../../src/main/fs-port";
import {
  NPM_ROOT_GITIGNORE,
  NpmRootManifestError,
  buildNpmRootPackageJson,
  ensureNpmRoot,
  npmRootPaths,
  syncNpmRootManifest,
} from "../../src/main/packages/npm-root";

const AGENT_DIR = path.join("C:", "agent");
const CWD = path.join("C:", "work", "proj");

describe("npmRootPaths", () => {
  it("uses the Pi user npm root under the agent dir", () => {
    const paths = npmRootPaths({ agentDir: AGENT_DIR, cwd: CWD, scope: "user" });
    expect(paths.root).toBe(path.join(AGENT_DIR, "npm"));
    expect(paths.packageJsonPath).toBe(path.join(AGENT_DIR, "npm", "package.json"));
    expect(paths.nodeModulesPath).toBe(path.join(AGENT_DIR, "npm", "node_modules"));
    expect(paths.gitignorePath).toBe(path.join(AGENT_DIR, "npm", ".gitignore"));
  });

  it("uses the project npm root for project scope", () => {
    expect(npmRootPaths({ agentDir: AGENT_DIR, cwd: CWD, scope: "project" }).root).toBe(
      path.join(CWD, ".pi", "npm"),
    );
  });
});

describe("buildNpmRootPackageJson", () => {
  it("mirrors Pi's generated manifest shape", () => {
    expect(buildNpmRootPackageJson(["npm:pi-lens@4.2.1", "npm:@dieulc/pi-office-bridge@^0.4.1"])).toEqual({
      name: "pi-extensions",
      private: true,
      dependencies: { "pi-lens": "4.2.1", "@dieulc/pi-office-bridge": "^0.4.1" },
    });
  });

  it("uses latest for unpinned npm packages and skips non-npm sources", () => {
    expect(buildNpmRootPackageJson(["npm:pi-lens", "git:github.com/u/r@v1", "/local/ext"])).toEqual({
      name: "pi-extensions",
      private: true,
      dependencies: { "pi-lens": "latest" },
    });
  });
});

describe("ensureNpmRoot", () => {
  it("creates the root, the .gitignore and reports creation once", async () => {
    const fs = createMemoryFsPort();
    const paths = npmRootPaths({ agentDir: AGENT_DIR, cwd: CWD, scope: "user" });

    expect(await ensureNpmRoot(fs, paths)).toEqual({ created: true });
    expect(await fs.pathKind(paths.root)).toBe("directory");
    expect(await fs.readTextFile(paths.gitignorePath)).toBe(NPM_ROOT_GITIGNORE);

    // A pre-existing .gitignore is not overwritten.
    await fs.writeTextFile(paths.gitignorePath, "custom\n");
    expect(await ensureNpmRoot(fs, paths)).toEqual({ created: false });
    expect(await fs.readTextFile(paths.gitignorePath)).toBe("custom\n");
  });
});

describe("syncNpmRootManifest", () => {
  it("writes the manifest on first sync", async () => {
    const fs = createMemoryFsPort();
    const paths = npmRootPaths({ agentDir: AGENT_DIR, cwd: CWD, scope: "user" });
    const result = await syncNpmRootManifest(fs, paths, ["npm:@dieulc/pi-office-bridge@^0.4.1"]);
    expect(result.changed).toBe(true);
    const written = JSON.parse((await fs.readTextFile(paths.packageJsonPath)) ?? "{}") as {
      dependencies: Record<string, string>;
    };
    expect(written.dependencies["@dieulc/pi-office-bridge"]).toBe("^0.4.1");
  });

  it("merges with the existing manifest and preserves unrelated keys", async () => {
    const paths = npmRootPaths({ agentDir: AGENT_DIR, cwd: CWD, scope: "user" });
    const existing = {
      name: "pi-extensions",
      private: true,
      dependencies: { "pi-lens": "^4.2.1" },
      devDependencies: { typescript: "5.5" },
    };
    const fs = createMemoryFsPort({
      files: { [paths.packageJsonPath]: `${JSON.stringify(existing, null, 2)}\n` },
    });

    const result = await syncNpmRootManifest(fs, paths, [
      "npm:pi-lens@^4.2.1",
      "npm:@dieulc/pi-office-bridge@^0.4.1",
    ]);
    expect(result.changed).toBe(true);
    const written = JSON.parse((await fs.readTextFile(paths.packageJsonPath)) ?? "{}") as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(written.dependencies).toEqual({
      "pi-lens": "^4.2.1",
      "@dieulc/pi-office-bridge": "^0.4.1",
    });
    expect(written.devDependencies).toEqual({ typescript: "5.5" });
  });

  it("reports no change when the manifest already matches", async () => {
    const fs = createMemoryFsPort();
    const paths = npmRootPaths({ agentDir: AGENT_DIR, cwd: CWD, scope: "user" });
    await syncNpmRootManifest(fs, paths, ["npm:@dieulc/pi-office-bridge@^0.4.1"]);
    const second = await syncNpmRootManifest(fs, paths, ["npm:@dieulc/pi-office-bridge@^0.4.1"]);
    expect(second.changed).toBe(false);
  });

  it("refuses to clobber a corrupt manifest", async () => {
    const paths = npmRootPaths({ agentDir: AGENT_DIR, cwd: CWD, scope: "user" });
    const fs = createMemoryFsPort({ files: { [paths.packageJsonPath]: "{ broken" } });
    await expect(syncNpmRootManifest(fs, paths, ["npm:pi-lens"])).rejects.toBeInstanceOf(
      NpmRootManifestError,
    );
    expect(await fs.readTextFile(paths.packageJsonPath)).toBe("{ broken");
  });
});
