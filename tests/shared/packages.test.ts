import { describe, expect, it } from "vitest";
import {
  isPackageConsent,
  isPackageScope,
  isPackageSourceKind,
  normalizePackageSource,
  PackageSourceError,
  parsePackageSource,
  pinnedPackageSource,
  sanitizePackageProgress,
  sanitizePackagesSnapshot,
  sanitizePackageSummary,
  sanitizePackageSummaries,
  tryParsePackageSource,
  unpinnedPackageSource,
  type PackageSummary,
} from "../../src/shared/packages";

/**
 * The pure package-source model (plan step 14). The one rule that matters:
 * a bare name must become `npm:` before the SDK sees it, because the SDK treats
 * a bare string as a local path — and the settings entry must be the normalised
 * form so terminal Pi resolves the same thing.
 */

describe("normalizePackageSource", () => {
  it("turns bare names (scoped or not) into npm sources", () => {
    expect(normalizePackageSource("lodash")).toBe("npm:lodash");
    expect(normalizePackageSource("@dieulc/workflow")).toBe("npm:@dieulc/workflow");
    expect(normalizePackageSource("  @dieulc/workflow  ")).toBe("npm:@dieulc/workflow");
    expect(normalizePackageSource("@dieulc/workflow@0.3.2")).toBe("npm:@dieulc/workflow@0.3.2");
  });

  it("keeps already-qualified sources verbatim", () => {
    for (const source of [
      "npm:@dieulc/pi-office-bridge",
      "npm:foo@1.2.3",
      "git:https://github.com/owner/repo.git#main",
      "git@github.com:owner/repo.git",
      "ssh://git@example.com/owner/repo.git",
      "https://github.com/owner/repo",
      "https://gitlab.com/group/sub/repo",
      "https://example.com/thing.git",
      "C:/work/local-package",
      "/home/me/local-package",
      "~/packages/local",
      "./relative-package",
      "../sibling-package",
      "\\\\server\\share\\pkg",
    ]) {
      expect(normalizePackageSource(source)).toBe(source);
    }
  });

  it("refuses empty and whitespace-bearing sources", () => {
    expect(() => normalizePackageSource("   ")).toThrow(PackageSourceError);
    expect(() => normalizePackageSource("foo bar")).toThrow(/whitespace/);
  });
});

describe("parsePackageSource", () => {
  it("parses a scoped npm version and marks an exact version as pinned", () => {
    const exact = parsePackageSource("npm:@dieulc/workflow@0.3.2");
    expect(exact).toMatchObject({
      kind: "npm",
      name: "@dieulc/workflow",
      version: "0.3.2",
      identity: "npm:@dieulc/workflow",
      pinned: true,
    });
    const range = parsePackageSource("npm:@dieulc/workflow@^0.3.0");
    expect(range.version).toBe("^0.3.0");
    expect(range.pinned).toBe(false);
    const floating = parsePackageSource("@dieulc/workflow");
    expect(floating.source).toBe("npm:@dieulc/workflow");
    expect(floating.version).toBeNull();
    expect(floating.pinned).toBe(false);
  });

  it("keeps the version inside the name for an unscoped package", () => {
    expect(parsePackageSource("npm:lodash@4.17.21")).toMatchObject({
      name: "lodash",
      version: "4.17.21",
      pinned: true,
    });
  });

  it("parses hosted Git URLs and pins an explicit ref", () => {
    const pinned = parsePackageSource("https://github.com/owner/repo.git#v1.2.0");
    expect(pinned).toMatchObject({ kind: "git", name: "repo", version: "v1.2.0", pinned: true });
    expect(pinned.identity).toBe("git:github.com/owner/repo");

    const floating = parsePackageSource("git@github.com:owner/repo.git");
    expect(floating).toMatchObject({ kind: "git", name: "repo", version: null, pinned: false });

    const scp = parsePackageSource("ssh://git@example.com/owner/repo.git");
    expect(scp.kind).toBe("git");
    expect(scp.name).toBe("repo");
  });

  it("parses a local path and uses the last segment as its name", () => {
    expect(parsePackageSource("./packages/my-ext")).toMatchObject({
      kind: "path",
      name: "my-ext",
      version: null,
      pinned: false,
    });
  });

  it("tryParse returns null instead of throwing", () => {
    expect(tryParsePackageSource("")).toBeNull();
    expect(tryParsePackageSource("a b")).toBeNull();
    expect(tryParsePackageSource("npm:")).toBeNull();
    expect(tryParsePackageSource("lodash")?.name).toBe("lodash");
  });
});

