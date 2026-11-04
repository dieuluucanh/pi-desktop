import { describe, expect, it } from "vitest";

import {
  bumpVersion,
  changedPaths,
  changelogSection,
  classifyRegistryState,
  classifyStatus,
  documentsVersion,
  finalizeUnreleased,
  onlyReleaseFilesChanged,
  parseConventionalSubject,
  parseReleaseArgs,
  prependChangelog,
  readManifest,
  tagFor,
  validateManifest,
  validateTarballFiles,
  writeVersionText,
  CHANGELOG_HEADER,
  PACKAGE_DIR,
  PACKAGE_NAME,
} from "../../scripts/extension-package.mjs";

/**
 * Pure package/release helpers. These run without git, npm or network access;
 * the observable release path is additionally covered by
 * `extension-release.test.ts` and the package gate itself.
 */

describe("package identity", () => {
  it("accepts the real manifest", () => {
    expect(validateManifest(readManifest())).toEqual([]);
  });

  it("rejects the old private/dist identity", () => {
    const errors = validateManifest({
      name: PACKAGE_NAME,
      version: "0.1.1",
      private: true,
      type: "module",
      license: "MIT",
      keywords: ["pi-package"],
      repository: { url: "git+https://github.com/dieuluucanh/pi-workflow.git" },
      pi: { extensions: ["./index.mjs"] },
      files: ["index.mjs"],
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        "package must not be private",
        expect.stringContaining("repository.url"),
        expect.stringContaining("files[]"),
      ]),
    );
  });

  it("recognises the package directory", () => {
    expect(PACKAGE_DIR.replace(/\\/g, "/")).toMatch(/\/packages\/checkpoints$/);
  });
});

describe("version and tag helpers", () => {
  it("bumps every kind and keeps none", () => {
    expect(bumpVersion("0.1.1", "none")).toBe("0.1.1");
    expect(bumpVersion("0.1.1", "patch")).toBe("0.1.2");
    expect(bumpVersion("0.1.1", "minor")).toBe("0.2.0");
    expect(bumpVersion("0.1.1", "major")).toBe("1.0.0");
  });

  it("rejects an invalid version", () => {
    expect(() => bumpVersion("not-a-version", "patch")).toThrow(/semver/);
  });

  it("uses the npm package name in tags", () => {
    expect(tagFor("0.1.2")).toBe("@dieulc/checkpoints@0.1.2");
  });

  it("recognises an interrupted release's two dirty files", () => {
    const status = " M packages/checkpoints/package.json\n M packages/checkpoints/CHANGELOG.md\n";
    expect(changedPaths(status)).toEqual([
      "packages/checkpoints/package.json",
      "packages/checkpoints/CHANGELOG.md",
    ]);
    expect(onlyReleaseFilesChanged(status)).toBe(true);
    expect(onlyReleaseFilesChanged(" M src/extensions/pi-checkpoints.ts\n")).toBe(false);
    expect(onlyReleaseFilesChanged("")).toBe(false);
  });

  it("rewrites only the manifest version field", () => {
    const source = '{\n  "name": "@dieulc/checkpoints",\n  "version": "0.1.1"\n}\n';
    expect(writeVersionText(source, "0.1.2")).toContain('"version": "0.1.2"');
    expect(writeVersionText(source, "0.1.2")).toContain('"name": "@dieulc/checkpoints"');
  });
});

describe("registry decisions", () => {
  it("publishes an absent version", () => {
    expect(classifyRegistryState({ kind: "patch", nextVersion: "0.1.2", state: "absent" })).toEqual(
      { status: "publish", reason: "not on npm", tagEligible: true },
    );
  });

  it("skips an already-published patch without treating it as clean", () => {
    expect(
      classifyRegistryState({ kind: "patch", nextVersion: "0.1.2", state: "published" }),
    ).toMatchObject({ status: "skip", tagEligible: false });
  });

  it("skips a published no-bump but keeps the tag eligible", () => {
    expect(
      classifyRegistryState({ kind: "none", nextVersion: "0.1.1", state: "published" }),
    ).toMatchObject({ status: "skip", tagEligible: true });
  });

  it("never publishes on an unknown registry state", () => {
    expect(
      classifyRegistryState({ kind: "patch", nextVersion: "0.1.2", state: "unknown" }),
    ).toMatchObject({ status: "blocked", tagEligible: false });
  });

  it("classifies local status", () => {
    expect(classifyStatus("0.1.1", "0.1.1")).toBe("in-sync");
    expect(classifyStatus("0.1.2", "0.1.1")).toBe("local-ahead");
    expect(classifyStatus("0.1.0", "0.1.1")).toBe("local-behind");
    expect(classifyStatus("0.1.1", null)).toBe("never-published");
  });
});

