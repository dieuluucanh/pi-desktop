import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildNpmRootPackageJson, npmRootPaths } from "../../src/main/packages/npm-root";
import {
  parsePackageSource as parseBootstrapSource,
  tryParsePackageSource as tryParseBootstrapSource,
} from "../../src/main/packages/spec";
import { parsePackageSource, tryParsePackageSource } from "../../src/shared/packages";

/**
 * Package sources cannot escape the npm root (plan step 23).
 *
 * A dependency key or version that contains a path separator is not a package:
 * npm reads it as a *local path* dependency and installs from there. The
 * generated npm-root `package.json` is the artifact that would carry it, so the
 * parsers on both sides of the host boundary must reject the shape, and the
 * manifest builder must only ever emit a plain npm name/version.
 */

const TRAVERSAL_SOURCES = [
  "npm:../../evil",
  "npm:..",
  "npm:.",
  "npm:/absolute/evil",
  "npm:@scope/..",
  "npm:@scope/name@../../evil",
  "npm:pkg@..",
  "npm:pkg@/abs",
  "npm:pkg@sub/dir",
  "npm:pkg@..\\windows",
];

describe("host package parser", () => {
  it("refuses every traversal-shaped npm source", () => {
    for (const source of TRAVERSAL_SOURCES) {
      expect(() => parsePackageSource(source), source).toThrow();
      expect(tryParsePackageSource(source), source).toBeNull();
    }
  });

  it("still parses legitimate names, scopes, ranges and tags", () => {
    expect(parsePackageSource("npm:lodash@4.17.21")).toMatchObject({
      name: "lodash",
      version: "4.17.21",
      pinned: true,
    });
    expect(parsePackageSource("npm:@dieulc/workflow@^0.3.0")).toMatchObject({
      name: "@dieulc/workflow",
      version: "^0.3.0",
    });
    expect(parsePackageSource("npm:@dieulc/workflow@latest").version).toBe("latest");
  });
});

describe("bootstrap package parser", () => {
  it("refuses every traversal-shaped npm source", () => {
    for (const source of TRAVERSAL_SOURCES) {
      expect(() => parseBootstrapSource(source), source).toThrow();
      expect(tryParseBootstrapSource(source), source).toBeNull();
    }
  });

  it("still parses a legitimate scoped package", () => {
    expect(parseBootstrapSource("npm:@dieulc/pi-office-bridge@^0.5.0")).toMatchObject({
      name: "@dieulc/pi-office-bridge",
      version: "^0.5.0",
    });
  });
});

describe("npm root containment", () => {
  const AGENT_DIR = "C:/Users/test/.pi/agent";
  const CWD = "C:/work/app";

  it("roots user scope under the profile and project scope under the project", () => {
    expect(npmRootPaths({ agentDir: AGENT_DIR, cwd: CWD, scope: "user" }).root).toBe(
      join(AGENT_DIR, "npm"),
    );
    expect(npmRootPaths({ agentDir: AGENT_DIR, cwd: CWD, scope: "project" }).root).toBe(
      join(CWD, ".pi", "npm"),
    );
  });

  it("never emits a dependency key or version that is a path", () => {
    // Even if a bad source slipped through elsewhere, the manifest builder only
    // takes npm sources that its own parser accepted.
    const manifest = buildNpmRootPackageJson([
      "npm:lodash@4.17.21",
      "npm:@dieulc/workflow@^0.3.0",
      ...TRAVERSAL_SOURCES,
    ]);
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@dieulc/workflow", "lodash"]);
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      expect(name, name).not.toMatch(/\.\.[\\/]|[\\/]\.\./);
      expect(version, version).not.toMatch(/\.\.[\\/]|[\\/]\.\./);
      expect(version.startsWith("."), version).toBe(false);
    }
  });
});