describe("guards", () => {
  it("recognises scopes and kinds", () => {
    expect(isPackageScope("user")).toBe(true);
    expect(isPackageScope("project")).toBe(true);
    expect(isPackageScope("temporary")).toBe(false);
    expect(isPackageSourceKind("npm")).toBe(true);
    expect(isPackageSourceKind("gem")).toBe(false);
  });

  it("accepts only a consent with the system-access acknowledgement", () => {
    expect(isPackageConsent({ source: "npm:foo", systemAccess: true })).toBe(true);
    expect(isPackageConsent({ source: "npm:foo" })).toBe(false);
    expect(isPackageConsent({ systemAccess: true })).toBe(false);
    expect(isPackageConsent(null)).toBe(false);
  });

  it("derives the pinned and floating npm sources, and nothing for git/path", () => {
    const base: PackageSummary = {
      source: "npm:foo",
      name: "foo",
      kind: "npm",
      scope: "user",
      filtered: false,
      version: null,
      pinned: false,
      installedPath: null,
      installed: false,
    };
    expect(pinnedPackageSource({ ...base, version: "1.2.3" })).toBe("npm:foo@1.2.3");
    expect(pinnedPackageSource(base)).toBeNull();
    expect(unpinnedPackageSource(base)).toBe("npm:foo");
    expect(pinnedPackageSource({ ...base, kind: "git" })).toBeNull();
    expect(unpinnedPackageSource({ ...base, kind: "path" })).toBeNull();
  });
});

describe("sanitizing host payloads", () => {
  it("normalises a summary and defaults the untrusted fields", () => {
    const summary = sanitizePackageSummary({ source: "@dieulc/workflow" });
    expect(summary).toMatchObject({
      source: "npm:@dieulc/workflow",
      name: "@dieulc/workflow",
      kind: "npm",
      scope: "user",
      filtered: false,
      installed: false,
    });
    expect(sanitizePackageSummary({ source: "" })).toBeNull();
    expect(sanitizePackageSummary({ source: "a b" })).toBeNull();
    expect(sanitizePackageSummary("nonsense")).toBeNull();
  });

  it("drops unusable entries and keeps the loaded timestamp", () => {
    const snapshot = sanitizePackagesSnapshot({
      packages: [{ source: "npm:ok" }, { source: "" }, 7],
      loadedAt: 1234,
    });
    expect(snapshot.packages).toHaveLength(1);
    expect(snapshot.loadedAt).toBe(1234);
    expect(sanitizePackagesSnapshot(null)).toEqual({ packages: [], loadedAt: 0 });
    expect(sanitizePackageSummaries("nope")).toEqual([]);
  });

  it("accepts only well-formed progress frames", () => {
    expect(
      sanitizePackageProgress({
        operationId: "op-1",
        action: "install",
        phase: "progress",
        source: "npm:foo",
      }),
    ).toEqual({
      operationId: "op-1",
      action: "install",
      phase: "progress",
      source: "npm:foo",
      percent: null,
    });
    expect(
      sanitizePackageProgress({ operationId: "op-1", action: "dance", phase: "start" }),
    ).toBeNull();
    expect(sanitizePackageProgress({ action: "install", phase: "start" })).toBeNull();
  });
});