describe("changelog helpers", () => {
  it("parses conventional subjects", () => {
    expect(parseConventionalSubject("feat(checkpoints): rename the command")).toEqual({
      type: "feat",
      scope: "checkpoints",
      breaking: false,
      description: "rename the command",
    });
    expect(parseConventionalSubject("nonsense")).toMatchObject({ type: "other" });
  });

  it("groups a section by conventional type", () => {
    const section = changelogSection(
      "0.1.2",
      ["feat(checkpoints): rename the command", "fix(checkpoints): keep the safety snapshot"],
      "2026-10-31",
    );
    expect(section).toContain("## [0.1.2] - 2026-10-31");
    expect(section).toContain("### Features");
    expect(section).toContain("**checkpoints:** rename the command");
    expect(section).toContain("### Fixes");
  });

  it("finalizes Unreleased in place and keeps older sections", () => {
    const existing = `${CHANGELOG_HEADER}\n## [Unreleased]\n\n### Changed\n\n- moved\n\n## [0.1.1] - 2026-10-31\n\n### Fixes\n\n- old\n`;
    const finalized = finalizeUnreleased(existing, "0.1.2", "2026-10-31");
    expect(finalized).toContain("## [0.1.2] - 2026-10-31");
    expect(finalized).not.toContain("## [Unreleased]");
    expect(finalized).toContain("- moved");
    expect(finalized).toContain("## [0.1.1] - 2026-10-31");
    expect(documentsVersion(finalized ?? "", "0.1.2")).toBe(true);
  });

  it("prepends a generated section after the header", () => {
    const existing = `${CHANGELOG_HEADER}\n## [0.1.1] - 2026-10-31\n`;
    const result = prependChangelog(existing, "## [0.1.2] - 2026-10-31\n\n- new\n");
    expect(result.indexOf("## [0.1.2]")).toBeLessThan(result.indexOf("## [0.1.1]"));
  });
});

describe("release arguments", () => {
  it("defaults to main and the dieulc npm user", () => {
    expect(parseReleaseArgs([])).toMatchObject({
      branch: "main",
      npmUser: "dieulc",
      bump: null,
      dryRun: false,
    });
  });

  it("parses every release flag", () => {
    expect(
      parseReleaseArgs([
        "--status",
        "--check",
        "--dry-run",
        "--bump",
        "patch",
        "--yes",
        "--no-push",
        "--continue",
        "--branch",
        "dev",
        "--npm-user",
        "someone",
      ]),
    ).toMatchObject({
      status: true,
      check: true,
      dryRun: true,
      bump: "patch",
      yes: true,
      noPush: true,
      continueMode: true,
      branch: "dev",
      npmUser: "someone",
    });
  });

  it("rejects unknown arguments and invalid bumps", () => {
    expect(() => parseReleaseArgs(["--nope"])).toThrow(/unknown argument/);
    expect(() => parseReleaseArgs(["--bump", "huge"])).toThrow(/--bump/);
  });
});

describe("tarball validation", () => {
  it("accepts the intended files", () => {
    expect(
      validateTarballFiles(["package.json", "index.mjs", "README.md", "LICENSE", "CHANGELOG.md"]),
    ).toEqual([]);
  });

  it("rejects missing and forbidden entries", () => {
    const errors = validateTarballFiles([
      "package.json",
      "index.mjs",
      "tests/checkpoints/extension.test.ts",
      "package-lock.json",
      "node_modules/x/index.js",
    ]);
    expect(errors).toEqual(
      expect.arrayContaining([
        "tarball is missing README.md",
        "tarball is missing LICENSE",
        "tarball is missing CHANGELOG.md",
        "tarball must not contain package-lock.json",
        expect.stringContaining("test files"),
        expect.stringContaining("node_modules"),
      ]),
    );
  });
});
